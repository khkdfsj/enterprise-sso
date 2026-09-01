import { randomUUID } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { audit } from '../repositories/audit.js';
import { decryptJson, encryptJson, randomToken, safeEqualHex, sha256 } from '../security/crypto.js';
import { hashPassword } from '../security/password.js';
import { checkApplicationConnectivity } from '../services/application-monitor.js';
import { buildIntegrationPackage, deriveIntegrationUrls } from '../services/integration-package.js';

const router = express.Router();
const json = express.json({ limit: '32kb' });
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{2,159}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{7,159}$/;

function apiError(res, status, error, message, requestId = null) {
  return res.status(status).json({ error, message, request_id: requestId });
}

function requestId(req) {
  const value = String(req.get('x-request-id') ?? '').trim();
  return requestIdPattern.test(value) ? value : null;
}

async function requireAgent(req, res, next) {
  const id = requestId(req);
  if (!id) return apiError(res, 400, 'invalid_request', '必须提供合法的 X-Request-ID。');
  const authorization = String(req.get('authorization') ?? '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const identity = String(req.get('x-esso-agent-identity') ?? '').trim();
  if (!token || !identityPattern.test(identity)) return apiError(res, 401, 'invalid_agent_token', 'Agent 凭据或身份标记缺失。', id);
  const digest = sha256(token);
  const [rows] = await pool.execute(
    `SELECT * FROM agent_api_credentials WHERE token_hash=? AND status='active'
       AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) LIMIT 1`,
    [digest],
  );
  const credential = rows[0];
  if (!credential || !safeEqualHex(digest, credential.token_hash)) return apiError(res, 401, 'invalid_agent_token', 'Agent 凭据无效、已过期或已撤销。', id);
  if (credential.agent_identity !== identity) return apiError(res, 403, 'agent_identity_mismatch', '身份标记与 Agent 凭据不一致。', id);
  req.agent = { credential, identity, requestId: id };
  await pool.execute("UPDATE agent_api_credentials SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [credential.id]);
  return next();
}

function validateProjectRoot(value) {
  let parsed;
  try { parsed = new URL(String(value ?? '').trim()); } catch { throw new Error('项目根地址必须是完整 URL'); }
  if (parsed.username || parsed.password || parsed.hash) throw new Error('项目根地址不能包含账号、密码或锚点');
  const allowedHttp = parsed.protocol === 'http:' && config.internalHttpRedirectHosts.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !allowedHttp && !(config.nodeEnv !== 'production' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
    throw new Error('项目根地址必须使用 HTTPS，或使用已批准的内网 HTTP 主机');
  }
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function validateRegistration(body, identity) {
  if (String(body.agent_identity ?? '') !== identity) throw Object.assign(new Error('请求体身份标记与 Agent 凭据不一致'), { code: 'agent_identity_mismatch', status: 403 });
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 180) throw new Error('服务名称不能为空且不能超过 180 个字符');
  const projectRoot = validateProjectRoot(body.project_root_url);
  const requestedClientId = String(body.client_id ?? '').trim();
  if (requestedClientId && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(requestedClientId)) throw new Error('Client ID 格式不合法');
  const accessMode = body.access_mode ?? 'rules';
  if (!['rules', 'all_active'].includes(accessMode)) throw new Error('access_mode 只允许 rules 或 all_active');
  if (body.provisioning_enabled !== undefined && typeof body.provisioning_enabled !== 'boolean') throw new Error('provisioning_enabled 必须是布尔值');
  return { name, projectRoot, requestedClientId, accessMode, provisioningEnabled: body.provisioning_enabled === true };
}

function links(appId) {
  const base = `${config.issuer}/api/v1/agent/services/${encodeURIComponent(appId)}`;
  return { self: base, package: `${base}/package`, start_monitor: `${base}/monitor`, check_connectivity: `${base}/tests/connectivity` };
}

function testState(app, urls) {
  return {
    connectivity: { status: app.last_check_status === 'success' ? 'passed' : app.last_check_status === 'failure' ? 'failed' : 'pending', checked_at: app.last_check_at, message: app.last_check_message, url: urls.healthUri },
    login: { status: app.auth_test_at ? 'passed' : 'pending', checked_at: app.auth_test_at, url: urls.loginTestUri },
    logout: { status: app.logout_test_at ? 'passed' : 'pending', checked_at: app.logout_test_at, url: urls.logoutTestUri },
  };
}

async function ownedService(req) {
  const [rows] = await pool.execute(
    `SELECT a.*,r.agent_identity FROM applications a
       JOIN agent_service_registrations r ON r.application_id=a.id
      WHERE a.id=? AND r.credential_id=? LIMIT 1`,
    [req.params.id, req.agent.credential.id],
  );
  return rows[0] ?? null;
}

async function issuePackageToken(applicationId, credentialId, connection = pool) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + 15 * 60_000).toISOString();
  await connection.execute('DELETE FROM agent_package_tokens WHERE application_id=? AND credential_id=? AND consumed_at IS NULL', [applicationId, credentialId]);
  await connection.execute(
    'INSERT INTO agent_package_tokens(id,application_id,credential_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)',
    [randomUUID(), applicationId, credentialId, sha256(token), expires, now.toISOString()],
  );
  return { token, expires };
}

