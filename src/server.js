import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import QRCode from 'qrcode';
import { config } from './config.js';
import { checkDatabase, pool } from './db.js';
import { createProvider } from './oidc/provider.js';
import { authenticatePassword, findPersonByWecom } from './repositories/accounts.js';
import { canAccessApplication } from './repositories/applications.js';
import { audit } from './repositories/audit.js';
import { consumeCsrf, issueCsrf } from './repositories/interactions.js';
import {
  approveTransaction,
  consumeApprovedTransaction,
  createWecomTransaction,
  denyTransaction,
  findTransactionByState,
  readTransactionStatus,
  validateMobileTransaction,
} from './repositories/wecom-transactions.js';
import { buildWecomAuthorizeUrl, resolveWecomUser } from './services/wecom.js';
import { activateScheduledTerms } from './services/terms.js';
import { ensureSystemAdminClient } from './services/system-admin-client.js';
import { runDueApplicationChecks } from './services/application-monitor.js';
import { loginPage, messagePage, qrPage } from './views/html.js';
import { adminRouter } from './admin/router.js';
import { provisioningRouter } from './provisioning/router.js';
import { publicUrl } from './public-url.js';

const here = path.dirname(fileURLToPath(import.meta.url));
await ensureSystemAdminClient();
const provider = await createProvider();
const app = express();
const router = express.Router();

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(helmet({ contentSecurityPolicy: false, strictTransportSecurity: false }));
router.use('/assets', express.static(path.resolve(here, '../public'), {
  immutable: true,
  maxAge: '1h',
  fallthrough: false,
}));
const formBody = express.urlencoded({ extended: false, limit: '32kb' });
const jsonBody = express.json({ limit: '32kb' });

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: '请求过于频繁，请稍后再试。',
});

async function interactionContext(req, res) {
  const details = await provider.interactionDetails(req, res);
  if (details.uid !== req.params.uid) throw new Error('Interaction mismatch');
  const client = await provider.Client.find(details.params.client_id);
  if (!client) throw new Error('Unknown client');
  return {
    details,
    client,
    appName: client.clientName ?? client.clientId,
  };
}

async function finishConsent(req, res, details) {
  const { prompt, params, session } = details;
  if (!session?.accountId || !(await canAccessApplication(session.accountId, params.client_id))) {
    await audit(req, 'application_access', 'denied', {
      actorPersonId: session?.accountId ?? null,
      targetType: 'application',
      targetId: params.client_id,
    });
    return provider.interactionFinished(req, res, {
      error: 'access_denied',
      error_description: '当前账号无权访问该应用',
    }, { mergeWithLastSubmission: false });
  }

  let { grantId } = details;
  let grant = grantId ? await provider.Grant.find(grantId) : undefined;
  if (!grant) {
    grant = new provider.Grant({ accountId: session.accountId, clientId: params.client_id });
  }
  if (prompt.details.missingOIDCScope) grant.addOIDCScope(prompt.details.missingOIDCScope.join(' '));
  if (prompt.details.missingOIDCClaims) grant.addOIDCClaims(prompt.details.missingOIDCClaims);
  if (prompt.details.missingResourceScopes) {
    for (const [indicator, scopes] of Object.entries(prompt.details.missingResourceScopes)) {
      grant.addResourceScope(indicator, scopes.join(' '));
    }
  }
  const savedGrantId = await grant.save();
  const consent = details.grantId ? {} : { grantId: savedGrantId };
  await audit(req, 'application_access', 'success', {
    actorPersonId: session.accountId,
    targetType: 'application',
    targetId: params.client_id,
  });
  return provider.interactionFinished(req, res, { consent }, { mergeWithLastSubmission: true });
}

async function finishAccessCheck(req, res, details) {
  const personId = details.session?.accountId;
  const clientId = details.params.client_id;
  if (!personId || !(await canAccessApplication(personId, clientId))) {
    await audit(req, 'application_access', 'denied', {
      actorPersonId: personId ?? null,
      targetType: 'application',
      targetId: clientId,
    });
    return provider.interactionFinished(req, res, {
      error: 'access_denied',
      error_description: '当前账号无权访问该应用',
    }, { mergeWithLastSubmission: false });
  }
  await audit(req, 'application_access', 'success', {
    actorPersonId: personId,
    targetType: 'application',
    targetId: clientId,
  });
  return provider.interactionFinished(req, res, {
    access: { checkedAt: Math.floor(Date.now() / 1000) },
  }, { mergeWithLastSubmission: true });
}

