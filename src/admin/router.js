import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { audit } from '../repositories/audit.js';
import { decryptJson, encryptJson, randomToken, sha256 } from '../security/crypto.js';
import { hashPassword } from '../security/password.js';
import { checkApplicationConnectivity } from '../services/application-monitor.js';
import { ADMIN_CLIENT_ID, adminCallbackUrl, adminClientSecret, adminLoggedOutUrl } from '../services/system-admin-client.js';
import { publishTerm } from '../services/terms.js';
import { startTurnover } from '../services/turnover.js';
import { createZip } from '../services/zip-archive.js';
import { publicUrl } from '../public-url.js';
import { formatBeijingTime, parseBeijingLocalTime } from './time.js';

const router = express.Router();
const body = express.urlencoded({ extended: false, limit: '32kb' });
const ttlMs = 2 * 60 * 60 * 1000;
const packageDownloads = new Map();
const phpSdkSource = readFileSync(new URL('../../sdk/php74/SsoClient.php', import.meta.url), 'utf8');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function sign(value) { return createHmac('sha256', config.cookieKeys[0]).update(value).digest('base64url'); }
function signedPayload(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readSignedPayload(raw) {
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}
function readCookie(req, name) {
  return String(req.headers.cookie ?? '').split(';').map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}
function makeSession(personId) {
  return signedPayload({ personId, csrf: randomBytes(24).toString('base64url'), expires: Date.now() + ttlMs });
}
function readSession(req) {
  const session = readSignedPayload(readCookie(req, 'enterprise_admin'));
  return session?.expires > Date.now() ? session : null;
}
function cookie(value, maxAge = 7200) {
  return `enterprise_admin=${value}; Path=${publicUrl('/admin')}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}
function flowCookie(value, maxAge = 600) {
  return `enterprise_admin_flow=${value}; Path=${publicUrl('/admin')}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}
function localEndpoint(path) {
  return `http://127.0.0.1:${config.port}${config.publicBasePath}${path}`;
}
async function requireAdmin(req, res, next) {
  const session = readSession(req);
  if (!session) return res.redirect(publicUrl('/admin/login'));
  const [rows] = await pool.execute(
    `SELECT p.id,p.display_name,r.role FROM people p JOIN system_role_assignments r ON r.person_id=p.id
     WHERE p.id=? AND p.status IN ('active','probation') AND r.status='active'
       AND r.role IN ('super_admin','security_admin','personnel_admin','application_admin','audit_viewer')
       AND (r.starts_at IS NULL OR r.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       AND (r.ends_at IS NULL OR r.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    [session.personId],
  );
  if (!rows[0]) return res.status(403).send(loginPage('无权访问', '<p class="form-note">当前账号没有后台权限。</p>'));
  req.admin = { ...session, person: rows[0], roles: rows.map((row) => row.role) };
  next();
}
function requireCsrf(req, res, next) {
  if (!req.admin || req.body.csrf !== req.admin.csrf) return res.status(400).send(loginPage('请求失效', '<p class="form-note">页面已失效，请刷新后重试。</p>'));
  next();
}
function hasRole(req, roles) { return req.admin.roles.some((role) => roles.includes(role)); }
function forbidUnless(req, res, roles) {
  if (hasRole(req, roles)) return false;
  res.status(403).send(adminPage(req, '无权操作', '', '<div class="empty">当前管理员没有执行此操作的权限。</div>'));
  return true;
}
function loginPage(title, content) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><link rel="stylesheet" href="${publicUrl('/assets/admin.css')}"></head><body class="admin-login-page"><main class="admin-login"><div class="admin-brand"><span>ID</span><strong>统一认证控制台</strong></div><section class="login-box"><h1>${esc(title)}</h1>${content}</section></main></body></html>`;
}
const navGroups = [
  ['接入服务管理', [
    ['applications', '/admin/applications', '服务纵览'],
    ['application-new', '/admin/applications/new', '新增接入服务'],
    ['monitoring', '/admin/monitoring', '连通与监控'],
  ]],
  ['部门人员管理', [
    ['people', '/admin/people', '人员与账号'],
    ['organization', '/admin/organization', '部门与职位'],
    ['terms', '/admin/terms', '届次换届'],
  ]],
  ['系统管理', [
    ['overview', '/admin', '系统概览'],
    ['sessions', '/admin/sessions', '登录会话'],
    ['audit', '/admin/audit', '审计日志'],
    ['integration', '/admin/integration', '接入文档'],
  ]],
];
function adminPage(req, title, active, content, subtitle = '') {
  const csrf = esc(req.admin.csrf);
  const nav = navGroups.map(([group, items]) => `<div class="nav-section"><div class="nav-title">${esc(group)}</div>${items.map(([key, href, label]) => `<a class="nav-item ${active === key ? 'active' : ''}" href="${publicUrl(href)}">${esc(label)}</a>`).join('')}</div>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)} · 统一认证</title><link rel="stylesheet" href="${publicUrl('/assets/admin.css')}"></head><body class="admin-page"><aside class="sidebar"><a class="console-brand" href="${publicUrl('/admin')}"><span>ID</span><div>统一认证<small>管理控制台</small></div></a><nav>${nav}</nav><div class="sidebar-foot"><div><strong>${esc(req.admin.person.display_name)}</strong><small>${esc(req.admin.person.id)}</small></div><form method="post" action="${publicUrl('/admin/logout')}"><input type="hidden" name="csrf" value="${csrf}"><button class="link-button">退出全部系统</button></form></div></aside><div class="workspace"><header class="topbar"><div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><span class="env-badge">生产环境</span></header><main class="content">${content}</main></div><script src="${publicUrl('/assets/admin.js')}" defer></script></body></html>`;
}
function csrf(req) { return `<input type="hidden" name="csrf" value="${esc(req.admin.csrf)}">`; }
function badge(value, tone = '') { return `<span class="badge ${tone}">${esc(value)}</span>`; }
function statusBadge(value) {
  const labels = { active: '启用', disabled: '停用', probation: '试用', retired: '已卸任', candidate: '候选', graduated: '已毕业', left: '已离开', dismissed: '已移除', draft: '草稿', review: '复核中', scheduled: '待生效', archived: '已归档', completed: '已完成', preparing: '处理中' };
  return badge(labels[value] ?? value, ['active', 'completed'].includes(value) ? 'success' : ['disabled', 'retired', 'left', 'graduated', 'dismissed'].includes(value) ? 'muted' : 'warning');
}
function formatTime(value) {
  const formatted = formatBeijingTime(value);
  return formatted ? esc(formatted) : '—';
}
function validateRedirectUri(value) {
  let parsed;
  try { parsed = new URL(String(value ?? '').trim()); } catch { throw new Error('回调地址必须是完整 URL'); }
  if (parsed.username || parsed.password || parsed.hash) throw new Error('回调地址不能包含账号、密码或锚点');
  const allowedHttp = parsed.protocol === 'http:' && config.internalHttpRedirectHosts.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !allowedHttp && !(config.nodeEnv !== 'production' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('回调地址必须使用 HTTPS，或使用已批准的内网 HTTP 主机');
  return parsed.toString();
}
async function updateClient(connection, clientId, transform) {
  const [rows] = await connection.execute("SELECT payload FROM oidc_objects WHERE model='Client' AND id=?", [clientId]);
  if (!rows[0]) throw new Error('OIDC 客户端不存在');
  const payload = decryptJson(JSON.parse(rows[0].payload));
  transform(payload);
  await connection.execute("UPDATE oidc_objects SET payload=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE model='Client' AND id=?", [JSON.stringify(encryptJson(payload)), clientId]);
}
function secretResult(req, title, application, secret, extra = '') {
  return adminPage(req, title, 'applications', `<div class="notice success-notice"><strong>操作成功</strong><p>客户端密钥只显示这一次。请立即写入业务系统的安全配置，不要放入 GitHub。</p></div><section class="card"><div class="detail-list"><div><span>应用</span><strong>${esc(application.name)}</strong></div><div><span>Client ID</span><code>${esc(application.client_id)}</code></div><div><span>Client Secret</span><div class="secret-row"><code class="secret" id="one-time-secret">${esc(secret)}</code><button class="button secondary small" type="button" data-copy="#one-time-secret">复制</button></div></div>${extra}</div><div class="card-actions"><a class="button primary" href="${publicUrl(`/admin/applications/${encodeURIComponent(application.id)}`)}">进入应用配置</a></div></section>`);
}
function validateRelatedUrl(value, redirectUri, label, required = true) {
  const raw = String(value ?? '').trim();
  if (!raw && !required) return null;
  const url = validateRedirectUri(raw);
  const redirect = new URL(redirectUri);
  const parsed = new URL(url);
  if (parsed.host !== redirect.host) throw new Error(`${label}必须与登录回调使用同一主机`);
  return url;
}
function projectRootUrl(value) {
  const parsed = new URL(validateRedirectUri(value));
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}
function codeBlock(id, title, code) {
  return `<div class="code-block"><div class="code-head"><strong>${esc(title)}</strong><button type="button" class="button ghost small" data-copy="#${esc(id)}">复制代码</button></div><pre id="${esc(id)}"><code>${esc(code)}</code></pre></div>`;
}
function wizardSteps(current) {
  return `<ol class="wizard-steps">${['登记项目', '下载接入包', '部署与检测', '完成验收'].map((label, index) => `<li class="${index + 1 < current ? 'done' : index + 1 === current ? 'current' : ''}"><span>${index + 1}</span><strong>${label}</strong></li>`).join('')}</ol>`;
}
function onboardingCode(app, secret, projectRoot, redirectUri, logoutUri, healthUri) {
  const verifyLoginUrl = `${config.issuer}/admin/applications/${encodeURIComponent(app.id)}/verify-login`;
  const verifyLogoutUrl = `${config.issuer}/admin/applications/${encodeURIComponent(app.id)}/verify-logout`;
  const rootPath = new URL(projectRoot).pathname;
  const configCode = `<?php\nreturn array(\n  'issuer' => '${config.issuer}',\n  'client_id' => '${app.client_id}',\n  'client_secret' => '${secret}',\n  'redirect_uri' => '${redirectUri}',\n  'post_logout_redirect_uri' => '${logoutUri}',\n  'allow_insecure_http' => true,\n  'local_cookie_secure' => false,\n  'session_name' => '${app.client_id.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48).toUpperCase()}_SID',\n  'session_path' => '${rootPath}',\n  'local_idle_seconds' => 7200,\n  'local_absolute_seconds' => 28800,\n);`;
  const login = `<?php\n// 在业务页面输出任何内容前引入本文件。\nrequire_once __DIR__ . '/SsoClient.php';\n$enterpriseSso = new EnterpriseSsoClient(require __DIR__ . '/config.php');\n$ssoUser = $enterpriseSso->requireLogin();\n// $ssoUser['sub'] 是唯一 UserID；还可读取 name、department、position。`;
  const callback = `<?php\nrequire_once __DIR__ . '/SsoClient.php';\n$client = new EnterpriseSsoClient(require __DIR__ . '/config.php');\n$client->handleCallback();`;
  const logout = `<?php\nrequire_once __DIR__ . '/SsoClient.php';\n$client = new EnterpriseSsoClient(require __DIR__ . '/config.php');\n$client->logout('/'); // 同时退出本应用和统一认证`;
  const health = `<?php\n$config = require __DIR__ . '/config.php';\nheader('Content-Type: application/json; charset=UTF-8');\necho json_encode([\n  'ok' => true,\n  'client_id' => $config['client_id'],\n  'signature' => hash_hmac('sha256', 'enterprise-sso-connectivity-v1', $config['client_secret']),\n]);\n// 检测地址：${healthUri}`;
  const testLogin = `<?php\n$config = require __DIR__ . '/config.php';\nrequire __DIR__ . '/login.php';\n$ts = time();\n$payload = 'login|' . $ssoUser['sub'] . '|' . $ts;\n$proof = hash_hmac('sha256', $payload, $config['client_secret']);\nheader('Location: ${verifyLoginUrl}?' . http_build_query([\n  'sub' => $ssoUser['sub'], 'ts' => $ts, 'proof' => $proof,\n]));\nexit;`;
  const testLogout = `<?php\nrequire_once __DIR__ . '/SsoClient.php';\n$client = new EnterpriseSsoClient(require __DIR__ . '/config.php');\n$client->logout('/', '${verifyLogoutUrl}');`;
  const readme = `ESSO-DFSJ 统一认证接入包\n\n部署：把整个 ESSO-DFSJ 文件夹放到项目根目录，禁止改名。\n\n文件：\nconfig.php       基础配置和一次性 Client Secret，不得提交 Git 或公开下载。\nSsoClient.php    OIDC 协议客户端，负责 state、PKCE、令牌交换、用户信息和会话。\nlogin.php        登录入口及身份读取；业务页面引入后可使用 $ssoUser。\ncallback.php     统一认证回调，不能删除、不能直接访问。\nlogout.php       同时清理业务会话和统一认证会话。\nhealth.php       签名连通检测，验收后保留用于持续监控。\ntest-login.php   真实登录验收，全部测试通过后可删除。\ntest-logout.php  真实注销验收，全部测试通过后可删除。\n\n保护业务页面（文件第一行）：\nrequire_once __DIR__ . '/ESSO-DFSJ/login.php';\n$userId = $ssoUser['sub'];\n$name = $ssoUser['name'];\n\n退出链接：\n<a href=\"ESSO-DFSJ/logout.php\">退出登录</a>\n\n项目根地址：${projectRoot}\n`;
  return { configCode, login, callback, logout, health, testLogin, testLogout, readme };
}

function integrationPackage(snippets) {
  return createZip({
    'ESSO-DFSJ/config.php': snippets.configCode,
    'ESSO-DFSJ/SsoClient.php': phpSdkSource,
    'ESSO-DFSJ/login.php': snippets.login,
    'ESSO-DFSJ/callback.php': snippets.callback,
    'ESSO-DFSJ/logout.php': snippets.logout,
    'ESSO-DFSJ/health.php': snippets.health,
    'ESSO-DFSJ/test-login.php': snippets.testLogin,
    'ESSO-DFSJ/test-logout.php': snippets.testLogout,
    'ESSO-DFSJ/README.txt': snippets.readme,
  });
}

async function canDeleteApplications(req) {
  if (hasRole(req, ['super_admin'])) return true;
  const [rows] = await pool.execute(`SELECT 1 FROM appointments a JOIN positions p ON p.id=a.position_id
    WHERE a.person_id=? AND a.status='active' AND p.status='active' AND p.rank_order>=(
      SELECT COALESCE(MAX(rank_order),40) FROM positions WHERE code='minister' OR name='部长'
    ) AND a.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 1`, [req.admin.person.id]);
  return Boolean(rows[0]);
}

router.get('/login', (req, res) => {
  if (readSession(req)) return res.redirect(publicUrl('/admin'));
  const state = randomToken(32);
  const nonce = randomToken(32);
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const flow = signedPayload({ state, nonce, verifier, expires: Date.now() + 10 * 60_000 });
  const url = new URL(`${config.issuer}/auth`);
  url.search = new URLSearchParams({
    client_id: ADMIN_CLIENT_ID,
    redirect_uri: adminCallbackUrl(),
    response_type: 'code',
    scope: 'openid profile enterprise',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  res.setHeader('Set-Cookie', flowCookie(flow));
  return res.redirect(url.toString());
});
router.get('/callback', async (req, res, next) => {
  try {
    const flow = readSignedPayload(readCookie(req, 'enterprise_admin_flow'));
    const returnedState = String(req.query.state ?? '');
    const expectedState = String(flow?.state ?? '');
    if (!flow || flow.expires <= Date.now() || returnedState.length !== expectedState.length || !timingSafeEqual(Buffer.from(returnedState), Buffer.from(expectedState))) {
      return res.status(400).send(loginPage('登录请求已失效', `<a class="button primary full" href="${publicUrl('/admin/login')}">重新登录</a>`));
    }
    if (!req.query.code || req.query.error) throw new Error('统一认证未返回有效授权码');
    const tokenResponse = await fetch(localEndpoint('/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: adminCallbackUrl(), client_id: ADMIN_CLIENT_ID, client_secret: adminClientSecret(), code_verifier: flow.verifier }),
      signal: AbortSignal.timeout(5000),
    });
    if (!tokenResponse.ok) throw new Error('统一认证令牌交换失败');
    const token = await tokenResponse.json();
    const userResponse = await fetch(localEndpoint('/me'), { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(5000) });
    if (!userResponse.ok) throw new Error('统一认证身份读取失败');
    const user = await userResponse.json();
    const [roles] = await pool.execute("SELECT role FROM system_role_assignments WHERE person_id=? AND status='active'", [user.sub]);
    if (!roles.length) return res.status(403).send(loginPage('无权访问', '<p class="form-note">此账号已完成统一认证，但没有后台管理权限。</p>'));
    res.setHeader('Set-Cookie', [cookie(makeSession(user.sub)), flowCookie('', 0)]);
    await audit(req, 'admin_oidc_login', 'success', { actorPersonId: user.sub, targetType: 'application', targetId: ADMIN_CLIENT_ID });
    return res.redirect(publicUrl('/admin'));
  } catch (error) { return next(error); }
});
router.get('/logged-out', (_req, res) => res.send(loginPage('已安全退出', `<p class="login-subtitle">业务后台会话和统一认证会话均已结束。</p><a class="button primary full" href="${publicUrl('/admin/login')}">重新登录</a>`)));
router.post('/logout', requireAdmin, body, requireCsrf, (req, res) => {
  const url = new URL(`${config.issuer}/session/end`);
  url.search = new URLSearchParams({ client_id: ADMIN_CLIENT_ID, post_logout_redirect_uri: adminLoggedOutUrl() }).toString();
  res.setHeader('Set-Cookie', cookie('', 0));
  res.redirect(303, url.toString());
});

router.get('/', requireAdmin, async (req, res) => {
  const [[people], [apps], [events], [sessions], [recentApps], [recentEvents]] = await Promise.all([
    pool.execute("SELECT COUNT(*) total,SUM(status IN ('active','probation')) available,SUM(permanent_member=1) permanent FROM people"),
    pool.execute("SELECT COUNT(*) total,SUM(status='active') active,SUM(provisioning_enabled=1) provisioning FROM applications WHERE client_id<>?", [ADMIN_CLIENT_ID]),
    pool.execute("SELECT COUNT(*) total,SUM(result='failure') failures FROM audit_logs WHERE created_at>=datetime('now','-24 hours')"),
    pool.execute("SELECT COUNT(*) total FROM oidc_objects WHERE model='Session' AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
    pool.execute('SELECT id,client_id,name,access_mode,status,updated_at FROM applications WHERE client_id<>? ORDER BY updated_at DESC LIMIT 5', [ADMIN_CLIENT_ID]),
    pool.execute('SELECT event_type,result,actor_person_id,target_id,created_at FROM audit_logs ORDER BY id DESC LIMIT 8'),
  ]);
  const p = people[0] ?? {}; const a = apps[0] ?? {}; const e = events[0] ?? {}; const s = sessions[0] ?? {};
  const metrics = [[a.active ?? 0, '启用服务', 'applications'], [p.available ?? 0, '可登录人员', 'people'], [s.total ?? 0, '有效会话', 'sessions'], [e.total ?? 0, '24 小时事件', 'audit']].map(([value, label, link]) => `<a href="${publicUrl(`/admin/${link}`)}"><span>${label}</span><strong>${value}</strong></a>`).join('');
  const appRows = recentApps.map((app) => `<tr><td><a class="table-link" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">${esc(app.name)}</a><small>${esc(app.client_id)}</small></td><td>${app.access_mode === 'all_active' ? '全部有效人员' : '按规则授权'}</td><td>${statusBadge(app.status)}</td><td>${formatTime(app.updated_at)}</td></tr>`).join('');
  const eventRows = recentEvents.map((event) => `<tr><td>${esc(event.event_type)}</td><td>${esc(event.actor_person_id ?? '系统')}</td><td>${badge(event.result, event.result === 'success' ? 'success' : event.result === 'failure' ? 'danger' : 'warning')}</td><td>${formatTime(event.created_at)}</td></tr>`).join('');
  res.send(adminPage(req, '系统概览', 'overview', `<div class="metric-strip">${metrics}</div><div class="dashboard-actions"><a class="button primary" href="${publicUrl('/admin/applications/new')}">新增接入服务</a><a class="button secondary" href="${publicUrl('/admin/people')}">管理人员</a><a class="button secondary" href="${publicUrl('/admin/sessions')}">查看会话</a></div><div class="split-tables"><section class="table-panel"><div class="page-actions"><div><h2>最近服务</h2><p>统一认证接入状态</p></div><a class="button ghost small" href="${publicUrl('/admin/applications')}">全部服务</a></div><div class="table-wrap"><table><thead><tr><th>应用</th><th>访问策略</th><th>状态</th><th>更新</th></tr></thead><tbody>${appRows || '<tr><td colspan="4" class="empty-cell">暂无应用</td></tr>'}</tbody></table></div></section><section class="table-panel"><div class="page-actions"><div><h2>最近认证事件</h2><p>成功、失败与拒绝记录</p></div><a class="button ghost small" href="${publicUrl('/admin/audit')}">全部日志</a></div><div class="table-wrap"><table><thead><tr><th>事件</th><th>主体</th><th>结果</th><th>时间</th></tr></thead><tbody>${eventRows || '<tr><td colspan="4" class="empty-cell">暂无事件</td></tr>'}</tbody></table></div></section></div>`, '认证、服务与人员运行状态'));
});

router.get('/applications', requireAdmin, async (req, res) => {
  const [apps] = await pool.execute(`SELECT a.*,COUNT(DISTINCT r.id) redirect_count,COUNT(DISTINCT ar.id) rule_count FROM applications a LEFT JOIN application_redirect_uris r ON r.application_id=a.id LEFT JOIN application_access_rules ar ON ar.application_id=a.id WHERE a.client_id<>? GROUP BY a.id ORDER BY a.name`, [ADMIN_CLIENT_ID]);
  const canDelete = await canDeleteApplications(req);
  const rows = apps.map((app) => `<tr><td><a class="table-link" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">${esc(app.name)}</a><small>${esc(app.client_id)}</small></td><td>${app.access_mode === 'all_active' ? '全部有效人员' : `规则授权（${app.rule_count} 条）`}</td><td>${app.home_url ? `<a href="${esc(app.home_url)}" target="_blank" rel="noopener">打开网站</a>` : '—'}</td><td>${app.last_check_status === 'success' ? badge('连通', 'success') : app.last_check_status === 'failure' ? badge('异常', 'danger') : badge('未检测', 'muted')}</td><td>${statusBadge(app.status)}</td><td><div class="action-row"><a class="button ghost small" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">管理</a><a class="button ghost small" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/onboarding?step=3`)}">测试</a>${canDelete ? `<a class="button danger small" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/delete`)}">删除</a>` : ''}</div></td></tr>`).join('');
  const addButton = hasRole(req, ['super_admin', 'application_admin']) ? `<a class="button primary" href="${publicUrl('/admin/applications/new')}">新增接入服务</a>` : '';
  res.send(adminPage(req, '服务纵览', 'applications', `<section class="table-panel"><div class="page-actions"><div><h2>接入服务</h2><p>集中管理网站、认证端点、权限与连通状态</p></div>${addButton}</div><div class="table-wrap"><table><thead><tr><th>服务</th><th>访问范围</th><th>业务入口</th><th>连通状态</th><th>启用状态</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-cell">尚未接入服务</td></tr>'}</tbody></table></div></section>`, '表格纵览与集中操作'));
});

router.get('/applications/new', requireAdmin, (req, res) => {
  if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return;
  res.send(adminPage(req, '新增接入服务', 'application-new', `${wizardSteps(1)}<section class="wizard-panel"><div class="wizard-heading"><span>第一步</span><h2>登记项目基本信息</h2><p>只填写项目根地址，系统自动生成回调、注销、健康检查和测试地址。</p></div><form class="form-grid" method="post" action="${publicUrl('/admin/applications')}">${csrf(req)}<label>服务名称<input name="name" maxlength="180" placeholder="例如：值班管理后台" required></label><label>Client ID（可选）<input name="client_id" maxlength="120" placeholder="留空自动生成"></label><label class="span-2">项目访问根地址<input name="project_root_url" type="url" placeholder="http://210.47.163.114/qywx/YourProject/" required><small>填写浏览器访问地址，不是服务器磁盘路径；地址必须以项目根目录结尾。</small></label><label>访问范围<select name="access_mode"><option value="rules">按授权规则</option><option value="all_active">全部有效人员</option></select></label><label class="check-label"><input type="checkbox" name="provisioning_enabled" value="1">允许业务系统发起快捷注册</label><div class="form-actions span-2"><button class="button primary">登记并生成 ESSO-DFSJ 接入包</button></div></form></section>`, '填一次项目地址，下载固定目录接入包'));
});

router.post('/applications', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try {
    if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return;
    const name = String(req.body.name ?? '').trim();
    const clientId = String(req.body.client_id ?? '').trim() || `app_${randomToken(12)}`;
    const homeUrl = projectRootUrl(req.body.project_root_url);
    const packageBase = new URL('ESSO-DFSJ/', homeUrl);
    const redirectUri = new URL('callback.php', packageBase).toString();
    const logoutUri = homeUrl;
    const healthUri = new URL('health.php', packageBase).toString();
    const accessMode = req.body.access_mode === 'all_active' ? 'all_active' : 'rules';
    if (!name || name.length > 180 || !/^[A-Za-z0-9._~-]{3,120}$/.test(clientId)) throw new Error('应用名称或 Client ID 格式不正确');
    const id = randomUUID(); const secret = randomToken(48); const hash = await hashPassword(secret); const now = new Date().toISOString();
    const verificationLogoutUri = `${config.issuer}/admin/applications/${encodeURIComponent(id)}/verify-logout`;
    const clientPayload = { client_id: clientId, client_secret: secret, client_name: name, redirect_uris: [redirectUri], post_logout_redirect_uris: [logoutUri, verificationLogoutUri], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_post', id_token_signed_response_alg: 'ES256' };
    await withTransaction(async (connection) => {
      await connection.execute("INSERT INTO applications(id,client_id,name,client_secret_hash,access_mode,provisioning_enabled,status,home_url,health_check_url,integration_status,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,'configuring',?,?)", [id, clientId, name, hash, accessMode, req.body.provisioning_enabled === '1' ? 1 : 0, homeUrl, healthUri, now, now]);
      await connection.execute('INSERT INTO application_redirect_uris(application_id,redirect_uri,created_at) VALUES (?,?,?)', [id, redirectUri, now]);
      await connection.execute("INSERT INTO oidc_objects(model,id,payload,created_at,updated_at) VALUES ('Client',?,?,?,?)", [clientId, JSON.stringify(encryptJson(clientPayload)), now, now]);
    });
    await audit(req, 'application_create', 'success', { actorPersonId: req.admin.person.id, targetType: 'application', targetId: clientId });
    const app = { id, name, client_id: clientId };
    const snippets = onboardingCode(app, secret, homeUrl, redirectUri, logoutUri, healthUri);
    const downloadToken = randomToken(32);
    packageDownloads.set(downloadToken, { appId: id, archive: integrationPackage(snippets), expires: Date.now() + 15 * 60_000 });
    for (const [token, item] of packageDownloads) if (item.expires <= Date.now()) packageDownloads.delete(token);
    const downloadUrl = publicUrl(`/admin/applications/${encodeURIComponent(id)}/package/${downloadToken}`);
    res.send(adminPage(req, '新增接入服务', 'application-new', `${wizardSteps(2)}<section class="wizard-panel"><div class="wizard-heading"><span>第二步</span><h2>下载 ESSO-DFSJ 接入包</h2><p>下载后解压，把整个 ESSO-DFSJ 文件夹放进项目根目录，禁止改名。下载链接和 Client Secret 仅本页有效。</p></div><div class="credential-table"><div><span>项目根地址</span><code>${esc(homeUrl)}</code></div><div><span>Client ID</span><code id="wizard-client">${esc(clientId)}</code><button data-copy="#wizard-client" class="button ghost small">复制</button></div><div><span>固定目录</span><code>ESSO-DFSJ/</code></div></div><div class="package-layout"><strong>接入包内含 9 个文件</strong><p>配置、协议客户端、登录与身份读取、回调、登出、健康检测、登录验收、登出验收和说明文档已经全部生成。</p><code>${esc(new URL('ESSO-DFSJ/login.php', homeUrl).toString())}</code></div><div class="wizard-actions"><a class="button primary" href="${downloadUrl}">下载 ESSO-DFSJ.zip</a><form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(id)}/monitor/start`)}">${csrf(req)}<button class="button secondary">已部署，开始三项验收</button></form></div></section>`, '无需逐个复制文件，下载后整体部署'));
  } catch (error) { next(error); }
});

router.get('/applications/:id/package/:token', requireAdmin, async (req, res) => {
  if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return;
  const item = packageDownloads.get(req.params.token);
  if (!item || item.appId !== req.params.id || item.expires <= Date.now()) return res.status(410).send(adminPage(req, '下载已失效', 'application-new', '<div class="empty">接入包只在创建后短时间内提供。请删除未完成的测试服务并重新登记。</div>'));
  packageDownloads.delete(req.params.token);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="ESSO-DFSJ.zip"');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(item.archive);
});

router.post('/applications/:id/monitor/start', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try {
    if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return;
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await pool.execute("UPDATE applications SET monitor_until=?,integration_status='testing',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [until, req.params.id]);
    await checkApplicationConnectivity(req.params.id);
    return res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}/onboarding?step=3`));
  } catch (error) { return next(error); }
});
router.post('/applications/:id/check', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try {
    if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return;
    await checkApplicationConnectivity(req.params.id);
    const back = req.body.return_to === 'monitoring' ? '/admin/monitoring' : `/admin/applications/${encodeURIComponent(req.params.id)}/onboarding?step=3`;
    return res.redirect(publicUrl(back));
  } catch (error) { return next(error); }
});
router.get('/applications/:id/verify-login', requireAdmin, async (req, res, next) => {
  try {
    const sub = String(req.query.sub ?? '');
    const timestamp = Number(req.query.ts);
    const proof = String(req.query.proof ?? '');
    if (sub !== req.admin.person.id || !Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) throw new Error('登录测试凭据已失效');
    const [clients] = await pool.execute("SELECT o.payload FROM applications a JOIN oidc_objects o ON o.model='Client' AND o.id=a.client_id WHERE a.id=?", [req.params.id]);
    if (!clients[0]) throw new Error('接入服务不存在');
    const client = decryptJson(JSON.parse(clients[0].payload));
    const expected = createHmac('sha256', client.client_secret).update(`login|${sub}|${timestamp}`).digest('hex');
    if (proof.length !== expected.length || !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) throw new Error('登录测试签名不正确');
    await pool.execute("UPDATE applications SET auth_test_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [req.params.id]);
    return res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}/onboarding?step=3`));
  } catch (error) { return next(error); }
});
router.get('/applications/:id/verify-logout', requireAdmin, async (req, res) => {
  await pool.execute("UPDATE applications SET logout_test_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [req.params.id]);
  return res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}/onboarding?step=3`));
});
router.get('/applications/:id/onboarding', requireAdmin, async (req, res) => {
  const [[apps], [checks]] = await Promise.all([
    pool.execute("SELECT * FROM applications WHERE id=? AND client_id<>?", [req.params.id, ADMIN_CLIENT_ID]),
    pool.execute('SELECT * FROM application_connectivity_checks WHERE application_id=? ORDER BY id DESC LIMIT 10', [req.params.id]),
  ]);
  const app = apps[0]; if (!app) return res.sendStatus(404);
  const baseOk = app.last_check_status === 'success';
  const authOk = Boolean(app.auth_test_at);
  const logoutOk = Boolean(app.logout_test_at);
  const success = baseOk && authOk && logoutOk;
  const health = app.health_check_url ? new URL(app.health_check_url) : null;
  const testLoginUrl = health ? new URL('test-login.php', health).toString() : '#';
  const testLogoutUrl = health ? new URL('test-logout.php', health).toString() : '#';
  const rows = checks.map((check) => `<tr><td>${formatTime(check.checked_at)}</td><td>${check.status === 'success' ? badge('连通', 'success') : badge('失败', 'danger')}</td><td>${check.http_status ?? '—'}</td><td>${check.response_ms} ms</td><td>${esc(check.message ?? '')}</td></tr>`).join('');
  const next = success ? `<a class="button primary" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">完成并管理服务</a><a class="button secondary" href="${esc(app.home_url)}" target="_blank" rel="noopener">打开业务系统</a>` : !baseOk ? `<form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/check`)}">${csrf(req)}<button class="button primary">立即重新检测基础连通</button></form>` : !authOk ? `<a class="button primary" href="${esc(testLoginUrl)}">开始真实登录认证测试</a>` : `<a class="button primary" href="${esc(testLogoutUrl)}">开始统一注销测试</a>`;
  const testRows = `<tr><td>基础连通与凭据</td><td>${baseOk ? badge('通过','success') : badge('待通过','warning')}</td><td>${esc(app.last_check_message ?? '等待检测')}</td></tr><tr><td>密码或企业微信认证</td><td>${authOk ? badge('通过','success') : badge('待测试','warning')}</td><td>${authOk ? formatTime(app.auth_test_at) : '访问 test-login.php 完成一次真实登录'}</td></tr><tr><td>统一注销与回跳</td><td>${logoutOk ? badge('通过','success') : badge('待测试','warning')}</td><td>${logoutOk ? formatTime(app.logout_test_at) : '访问 test-logout.php，确认回到本向导'}</td></tr>`;
  res.send(adminPage(req, '新增接入服务', 'application-new', `${wizardSteps(success ? 4 : 3)}<section class="wizard-panel"><div class="wizard-heading"><span>${success ? '第四步' : '第三步'}</span><h2>${success ? '接入验收全部通过' : '逐项完成接入验收'}</h2><p>${success ? '基础连通、真实认证和统一注销均已通过。' : '系统会自动检测基础连通；登录和注销需要点击按钮完成一次真实用户流程。'}</p></div><div class="table-wrap verification-table"><table><thead><tr><th>验收项目</th><th>状态</th><th>结果与操作说明</th></tr></thead><tbody>${testRows}</tbody></table></div><div class="wizard-actions">${next}</div><details class="check-history"><summary>查看基础连通检测历史</summary><div class="table-wrap"><table><thead><tr><th>检测时间</th><th>结果</th><th>HTTP</th><th>耗时</th><th>说明</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-cell">等待首次检测</td></tr>'}</tbody></table></div></details></section>`, '认证、注销和连通性都提供代码与真实测试'));
});

router.get('/monitoring', requireAdmin, async (req, res) => {
  const [apps] = await pool.execute("SELECT * FROM applications WHERE client_id<>? ORDER BY last_check_status,last_check_at DESC", [ADMIN_CLIENT_ID]);
  const rows = apps.map((app) => `<tr><td><a class="table-link" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">${esc(app.name)}</a><small>${esc(app.client_id)}</small></td><td><code>${esc(app.health_check_url ?? '未配置')}</code></td><td>${app.last_check_status === 'success' ? badge('连通', 'success') : app.last_check_status === 'failure' ? badge('失败', 'danger') : badge('未检测', 'muted')}</td><td>${app.last_check_http_status ?? '—'}</td><td>${formatTime(app.last_check_at)}</td><td><form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/check`)}">${csrf(req)}<input type="hidden" name="return_to" value="monitoring"><button class="button ghost small" ${app.health_check_url ? '' : 'disabled'}>立即检测</button></form></td></tr>`).join('');
  res.send(adminPage(req, '连通与监控', 'monitoring', `<section class="table-panel"><div class="page-actions"><div><h2>服务连通状态</h2><p>接入向导启动后持续检测十分钟，历史结果保留用于排障。</p></div></div><div class="table-wrap"><table><thead><tr><th>服务</th><th>检测地址</th><th>状态</th><th>HTTP</th><th>最近检测</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-cell">暂无服务</td></tr>'}</tbody></table></div></section>`, '集中查看业务系统可达性'));
});

router.get('/applications/:id/delete', requireAdmin, async (req, res) => {
  if (!(await canDeleteApplications(req))) return res.status(403).send(adminPage(req, '无权删除', 'applications', '<div class="empty">只有超级管理员或当前部长级及以上的后台管理员可以删除接入服务。</div>'));
  const [apps] = await pool.execute('SELECT id,name,client_id FROM applications WHERE id=? AND client_id<>?', [req.params.id, ADMIN_CLIENT_ID]);
  const app = apps[0];
  if (!app) return res.sendStatus(404);
  res.send(adminPage(req, '删除接入服务', 'applications', `<div class="breadcrumb"><a href="${publicUrl('/admin/applications')}">服务纵览</a><span>/</span><span>删除确认</span></div><section class="table-panel danger-zone"><div class="page-actions"><div><h2>永久删除 ${esc(app.name)}</h2><p>将删除客户端、回调、授权规则、连通记录和未使用的快捷注册链接。业务服务器上的 ESSO-DFSJ 文件夹不会被远程删除。</p></div>${badge('不可恢复', 'danger')}</div><form class="form-grid" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/delete`)}">${csrf(req)}<label class="span-2">输入服务名称确认<input name="confirm_name" autocomplete="off" placeholder="${esc(app.name)}" required></label><div class="form-actions span-2"><a class="button ghost" href="${publicUrl('/admin/applications')}">取消</a><button class="button danger">确认永久删除</button></div></form></section>`, '部长级以上删除权限与二次确认'));
});

router.post('/applications/:id/delete', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try {
    if (!(await canDeleteApplications(req))) return res.status(403).send(adminPage(req, '无权删除', 'applications', '<div class="empty">只有超级管理员或当前部长级及以上的后台管理员可以删除接入服务。</div>'));
    let app;
    await withTransaction(async (connection) => {
      const [apps] = await connection.execute('SELECT id,name,client_id FROM applications WHERE id=? AND client_id<>?', [req.params.id, ADMIN_CLIENT_ID]);
      app = apps[0];
      if (!app) throw new Error('接入服务不存在');
      if (String(req.body.confirm_name ?? '').trim() !== app.name) throw new Error('输入的服务名称不一致，未执行删除');
      await connection.execute("DELETE FROM oidc_objects WHERE model='Client' AND id=?", [app.client_id]);
      await connection.execute('DELETE FROM applications WHERE id=?', [app.id]);
    });
    await audit(req, 'application_delete', 'success', { actorPersonId: req.admin.person.id, targetType: 'application', targetId: app.client_id, detail: { name: app.name } });
    return res.redirect(publicUrl('/admin/applications'));
  } catch (error) { return next(error); }
});