async function responseForService(app, packageIssue = null) {
  const urls = deriveIntegrationUrls(app.home_url);
  return {
    service: {
      id: app.id,
      name: app.name,
      client_id: app.client_id,
      project_root_url: urls.projectRoot,
      access_mode: app.access_mode,
      provisioning_enabled: Boolean(app.provisioning_enabled),
      integration_status: app.integration_status,
      created_by_agent: app.agent_identity,
      urls: { callback: urls.redirectUri, logout_return: urls.logoutUri, health: urls.healthUri },
    },
    ...(packageIssue ? { package_token: packageIssue.token, package_token_expires_at: packageIssue.expires } : {}),
    package_name: 'ESSO-DFSJ',
    links: links(app.id),
    tests: testState(app, urls),
  };
}

router.use('/api/v1/agent', limiter, requireAgent);

router.get('/api/v1/agent/capabilities', (req, res) => {
  res.json({
    api_version: 'v1',
    agent_identity: req.agent.identity,
    package_name: 'ESSO-DFSJ',
    package_format: 'zip',
    required_registration_fields: ['agent_identity', 'name', 'project_root_url'],
    optional_registration_fields: ['client_id', 'access_mode', 'provisioning_enabled'],
    access_modes: ['rules', 'all_active'],
    tests: ['connectivity', 'login', 'logout'],
    links: { register_service: `${config.issuer}/api/v1/agent/services` },
  });
});

router.post('/api/v1/agent/services', json, async (req, res, next) => {
  try {
    const values = validateRegistration(req.body ?? {}, req.agent.identity);
    const [prior] = await pool.execute(
      `SELECT a.*,r.agent_identity FROM agent_service_registrations r
       JOIN applications a ON a.id=r.application_id
       WHERE r.credential_id=? AND r.request_id=? LIMIT 1`,
      [req.agent.credential.id, req.agent.requestId],
    );
    if (prior[0]) {
      const verificationLogoutUri = `${config.issuer}/api/v1/integration-tests/${encodeURIComponent(prior[0].id)}/logout`;
      const [clientRows] = await pool.execute("SELECT payload FROM oidc_objects WHERE model='Client' AND id=?", [prior[0].client_id]);
      if (clientRows[0]) {
        const client = decryptJson(JSON.parse(clientRows[0].payload));
        client.post_logout_redirect_uris = [...new Set([...(client.post_logout_redirect_uris ?? []), verificationLogoutUri])];
        await pool.execute("UPDATE oidc_objects SET payload=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE model='Client' AND id=?", [JSON.stringify(encryptJson(client)), prior[0].client_id]);
      }
      const packageIssue = await issuePackageToken(prior[0].id, req.agent.credential.id);
      return res.status(200).json({ request_id: req.agent.requestId, idempotent_replay: true, ...(await responseForService(prior[0], packageIssue)) });
    }
    const id = randomUUID();
    const clientId = values.requestedClientId || `app_${randomToken(9).replaceAll('-', '').replaceAll('_', '')}`;
    const secret = randomToken(48);
    const secretHash = await hashPassword(secret);
    const urls = deriveIntegrationUrls(values.projectRoot);
    const now = new Date().toISOString();
    const oidcPayload = {
      client_id: clientId,
      client_secret: secret,
      client_name: values.name,
      redirect_uris: [urls.redirectUri],
      post_logout_redirect_uris: [urls.logoutUri, `${config.issuer}/api/v1/integration-tests/${encodeURIComponent(id)}/logout`],
      response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_post', id_token_signed_response_alg: 'ES256',
    };
    let packageIssue;
    await withTransaction(async (connection) => {
      const [duplicate] = await connection.execute('SELECT id FROM applications WHERE client_id=?', [clientId]);
      if (duplicate[0]) throw Object.assign(new Error('Client ID 已存在'), { code: 'client_id_exists', status: 409 });
      await connection.execute(
        `INSERT INTO applications(id,client_id,name,client_secret_hash,access_mode,provisioning_enabled,status,home_url,health_check_url,integration_status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'active',?,?,'configuring',?,?)`,
        [id, clientId, values.name, secretHash, values.accessMode, values.provisioningEnabled ? 1 : 0, urls.projectRoot, urls.healthUri, now, now],
      );
      await connection.execute('INSERT INTO application_redirect_uris(application_id,redirect_uri,created_at) VALUES (?,?,?)', [id, urls.redirectUri, now]);
      await connection.execute("INSERT INTO oidc_objects(model,id,payload,created_at,updated_at) VALUES ('Client',?,?,?,?)", [clientId, JSON.stringify(encryptJson(oidcPayload)), now, now]);
      await connection.execute('INSERT INTO agent_service_registrations(application_id,credential_id,agent_identity,request_id,created_at) VALUES (?,?,?,?,?)', [id, req.agent.credential.id, req.agent.identity, req.agent.requestId, now]);
      packageIssue = await issuePackageToken(id, req.agent.credential.id, connection);
    });
    const app = { id, client_id: clientId, name: values.name, access_mode: values.accessMode, provisioning_enabled: values.provisioningEnabled ? 1 : 0, integration_status: 'configuring', home_url: urls.projectRoot, agent_identity: req.agent.identity, last_check_status: null, last_check_at: null, last_check_message: null, auth_test_at: null, logout_test_at: null };
    await audit(req, 'agent_service_register', 'success', { targetType: 'application', targetId: id, detail: { agent_identity: req.agent.identity, client_id: clientId } });
    return res.status(201).json({ request_id: req.agent.requestId, idempotent_replay: false, ...(await responseForService(app, packageIssue)) });
  } catch (error) { return next(error); }
});