router.get('/healthz', async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

router.get('/', (_req, res) => res.redirect(publicUrl('/.well-known/openid-configuration')));
router.use('/admin', noStore, adminRouter);
router.use(noStore, provisioningRouter);

router.get('/interaction/:uid', noStore, async (req, res, next) => {
  try {
    const { details, appName } = await interactionContext(req, res);
    if (details.prompt.name === 'access') return await finishAccessCheck(req, res, details);
    if (details.prompt.name === 'consent') return await finishConsent(req, res, details);
    if (details.prompt.name !== 'login') {
      return await provider.interactionFinished(req, res, {
        error: 'interaction_required',
        error_description: '不支持的认证交互',
      }, { mergeWithLastSubmission: false });
    }
    const csrf = await issueCsrf(details.uid);
    res.type('html').send(loginPage({ uid: details.uid, appName, csrf, wecomEnabled: config.wecom.enabled }));
  } catch (error) {
    next(error);
  }
});

router.post('/interaction/:uid/password', noStore, loginLimiter, formBody, async (req, res, next) => {
  try {
    const { details, appName } = await interactionContext(req, res);
    if (details.prompt.name !== 'login' || !(await consumeCsrf(details.uid, req.body.csrf))) {
      return res.status(400).type('html').send(messagePage('请求已失效', '请返回登录页面后重新尝试。'));
    }
    const result = await authenticatePassword(req.body.username, req.body.password);
    if (!result.ok) {
      await audit(req, 'password_login', 'failure', { detail: { reason: result.reason } });
      const csrf = await issueCsrf(details.uid);
      const error = result.reason === 'temporarily_locked'
        ? '登录失败次数过多，请稍后再试。'
        : '账号或密码错误。';
      return res.status(401).type('html').send(loginPage({
        uid: details.uid,
        appName,
        csrf,
        username: req.body.username,
        error,
        wecomEnabled: config.wecom.enabled,
      }));
    }
    if (!(await canAccessApplication(result.personId, details.params.client_id))) {
      await audit(req, 'application_access', 'denied', {
        actorPersonId: result.personId,
        targetType: 'application',
        targetId: details.params.client_id,
      });
      return provider.interactionFinished(req, res, {
        error: 'access_denied',
        error_description: '当前账号无权访问该应用',
      }, { mergeWithLastSubmission: false });
    }
    await audit(req, 'password_login', 'success', { actorPersonId: result.personId });
    return provider.interactionFinished(req, res, {
      login: { accountId: result.personId, acr: 'urn:enterprise:acr:password', ts: Math.floor(Date.now() / 1000) },
    }, { mergeWithLastSubmission: false });
  } catch (error) {
    next(error);
  }
});

router.post('/interaction/:uid/wecom/start', noStore, loginLimiter, formBody, async (req, res, next) => {
  try {
    const { details, appName } = await interactionContext(req, res);
    if (!config.wecom.enabled) {
      return res.status(503).type('html').send(messagePage('扫码登录暂不可用', '企业微信登录尚未配置。'));
    }
    if (details.prompt.name !== 'login' || !(await consumeCsrf(details.uid, req.body.csrf))) {
      return res.status(400).type('html').send(messagePage('请求已失效', '请返回登录页面后重新尝试。'));
    }
    const transaction = await createWecomTransaction(details.uid);
    const mobileUrl = new URL(config.wecom.qrEntryUrl || `${config.issuer}/wecom/mobile`);
    mobileUrl.searchParams.set('transaction_id', transaction.id);
    mobileUrl.searchParams.set('state', transaction.oauthState);
    const qrSvg = await QRCode.toString(mobileUrl.toString(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    const csrf = await issueCsrf(details.uid);
    res.type('html').send(qrPage({ uid: details.uid, appName, csrf, transaction, qrSvg }));
  } catch (error) {
    next(error);
  }
});

router.post('/interaction/:uid/wecom/status', noStore, jsonBody, async (req, res, next) => {
  try {
    const { details } = await interactionContext(req, res);
    const status = await readTransactionStatus(
      req.body.transaction_id,
      req.body.browser_secret,
      details.uid,
    );
    if (!status) return res.status(404).json({ status: 'unknown' });
    res.json(status);
  } catch (error) {
    next(error);
  }
});

router.post('/interaction/:uid/wecom/complete', noStore, loginLimiter, formBody, async (req, res, next) => {
  try {
    const { details } = await interactionContext(req, res);
    if (details.prompt.name !== 'login' || !(await consumeCsrf(details.uid, req.body.csrf))) {
      return res.status(400).type('html').send(messagePage('请求已失效', '请重新扫码。'));
    }
    const personId = await consumeApprovedTransaction(
      req.body.transaction_id,
      req.body.browser_secret,
      details.uid,
    );
    if (!personId) return res.status(400).type('html').send(messagePage('扫码已失效', '请返回并重新扫码。'));
    if (!(await canAccessApplication(personId, details.params.client_id))) {
      await audit(req, 'application_access', 'denied', {
        actorPersonId: personId,
        targetType: 'application',
        targetId: details.params.client_id,
      });
      return provider.interactionFinished(req, res, {
        error: 'access_denied',
        error_description: '当前账号无权访问该应用',
      }, { mergeWithLastSubmission: false });
    }
    await audit(req, 'wecom_login', 'success', { actorPersonId: personId });
    return provider.interactionFinished(req, res, {
      login: { accountId: personId, acr: 'urn:enterprise:acr:wecom', ts: Math.floor(Date.now() / 1000) },
    }, { mergeWithLastSubmission: false });
  } catch (error) {
    next(error);
  }
});

router.get('/wecom/mobile', noStore, async (req, res) => {
  try {
    const valid = await validateMobileTransaction(req.query.transaction_id, req.query.state);
    if (!valid) return res.status(400).type('html').send(messagePage('二维码已失效', '请返回电脑端重新获取二维码。'));
    return res.redirect(buildWecomAuthorizeUrl(req.query.state));
  } catch {
    return res.status(503).type('html').send(messagePage('扫码登录暂不可用', '企业微信登录尚未配置或服务暂时不可用。'));
  }
});

router.get('/wecom/callback', noStore, async (req, res) => {
  const transaction = await findTransactionByState(req.query.state);
  if (!transaction || !req.query.code) {
    return res.status(400).type('html').send(messagePage('验证失败', '二维码已失效，请返回电脑端重试。'));
  }
  try {
    const wecomUserId = await resolveWecomUser(req.query.code);
    const personId = await findPersonByWecom(config.wecom.corpId, wecomUserId);
    if (!personId) {
      await denyTransaction(transaction.id);
      await audit(req, 'wecom_login', 'denied', { detail: { reason: 'identity_not_bound' } });
      return res.status(403).type('html').send(messagePage('暂不能登录', '当前企业微信账号尚未绑定统一认证账号。'));
    }
    await approveTransaction(transaction.id, personId);
    await audit(req, 'wecom_scan', 'success', { actorPersonId: personId });
    return res.type('html').send(messagePage('验证成功', '请返回电脑端，页面将自动完成登录。'));
  } catch (error) {
    await denyTransaction(transaction.id);
    await audit(req, 'wecom_login', 'failure', { detail: { reason: error.message.slice(0, 120) } });
    return res.status(502).type('html').send(messagePage('企业微信验证失败', '请返回电脑端重新尝试。'));
  }
});

router.use(provider.callback());

router.use((error, req, res, _next) => {
  console.error('request failed', { method: req.method, path: req.path, message: error.message });
  if (res.headersSent) return;
  res.status(500).type('html').send(messagePage('服务暂时不可用', '请稍后重试。'));
});

app.use(config.publicBasePath || '/', router);

const server = app.listen(config.port, config.host, () => {
  console.log(`Enterprise SSO listening on ${config.host}:${config.port}; issuer=${config.issuer}`);
});
const termActivationTimer = setInterval(() => {
  activateScheduledTerms().catch((error) => console.error('scheduled term activation failed', { message: error.message }));
}, 30_000);
termActivationTimer.unref();
const applicationMonitorTimer = setInterval(() => {
  runDueApplicationChecks().catch((error) => console.error('application connectivity monitor failed', { message: error.message }));
}, 30_000);
applicationMonitorTimer.unref();

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  clearInterval(termActivationTimer);
  clearInterval(applicationMonitorTimer);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