router.get('/applications/:id', requireAdmin, async (req, res) => {
  const [[apps], [redirects], [rules], [departments], [positions], [clients], [checks]] = await Promise.all([
    pool.execute('SELECT * FROM applications WHERE id=? AND client_id<>?', [req.params.id, ADMIN_CLIENT_ID]), pool.execute('SELECT * FROM application_redirect_uris WHERE application_id=? ORDER BY id', [req.params.id]), pool.execute('SELECT * FROM application_access_rules WHERE application_id=? ORDER BY id DESC', [req.params.id]), pool.execute("SELECT id,name FROM departments WHERE status='active' ORDER BY name"), pool.execute("SELECT id,name FROM positions WHERE status='active' ORDER BY rank_order DESC,name"), pool.execute("SELECT payload FROM oidc_objects WHERE model='Client' AND id=(SELECT client_id FROM applications WHERE id=?)", [req.params.id]), pool.execute('SELECT * FROM application_connectivity_checks WHERE application_id=? ORDER BY id DESC LIMIT 20', [req.params.id]),
  ]);
  const app = apps[0]; if (!app) return res.sendStatus(404);
  const client = clients[0] ? decryptJson(JSON.parse(clients[0].payload)) : {};
  const canEdit = hasRole(req, ['super_admin', 'application_admin']);
  const redirectRows = redirects.map((item) => `<li><code>${esc(item.redirect_uri)}</code>${canEdit && redirects.length > 1 ? `<form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/redirects/remove`)}">${csrf(req)}<input type="hidden" name="redirect_id" value="${item.id}"><button class="icon-button danger-text" title="移除">×</button></form>` : ''}</li>`).join('');
  const ruleRows = rules.map((rule) => `<tr><td>${rule.effect === 'allow' ? badge('允许', 'success') : badge('拒绝', 'danger')}</td><td>${{ person: '人员', department: '部门', position: '职位' }[rule.subject_type]}</td><td><code>${esc(rule.subject_id)}</code></td><td>${formatTime(rule.starts_at)} — ${formatTime(rule.ends_at)}</td><td>${canEdit ? `<form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/rules/remove`)}">${csrf(req)}<input type="hidden" name="rule_id" value="${rule.id}"><button class="button ghost small">移除</button></form>` : ''}</td></tr>`).join('');
  const subjectOptions = `<optgroup label="人员"><option value="person:">输入 UserID 后提交</option></optgroup><optgroup label="部门">${departments.map((d) => `<option value="department:${esc(d.id)}">${esc(d.name)}</option>`).join('')}</optgroup><optgroup label="职位">${positions.map((p) => `<option value="position:${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>`;
  const basicSettings = canEdit ? `<section class="table-panel"><div class="page-actions"><div><h2>基本设置</h2><p>维护服务名称、入口、状态和访问模式。</p></div></div><form class="form-grid settings-form" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/settings`)}">${csrf(req)}<label>应用名称<input name="name" value="${esc(app.name)}" required></label><label>业务首页<input name="home_url" type="url" value="${esc(app.home_url ?? '')}" required></label><label>检测地址<input name="health_check_url" type="url" value="${esc(app.health_check_url ?? '')}" required></label><label>状态<select name="status"><option value="active" ${app.status === 'active' ? 'selected' : ''}>启用</option><option value="disabled" ${app.status === 'disabled' ? 'selected' : ''}>停用</option></select></label><label>访问范围<select name="access_mode"><option value="all_active" ${app.access_mode === 'all_active' ? 'selected' : ''}>全部有效人员</option><option value="rules" ${app.access_mode === 'rules' ? 'selected' : ''}>按规则授权</option></select></label><label class="check-label"><input type="checkbox" name="provisioning_enabled" value="1" ${app.provisioning_enabled ? 'checked' : ''}>允许快捷注册 API</label><div class="form-actions span-2"><button class="button primary">保存设置</button></div></form></section>` : '';
  const secretSettings = canEdit ? `<section class="table-panel"><div class="page-actions"><div><h2>凭据与注册</h2><p>密钥不可查看，只能轮换；快捷注册不会接触用户密码。</p></div></div><div class="security-actions"><div><strong>Client Secret</strong><p>轮换后旧密钥立即失效，需要同步更新业务系统配置。</p><form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/rotate-secret`)}">${csrf(req)}<button class="button danger">轮换密钥</button></form></div>${app.provisioning_enabled ? `<div><strong>快捷注册</strong><form class="form-grid compact-grid" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/registration`)}">${csrf(req)}<label>UserID<input name="user_id" required></label><label>姓名<input name="display_name" required></label><div class="form-actions span-2"><button class="button secondary">生成一次性注册链接</button></div></form></div>` : '<div><strong>快捷注册</strong><p>当前未启用，可在基本设置中开启。</p></div>'}</div></section>` : '';
  const addRedirect = canEdit ? `<form class="inline-form" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/redirects`)}">${csrf(req)}<input name="redirect_uri" type="url" placeholder="新增精确回调地址" required><button class="button secondary">添加回调</button></form>` : '';
  const addRule = canEdit && app.access_mode === 'rules' ? `<form class="rule-form" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/rules`)}">${csrf(req)}<select name="effect"><option value="allow">允许</option><option value="deny">拒绝</option></select><select name="subject_choice">${subjectOptions}</select><input name="person_id" placeholder="选择人员时填写 UserID"><input type="datetime-local" name="starts_at"><input type="datetime-local" name="ends_at"><button class="button secondary">添加规则</button></form>` : '';
  const tab = ['overview', 'endpoints', 'access', 'security', 'monitor'].includes(String(req.query.tab)) ? String(req.query.tab) : 'overview';
  const tabs = [['overview','概览'],['endpoints','登录与注销端点'],['access','访问权限'],['security','密钥与注册'],['monitor','连通监控']].map(([key,label]) => `<a class="${tab === key ? 'active' : ''}" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}?tab=${key}`)}">${label}</a>`).join('');
  const checkRows = checks.map((check) => `<tr><td>${formatTime(check.checked_at)}</td><td>${check.status === 'success' ? badge('连通','success') : badge('失败','danger')}</td><td>${check.http_status ?? '—'}</td><td>${check.response_ms} ms</td><td>${esc(check.message ?? '')}</td></tr>`).join('');
  const tabContent = {
    overview: `${basicSettings}<section class="table-panel"><div class="summary-grid"><div><span>Client ID</span><code>${esc(app.client_id)}</code></div><div><span>业务入口</span><a href="${esc(app.home_url ?? '#')}" target="_blank" rel="noopener">${esc(app.home_url ?? '未配置')}</a></div><div><span>接入状态</span>${app.last_check_status === 'success' ? badge('已连通','success') : badge('待检测','warning')}</div><div><span>最近更新</span><strong>${formatTime(app.updated_at)}</strong></div></div></section>`,
    endpoints: `<section class="table-panel"><div class="page-actions"><div><h2>登录回调地址</h2><p>OIDC 登录只允许精确匹配。</p></div><span class="count">${redirects.length} 个</span></div><ul class="uri-list">${redirectRows}</ul>${addRedirect}<div class="endpoint-divider"><strong>退出后返回地址</strong><p>业务系统清理本地 Session 后，应跳转统一认证的 end_session_endpoint。</p>${(client.post_logout_redirect_uris ?? []).map((uri) => `<code class="endpoint-code">${esc(uri)}</code>`).join('') || '<span>未配置</span>'}</div></section>`,
    access: `<section class="table-panel"><div class="page-actions"><div><h2>访问规则</h2><p>拒绝优先，可按人员、部门或职位授权。</p></div><span class="count">${rules.length} 条</span></div>${addRule}<div class="table-wrap"><table><thead><tr><th>效果</th><th>主体类型</th><th>主体</th><th>有效时间</th><th>操作</th></tr></thead><tbody>${ruleRows || '<tr><td colspan="5" class="empty-cell">暂无规则；规则模式下，无允许规则即无法访问</td></tr>'}</tbody></table></div></section>`,
    security: secretSettings,
    monitor: `<section class="table-panel"><div class="page-actions"><div><h2>连通监控</h2><p>${esc(app.health_check_url ?? '未配置检测地址')}</p></div><form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/check`)}">${csrf(req)}<button class="button primary">立即检测</button></form></div><div class="table-wrap"><table><thead><tr><th>检测时间</th><th>结果</th><th>HTTP</th><th>耗时</th><th>说明</th></tr></thead><tbody>${checkRows || '<tr><td colspan="5" class="empty-cell">暂无检测记录</td></tr>'}</tbody></table></div></section>`,
  }[tab];
  res.send(adminPage(req, app.name, 'applications', `<div class="breadcrumb"><a href="${publicUrl('/admin/applications')}">服务纵览</a><span>/</span>${esc(app.name)}</div><div class="service-header"><div><h2>${esc(app.name)}</h2><code>${esc(app.client_id)}</code></div><div>${statusBadge(app.status)} ${app.access_mode === 'all_active' ? badge('全部有效人员') : badge('按规则授权', 'warning')}</div></div><nav class="subtabs">${tabs}</nav>${tabContent}`, `接入服务管理`));
});

