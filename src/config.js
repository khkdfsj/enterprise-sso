import 'dotenv/config';
import path from 'node:path';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function integer(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid positive integer environment variable: ${name}`);
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = Object.freeze({
  nodeEnv,
  production: nodeEnv === 'production',
  host: process.env.HOST ?? '127.0.0.1',
  port: integer('PORT', 3000),
  issuer: required('ISSUER', 'http://127.0.0.1:3000').replace(/\/$/, ''),
  trustProxy: process.env.TRUST_PROXY ?? 'loopback',
  internalHttpRedirectHosts: new Set(String(process.env.INTERNAL_HTTP_REDIRECT_HOSTS ?? '').split(',').map((v) => v.trim()).filter(Boolean)),
  db: {
    file: path.resolve(required('DB_FILE', './runtime/enterprise-sso.sqlite3')),
  },
  cookieKeys: required('COOKIE_KEYS', 'development-cookie-key-one,development-cookie-key-two').split(',').map((v) => v.trim()).filter(Boolean),
  jwksFile: path.resolve(required('OIDC_JWKS_FILE', './runtime/jwks.json')),
  oidcStorageKey: required('OIDC_STORAGE_KEY', 'development-oidc-storage-key'),
  passwordPepper: required('PASSWORD_PEPPER', 'development-password-pepper'),
  ttl: {
    sessionIdle: integer('SSO_IDLE_TTL_SECONDS', 7200),
    session: integer('SSO_ABSOLUTE_TTL_SECONDS', 28800),
    authorizationCode: integer('AUTH_CODE_TTL_SECONDS', 60),
    wecomTransaction: integer('WE_COM_TRANSACTION_TTL_SECONDS', 120),
  },
  wecom: {
    corpId: process.env.WECOM_CORP_ID ?? '',
    agentId: process.env.WECOM_AGENT_ID ?? '',
    corpSecret: process.env.WECOM_CORP_SECRET ?? '',
    accessTokenUrl: process.env.WECOM_ACCESS_TOKEN_URL ?? '',
    scope: process.env.WECOM_OAUTH_SCOPE ?? 'snsapi_base',
    enabled: Boolean(
      process.env.WECOM_CORP_ID
      && process.env.WECOM_AGENT_ID
      && (process.env.WECOM_CORP_SECRET || process.env.WECOM_ACCESS_TOKEN_URL)
    ),
  },
});

if (config.production) {
  if (!config.issuer.startsWith('https://')) throw new Error('Production ISSUER must use HTTPS');
  if (config.cookieKeys.length < 2 || config.cookieKeys.some((v) => v.length < 32)) throw new Error('Production COOKIE_KEYS must contain at least two 32+ character values');
  if (config.passwordPepper.length < 32) throw new Error('Production PASSWORD_PEPPER must be at least 32 characters');
  if (config.oidcStorageKey.length < 32) throw new Error('Production OIDC_STORAGE_KEY must be at least 32 characters');
}

if (config.ttl.sessionIdle > config.ttl.session) {
  throw new Error('SSO_IDLE_TTL_SECONDS cannot exceed SSO_ABSOLUTE_TTL_SECONDS');
}