router.get('/api/v1/agent/services/:id', async (req, res, next) => {
  try {
    const app = await ownedService(req);
    if (!app) return apiError(res, 404, 'service_not_found', '服务不存在或不属于当前 Agent。', req.agent.requestId);
    return res.json({ request_id: req.agent.requestId, ...(await responseForService(app)) });
  } catch (error) { return next(error); }
});

router.get('/api/v1/agent/services/:id/package', async (req, res, next) => {
  try {
    const app = await ownedService(req);
    if (!app) return apiError(res, 404, 'service_not_found', '服务不存在或不属于当前 Agent。', req.agent.requestId);
    const token = String(req.get('x-esso-package-token') ?? '');
    const digest = sha256(token);
    const [tokens] = await pool.execute(
      `SELECT * FROM agent_package_tokens WHERE application_id=? AND credential_id=? AND token_hash=?
       AND consumed_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1`,
      [app.id, req.agent.credential.id, digest],
    );
    if (!token || !tokens[0] || !safeEqualHex(digest, tokens[0].token_hash)) return apiError(res, 410, 'package_token_expired', '接入包令牌无效、已过期或已使用。', req.agent.requestId);
    const [clientRows] = await pool.execute("SELECT payload FROM oidc_objects WHERE model='Client' AND id=?", [app.client_id]);
    if (!clientRows[0]) throw new Error('OIDC 客户端不存在');
    const client = decryptJson(JSON.parse(clientRows[0].payload));
    const archive = buildIntegrationPackage(app, client.client_secret, deriveIntegrationUrls(app.home_url));
    await pool.execute("UPDATE agent_package_tokens SET consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND consumed_at IS NULL", [tokens[0].id]);
    await audit(req, 'agent_package_download', 'success', { targetType: 'application', targetId: app.id, detail: { agent_identity: req.agent.identity } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="ESSO-DFSJ.zip"');
    return res.send(archive);
  } catch (error) { return next(error); }
});

router.post('/api/v1/agent/services/:id/monitor', async (req, res, next) => {
  try {
    const app = await ownedService(req);
    if (!app) return apiError(res, 404, 'service_not_found', '服务不存在或不属于当前 Agent。', req.agent.requestId);
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    await pool.execute("UPDATE applications SET monitor_until=?,integration_status='testing',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [until, app.id]);
    await audit(req, 'agent_monitor_start', 'success', { targetType: 'application', targetId: app.id, detail: { agent_identity: req.agent.identity, monitor_until: until } });
    return res.json({ request_id: req.agent.requestId, service_id: app.id, monitor_until: until, status: 'testing' });
  } catch (error) { return next(error); }
});

router.post('/api/v1/agent/services/:id/tests/connectivity', async (req, res, next) => {
  try {
    const app = await ownedService(req);
    if (!app) return apiError(res, 404, 'service_not_found', '服务不存在或不属于当前 Agent。', req.agent.requestId);
    const result = await checkApplicationConnectivity(app.id);
    await audit(req, 'agent_connectivity_test', result.status === 'success' ? 'success' : 'failure', { targetType: 'application', targetId: app.id, detail: { agent_identity: req.agent.identity, ...result } });
    const payload = { request_id: req.agent.requestId, service_id: app.id, test: 'connectivity', status: result.status === 'success' ? 'passed' : 'failed', ...result };
    return res.status(result.status === 'success' ? 200 : 422).json(payload);
  } catch (error) { return next(error); }
});

router.use('/api/v1/agent', (error, req, res, _next) => {
  if (error?.type === 'entity.parse.failed') return apiError(res, 400, 'invalid_request', 'JSON 格式不正确。', req.agent?.requestId ?? null);
  const status = error.status ?? 400;
  const code = error.code ?? (status === 409 ? 'conflict' : 'invalid_request');
  return apiError(res, status, code, error.message || '请求处理失败。', req.agent?.requestId ?? null);
});

export const agentRouter = router;