router.post('/applications/:id/settings', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const name = String(req.body.name ?? '').trim(); if (!name || !['active', 'disabled'].includes(req.body.status) || !['all_active', 'rules'].includes(req.body.access_mode)) return res.sendStatus(400); const [redirects] = await pool.execute('SELECT redirect_uri FROM application_redirect_uris WHERE application_id=? ORDER BY id LIMIT 1', [req.params.id]); if (!redirects[0]) throw new Error('应用没有登录回调地址'); const homeUrl = validateRelatedUrl(req.body.home_url, redirects[0].redirect_uri, '业务系统首页'); const healthUrl = validateRelatedUrl(req.body.health_check_url, redirects[0].redirect_uri, '连通检测地址'); await withTransaction(async (connection) => { const [apps] = await connection.execute('SELECT client_id FROM applications WHERE id=?', [req.params.id]); if (!apps[0]) throw new Error('应用不存在'); await connection.execute("UPDATE applications SET name=?,home_url=?,health_check_url=?,status=?,access_mode=?,provisioning_enabled=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [name, homeUrl, healthUrl, req.body.status, req.body.access_mode, req.body.provisioning_enabled === '1' ? 1 : 0, req.params.id]); await updateClient(connection, apps[0].client_id, (payload) => { payload.client_name = name; }); }); await audit(req, 'application_update', 'success', { actorPersonId: req.admin.person.id, targetType: 'application', targetId: req.params.id }); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}?tab=overview`)); } catch (error) { next(error); } });
router.post('/applications/:id/redirects', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const uri = validateRedirectUri(req.body.redirect_uri); await withTransaction(async (connection) => { const [apps] = await connection.execute('SELECT client_id FROM applications WHERE id=?', [req.params.id]); if (!apps[0]) throw new Error('应用不存在'); await connection.execute("INSERT INTO application_redirect_uris(application_id,redirect_uri,created_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", [req.params.id, uri]); await updateClient(connection, apps[0].client_id, (payload) => { payload.redirect_uris = [...new Set([...(payload.redirect_uris ?? []), uri])]; }); }); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}?tab=endpoints`)); } catch (error) { next(error); } });
router.post('/applications/:id/redirects/remove', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; await withTransaction(async (connection) => { const [items] = await connection.execute('SELECT r.redirect_uri,a.client_id,(SELECT COUNT(*) FROM application_redirect_uris WHERE application_id=a.id) total FROM application_redirect_uris r JOIN applications a ON a.id=r.application_id WHERE r.id=? AND r.application_id=?', [req.body.redirect_id, req.params.id]); if (!items[0] || items[0].total <= 1) throw new Error('应用必须至少保留一个回调地址'); await connection.execute('DELETE FROM application_redirect_uris WHERE id=?', [req.body.redirect_id]); await updateClient(connection, items[0].client_id, (payload) => { payload.redirect_uris = (payload.redirect_uris ?? []).filter((uri) => uri !== items[0].redirect_uri); }); }); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}`)); } catch (error) { next(error); } });
router.post('/applications/:id/rotate-secret', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const secret = randomToken(48); const hash = await hashPassword(secret); let app; await withTransaction(async (connection) => { const [apps] = await connection.execute('SELECT id,name,client_id FROM applications WHERE id=?', [req.params.id]); app = apps[0]; if (!app || app.client_id === ADMIN_CLIENT_ID) throw new Error('应用不存在或不可轮换'); await connection.execute("UPDATE applications SET client_secret_hash=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [hash, app.id]); await updateClient(connection, app.client_id, (payload) => { payload.client_secret = secret; }); }); await audit(req, 'client_secret_rotate', 'success', { actorPersonId: req.admin.person.id, targetType: 'application', targetId: app.client_id }); res.send(secretResult(req, '密钥轮换成功', app, secret)); } catch (error) { next(error); } });
router.post('/applications/:id/rules', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const [choiceType, choiceId] = String(req.body.subject_choice ?? '').split(':', 2); const type = choiceType; const subjectId = type === 'person' ? String(req.body.person_id ?? '').trim() : choiceId; if (!['person', 'department', 'position'].includes(type) || !subjectId || !['allow', 'deny'].includes(req.body.effect)) return res.sendStatus(400); const table = { person: 'people', department: 'departments', position: 'positions' }[type]; const [subject] = await pool.execute(`SELECT id FROM ${table} WHERE id=?`, [subjectId]); if (!subject[0]) throw new Error('授权主体不存在'); const starts = req.body.starts_at ? new Date(req.body.starts_at).toISOString() : null; const ends = req.body.ends_at ? new Date(req.body.ends_at).toISOString() : null; if (starts && ends && starts >= ends) throw new Error('结束时间必须晚于开始时间'); await pool.execute("INSERT INTO application_access_rules(application_id,effect,subject_type,subject_id,starts_at,ends_at,created_at) VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", [req.params.id, req.body.effect, type, subjectId, starts, ends]); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}`)); } catch (error) { next(error); } });
router.post('/applications/:id/rules/remove', requireAdmin, body, requireCsrf, async (req, res) => { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; await pool.execute('DELETE FROM application_access_rules WHERE id=? AND application_id=?', [req.body.rule_id, req.params.id]); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}`)); });
router.post('/applications/:id/registration', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const userId = String(req.body.user_id ?? '').trim(); const displayName = String(req.body.display_name ?? '').trim(); if (!/^[A-Za-z0-9_.@-]{2,120}$/.test(userId) || !displayName || displayName.length > 160) return res.sendStatus(400); const [apps] = await pool.execute('SELECT id,name,client_id FROM applications WHERE id=? AND provisioning_enabled=1', [req.params.id]); const app = apps[0]; if (!app) throw new Error('该应用未启用快捷注册'); const token = randomToken(32); const id = randomUUID(); const expires = new Date(Date.now() + 15 * 60_000).toISOString(); await pool.execute("INSERT INTO quick_registration_tokens(id,application_id,token_hash,user_id,display_name,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", [id, app.id, sha256(token), userId, displayName, expires, req.admin.person.id]); const url = `${config.issuer}/register/${token}`; res.send(adminPage(req, '注册链接已生成', 'applications', `<div class="notice success-notice"><strong>链接 15 分钟内单次有效</strong><p>请发送给 ${esc(displayName)}（${esc(userId)}），密码只在统一认证中心设置。</p></div><section class="card"><div class="secret-row"><code class="secret" id="registration-url">${esc(url)}</code><button class="button secondary small" type="button" data-copy="#registration-url">复制链接</button></div><div class="card-actions"><a class="button primary" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">返回应用</a></div></section>`)); } catch (error) { next(error); } });

router.get('/people', requireAdmin, async (req, res) => {
  const [people] = await pool.execute(`SELECT p.id,p.display_name,p.grade_year,p.status,p.permanent_member,a.status account_status,a.last_login_at,d.name department,pos.name position FROM people p LEFT JOIN accounts a ON a.person_id=p.id LEFT JOIN appointments ap ON ap.person_id=p.id AND ap.status='active' LEFT JOIN departments d ON d.id=ap.department_id LEFT JOIN positions pos ON pos.id=ap.position_id ORDER BY p.permanent_member DESC,p.grade_year,p.id LIMIT 300`);
  const canEdit = hasRole(req, ['super_admin', 'personnel_admin']);
  const rows = people.map((p) => `<tr><td><strong>${esc(p.display_name)}</strong><small>${esc(p.id)}</small></td><td>${esc(p.department ?? '—')}<small>${esc(p.position ?? '未设置')}</small></td><td>${esc(p.grade_year ?? '—')}</td><td>${statusBadge(p.status)} ${p.permanent_member ? badge('永久', 'info') : ''}</td><td>${formatTime(p.last_login_at)}</td><td>${canEdit ? `<form class="row-form" method="post" action="${publicUrl(`/admin/people/${encodeURIComponent(p.id)}`)}">${csrf(req)}<select name="status">${['candidate','probation','active','retired','left','graduated','dismissed'].map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><select name="permanent_member"><option value="0" ${p.permanent_member ? '' : 'selected'}>正常</option><option value="1" ${p.permanent_member ? 'selected' : ''}>永久</option></select><button class="button ghost small">保存</button></form>` : ''}</td></tr>`).join('');
  res.send(adminPage(req, '人员与账号', 'people', `<section class="card"><div class="card-header"><div><h2>统一人员目录</h2><p>UserID 是企业微信身份和各业务系统的唯一主键</p></div><span class="count">${people.length} 人</span></div><div class="table-wrap"><table><thead><tr><th>人员</th><th>部门 / 职位</th><th>年级</th><th>状态</th><th>最近登录</th><th>管理</th></tr></thead><tbody>${rows}</tbody></table></div></section>`, '人员状态会实时影响所有接入应用'));
});

router.get('/organization', requireAdmin, async (req, res) => {
  const [[departments], [positions]] = await Promise.all([
    pool.execute(`SELECT d.id,d.name,d.status,COUNT(DISTINCT ap.person_id) member_count FROM departments d LEFT JOIN appointments ap ON ap.department_id=d.id AND ap.status='active' GROUP BY d.id ORDER BY d.name`),
    pool.execute(`SELECT p.id,p.name,p.rank_order,p.status,COUNT(DISTINCT ap.person_id) member_count FROM positions p LEFT JOIN appointments ap ON ap.position_id=p.id AND ap.status='active' GROUP BY p.id ORDER BY p.rank_order DESC,p.name`),
  ]);
  const departmentRows = departments.map((item) => `<tr><td><strong>${esc(item.name)}</strong><small>${esc(item.id)}</small></td><td>${item.member_count}</td><td>${statusBadge(item.status)}</td></tr>`).join('');
  const positionRows = positions.map((item) => `<tr><td><strong>${esc(item.name)}</strong><small>${esc(item.id)}</small></td><td>${item.rank_order}</td><td>${item.member_count}</td><td>${statusBadge(item.status)}</td></tr>`).join('');
  res.send(adminPage(req, '部门与职位', 'organization', `<div class="split-tables"><section class="table-panel"><div class="page-actions"><div><h2>部门</h2><p>当前任职人员按部门汇总</p></div></div><div class="table-wrap"><table><thead><tr><th>部门</th><th>人数</th><th>状态</th></tr></thead><tbody>${departmentRows}</tbody></table></div></section><section class="table-panel"><div class="page-actions"><div><h2>职位</h2><p>职位级别和当前人数</p></div></div><div class="table-wrap"><table><thead><tr><th>职位</th><th>级别</th><th>人数</th><th>状态</th></tr></thead><tbody>${positionRows}</tbody></table></div></section></div>`, '组织结构与人员任职分开维护'));
});

router.get('/sessions', requireAdmin, async (req, res) => {
  if (forbidUnless(req, res, ['super_admin', 'security_admin'])) return;
  const [records] = await pool.execute("SELECT id,payload,created_at,updated_at,expires_at FROM oidc_objects WHERE model='Session' ORDER BY updated_at DESC LIMIT 200");
  const sessions = records.map((record) => {
    try { return { ...record, accountId: decryptJson(JSON.parse(record.payload)).accountId ?? '—' }; } catch { return { ...record, accountId: '无法读取' }; }
  });
  const rows = sessions.map((session) => `<tr><td><strong>${esc(session.accountId)}</strong></td><td><code>${esc(session.id.slice(0, 12))}…</code></td><td>${formatTime(session.created_at)}</td><td>${formatTime(session.updated_at)}</td><td>${formatTime(session.expires_at)}</td><td><form method="post" action="${publicUrl('/admin/sessions/revoke')}">${csrf(req)}<input type="hidden" name="session_id" value="${esc(session.id)}"><button class="button danger small">注销会话</button></form></td></tr>`).join('');
  res.send(adminPage(req, '登录会话', 'sessions', `<section class="table-panel"><div class="page-actions"><div><h2>统一认证会话</h2><p>这里注销的是认证中心会话；接入应用应使用标准注销代码同步清理自己的 Session。</p></div><span class="count">${sessions.length} 条</span></div><div class="table-wrap"><table><thead><tr><th>UserID</th><th>会话</th><th>建立</th><th>最近活动</th><th>过期</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-cell">暂无有效会话</td></tr>'}</tbody></table></div></section>`, '以下时间统一按北京时间（Asia/Shanghai）显示'));
});
router.post('/sessions/revoke', requireAdmin, body, requireCsrf, async (req, res) => {
  if (forbidUnless(req, res, ['super_admin', 'security_admin'])) return;
  await pool.execute("DELETE FROM oidc_objects WHERE model='Session' AND id=?", [req.body.session_id]);
  await audit(req, 'session_revoke', 'success', { actorPersonId: req.admin.person.id, targetType: 'session', targetId: String(req.body.session_id).slice(0, 80) });
  res.redirect(publicUrl('/admin/sessions'));
});

router.get('/terms', requireAdmin, async (req, res) => {
  const [[terms], [people], [departments], [positions], [turnovers]] = await Promise.all([pool.execute('SELECT * FROM organization_terms ORDER BY starts_at DESC LIMIT 20'), pool.execute("SELECT id,display_name FROM people WHERE status IN ('active','probation','candidate','retired') ORDER BY id"), pool.execute("SELECT id,name FROM departments WHERE status='active' ORDER BY name"), pool.execute("SELECT id,name FROM positions WHERE status='active' ORDER BY rank_order DESC,name"), pool.execute('SELECT * FROM turnover_runs ORDER BY started_at DESC LIMIT 20')]);
  const canEdit = hasRole(req, ['super_admin', 'personnel_admin']);
  const termRows = terms.map((t) => `<tr><td><strong>${esc(t.name)}</strong><small>${esc(t.id)}</small></td><td>${formatTime(t.starts_at)}<small>至 ${formatTime(t.ends_at)}</small></td><td>${statusBadge(t.status)}</td><td>${canEdit ? `<div class="action-row"><form method="post" action="${publicUrl('/admin/turnovers/start')}">${csrf(req)}<input type="hidden" name="term_id" value="${esc(t.id)}"><button class="button ghost small">开始换届</button></form><form method="post" action="${publicUrl(`/admin/terms/${encodeURIComponent(t.id)}/review`)}">${csrf(req)}<button class="button ghost small">提交复核</button></form><form method="post" action="${publicUrl(`/admin/terms/${encodeURIComponent(t.id)}/publish`)}">${csrf(req)}<button class="button primary small">发布</button></form></div>` : ''}</td></tr>`).join('');
  const forms = canEdit ? `<div class="two-column"><section class="card"><div class="card-header"><div><h2>新建届次</h2><p>先建立草稿，再编制任职名单</p></div></div><form class="form-grid" method="post" action="${publicUrl('/admin/terms')}">${csrf(req)}<label>届次编号<input name="id" placeholder="term-2027-2028" required></label><label>显示名称<input name="name" placeholder="2027—2028 届" required></label><label>开始时间<input type="datetime-local" name="starts_at" required></label><label>结束时间<input type="datetime-local" name="ends_at" required></label><div class="form-actions span-2"><button class="button primary">创建草稿</button></div></form></section><section class="card"><div class="card-header"><div><h2>添加任职</h2><p>加入草稿或复核中的新届名单</p></div></div><form class="form-grid" method="post" action="${publicUrl('/admin/appointments')}">${csrf(req)}<label>人员<select name="person_id">${people.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.display_name)}</option>`).join('')}</select></label><label>届次<select name="term_id">${terms.filter((t) => ['draft','review'].includes(t.status)).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label><label>部门<select name="department_id">${departments.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><label>职位<select name="position_id">${positions.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><div class="form-actions span-2"><button class="button secondary">加入待发布名单</button></div></form></section></div>` : '';
  const turnoverRows = turnovers.map((t) => `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.target_term_id)}</td><td>${statusBadge(t.status)}</td><td>${formatTime(t.started_at)}</td><td>${formatTime(t.completed_at)}</td></tr>`).join('');
  res.send(adminPage(req, '届次与换届', 'terms', `${forms}<section class="card"><div class="card-header"><div><h2>届次</h2><p>发布新届时原子切换人员任职</p></div></div><div class="table-wrap"><table><thead><tr><th>届次</th><th>有效时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${termRows}</tbody></table></div></section><section class="card"><div class="card-header"><div><h2>换届记录</h2><p>永久人员不受自动暂停影响</p></div></div><div class="table-wrap"><table><thead><tr><th>记录 ID</th><th>目标届次</th><th>状态</th><th>开始</th><th>完成</th></tr></thead><tbody>${turnoverRows || '<tr><td colspan="5" class="empty-cell">暂无记录</td></tr>'}</tbody></table></div></section>`, '人员管理的年度附加流程'));
});

router.get('/audit', requireAdmin, async (req, res) => {
  if (forbidUnless(req, res, ['super_admin', 'security_admin', 'audit_viewer', 'application_admin'])) return;
  const [logs] = await pool.execute('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300');
  const rows = logs.map((log) => `<tr><td>${formatTime(log.created_at)}</td><td>${esc(log.event_type)}</td><td>${esc(log.actor_person_id ?? '系统')}</td><td>${esc(log.target_id ?? '—')}</td><td>${badge(log.result, log.result === 'success' ? 'success' : log.result === 'failure' ? 'danger' : 'warning')}</td><td><code>${esc(log.ip_address ?? '—')}</code></td></tr>`).join('');
  res.send(adminPage(req, '登录与审计', 'audit', `<section class="card"><div class="card-header"><div><h2>最近 300 条事件</h2><p>登录、扫码、应用访问和管理操作</p></div></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>事件</th><th>人员</th><th>目标</th><th>结果</th><th>来源 IP</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-cell">暂无记录</td></tr>'}</tbody></table></div></section>`, '以下时间统一按北京时间（Asia/Shanghai）显示'));
});

router.get('/integration', requireAdmin, (req, res) => {
  const endpoints = [['Issuer', config.issuer], ['Discovery', `${config.issuer}/.well-known/openid-configuration`], ['Authorization', `${config.issuer}/auth`], ['Token', `${config.issuer}/token`], ['UserInfo', `${config.issuer}/me`], ['Logout', `${config.issuer}/session/end`], ['JWKS', `${config.issuer}/jwks`]];
  const rows = endpoints.map(([name, url]) => `<div class="endpoint-row"><span>${name}</span><code id="ep-${name}">${esc(url)}</code><button type="button" class="button ghost small" data-copy="#ep-${name}">复制</button></div>`).join('');
  const example = `<?php\n// 必须放在业务页面第一行、任何 HTML 输出之前\nrequire_once __DIR__ . '/ESSO-DFSJ/login.php';\n\n$userId = $ssoUser['sub'];       // 唯一身份，等于企业微信 UserID\n$name = $ssoUser['name'];        // 姓名\n$department = $ssoUser['department'] ?? null;\n$position = $ssoUser['position'] ?? null;\n?>\n<a href="ESSO-DFSJ/logout.php">退出登录</a>`;
  res.send(adminPage(req, '接入文档', 'integration', `<section class="table-panel"><div class="page-actions"><div><h2>先理解认证链路</h2><p>业务系统只接 ESSO-DFSJ；ESSO 再负责密码认证、企业微信扫码、人员状态和跨系统会话。</p></div><a class="button primary" href="${publicUrl('/admin/applications/new')}">生成接入包</a></div><div class="process-table"><div><strong>1. 业务系统发起 OIDC</strong><span>未登录页面跳到 ESSO，并携带 state、nonce 和 PKCE challenge</span></div><div><strong>2. ESSO 验证身份</strong><span>用户选择密码或企业微信扫码；业务系统永远拿不到统一密码</span></div><div><strong>3. 企业微信确认 UserID</strong><span>扫码回调先校验可信域名与 state，再用临时 code 换取企业成员 UserID</span></div><div><strong>4. ESSO 返回业务系统</strong><span>一次性授权码换令牌，UserInfo 返回 sub、姓名、部门和职位</span></div><div><strong>5. 业务建立本地 Session</strong><span>login.php 保存身份并返回原页面；logout.php 同时清理两层会话</span></div></div><p class="form-note">企业微信官方资料：<a href="https://developer.work.weixin.qq.com/document/path/91022" target="_blank" rel="noopener">网页授权登录</a>、<a href="https://developer.work.weixin.qq.com/document/path/98151" target="_blank" rel="noopener">扫码授权登录</a>。业务接入者不需要配置 CorpID、AgentID 或 CorpSecret，这些只由 ESSO 管理。</p></section><section class="table-panel"><div class="page-actions"><div><h2>最简部署流程</h2><p>固定目录名 ESSO-DFSJ，不能更名。</p></div></div><div class="process-table"><div><strong>1. 填项目根地址</strong><span>例如 http://210.47.163.114/qywx/YourProject/</span></div><div><strong>2. 下载 ESSO-DFSJ.zip</strong><span>解压后把完整文件夹放入项目根目录</span></div><div><strong>3. 引入 login.php</strong><span>保护页面并通过 $ssoUser 获取当前人员信息</span></div><div><strong>4. 运行三项测试</strong><span>健康连通、真实登录、真实注销全部通过</span></div><div><strong>5. 删除两个测试文件</strong><span>验收后删除 test-login.php、test-logout.php；health.php 保留监控</span></div></div>${codeBlock('integration-example', '业务页面完整调用示例', example)}</section><section class="table-panel"><div class="page-actions"><div><h2>ESSO-DFSJ 文件说明</h2><p>接入包已写好 Client ID、密钥和所有回调地址。</p></div></div><div class="claim-list"><code>config.php</code><span>基础配置和密钥，只允许服务端读取，不提交 Git</span><code>SsoClient.php</code><span>OIDC 协议、PKCE、令牌交换和 Session 客户端</span><code>login.php</code><span>登录保护及 $ssoUser 身份信息读取</span><code>callback.php</code><span>一次性授权码回调，由 ESSO 自动调用</span><code>logout.php</code><span>清理业务 Session 并注销统一认证</span><code>health.php</code><span>签名连通检测，生产环境长期保留</span><code>test-login.php</code><span>真实登录验收，通过后可删除</span><code>test-logout.php</code><span>真实注销验收，通过后可删除</span><code>README.txt</code><span>随包部署说明和最小调用实例</span></div></section><section class="table-panel"><div class="page-actions"><div><h2>专有名词解释</h2><p>先说明 ESSO/OIDC，再说明企业微信参数。</p></div></div><div class="claim-list"><code>ESSO</code><span>本系统 Enterprise Single Sign-On 的简称</span><code>SSO</code><span>一次登录，在有效会话期内访问多个获授权系统</span><code>OIDC</code><span>建立在 OAuth 2.0 上的身份认证协议</span><code>Issuer</code><span>身份签发方地址；这里是 ESSO 基础地址</span><code>Discovery</code><span>自动公布登录、令牌、用户信息、注销和公钥地址的配置文档</span><code>Client ID</code><span>接入业务系统的公开编号</span><code>Client Secret</code><span>业务服务端凭据，不得发给浏览器或写入 Git</span><code>Redirect URI</code><span>登录完成后允许返回的精确地址</span><code>Authorization Code</code><span>短时、一次性登录凭证，服务端用它换令牌</span><code>PKCE</code><span>绑定发起登录和交换授权码的一次性校验，防止授权码被截获后滥用</span><code>state</code><span>关联请求与回调并防止 CSRF</span><code>nonce</code><span>防止身份令牌被重复使用</span><code>Claim</code><span>认证返回的身份字段</span><code>sub</code><span>稳定唯一身份，本企业等于企业微信 UserID 和学号</span><code>Session</code><span>浏览器登录状态；ESSO 与每个业务系统各自保存一层</span><code>CorpID</code><span>企业微信企业编号</span><code>AgentID</code><span>企业微信自建应用编号</span><code>可信域名</code><span>企业微信允许 OAuth 回调的精确域名</span><code>code</code><span>企业微信扫码后返回的短时一次性凭证</span><code>access_token</code><span>ESSO 服务端调用企业微信接口的凭据，绝不返回业务系统或浏览器</span><code>UserID</code><span>企业内唯一成员标识，是本系统人员主键</span></div></section><section class="table-panel"><div class="page-actions"><div><h2>OIDC 服务地址</h2><p>SDK 通过 Discovery 自动读取，通常不需要手工填写下面各项。</p></div></div><div class="endpoint-list">${rows}</div></section>`, '技术原理、名词、接入包、调用实例和验收步骤'));
});

router.post('/terms', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; const starts = parseBeijingLocalTime(req.body.starts_at); const ends = parseBeijingLocalTime(req.body.ends_at); if (starts >= ends) throw new Error('开始时间必须早于结束时间'); const now = new Date().toISOString(); await pool.execute("INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)", [req.body.id, req.body.name, starts, ends, now, now]); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/turnovers/start', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; await startTurnover(req.body.term_id, req.admin.person.id); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/terms/:id/review', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; const [result] = await pool.execute("UPDATE organization_terms SET status='review',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'", [req.params.id]); if (!result.changes) throw new Error('只有草稿届次可以提交复核'); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/terms/:id/publish', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; await publishTerm(req.params.id, req.admin.person.id); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/appointments', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; const [terms] = await pool.execute("SELECT starts_at,ends_at FROM organization_terms WHERE id=? AND status IN ('draft','review')", [req.body.term_id]); if (!terms[0]) throw new Error('请选择草稿或复核中的届次'); const now = new Date().toISOString(); await pool.execute("INSERT INTO appointments(id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,'pending',?,?)", [randomUUID(), req.body.person_id, req.body.term_id, req.body.department_id, req.body.position_id, terms[0].starts_at, terms[0].ends_at, now, now]); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/people/:id', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; const allowed = new Set(['candidate','probation','active','retired','left','graduated','dismissed']); if (!allowed.has(req.body.status) || !['0','1'].includes(req.body.permanent_member)) return res.sendStatus(400); if (req.params.id === req.admin.person.id && req.body.status !== 'active') throw new Error('不能停用当前登录账号'); await pool.execute("UPDATE people SET status=?,permanent_member=?,authorization_version=authorization_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [req.body.status, Number(req.body.permanent_member), req.params.id]); res.redirect(publicUrl('/admin/people')); } catch (error) { next(error); } });

export const adminRouter = router;
