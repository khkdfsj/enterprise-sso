import { createHash, randomBytes } from 'node:crypto';

const issuer = (process.env.E2E_ISSUER ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const clientId = process.env.E2E_CLIENT_ID ?? 'demo-app';
const clientSecret = process.env.E2E_CLIENT_SECRET;
const username = process.env.E2E_USERNAME ?? 'admin';
const password = process.env.E2E_PASSWORD;
const redirectUri = process.env.E2E_REDIRECT_URI ?? 'http://127.0.0.1:8080/callback';

if (!clientSecret || !password) throw new Error('Set E2E_CLIENT_SECRET and E2E_PASSWORD');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/enterprise-sso)?$/i.test(issuer)) {
  throw new Error('This destructive-login test is limited to a loopback issuer');
}

const cookies = new Map();
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(24).toString('base64url');
const nonce = randomBytes(24).toString('base64url');

function storeCookies(response) {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';', 1)[0];
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookies.size) headers.set('Cookie', cookieHeader());
  const response = await fetch(url, { ...options, headers, redirect: 'manual' });
  storeCookies(response);
  return response;
}

function nextUrl(current, response) {
  const location = response.headers.get('location');
  if (!location) throw new Error(`Expected redirect from ${current}, got ${response.status}`);
  return new URL(location, current).toString();
}

const auth = new URL(`${issuer}/auth`);
for (const [key, value] of Object.entries({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'openid profile enterprise',
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: 'S256',
})) auth.searchParams.set(key, value);

let response = await request(auth);
let current = nextUrl(auth, response);
response = await request(current);
const loginHtml = await response.text();
if (response.status !== 200 || !loginHtml.includes('部门统一身份认证')) throw new Error('Hosted login page was not rendered');
const csrf = loginHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
if (!csrf) throw new Error('Hosted login did not contain CSRF token');
const interaction = new URL(current);
const passwordUrl = new URL(`${interaction.pathname}/password`, interaction.origin).toString();

response = await request(passwordUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrf, username, password }),
});
current = nextUrl(passwordUrl, response);

for (let redirects = 0; redirects < 8 && !current.startsWith(redirectUri); redirects += 1) {
  response = await request(current);
  current = nextUrl(current, response);
}
if (!current.startsWith(redirectUri)) throw new Error('Authorization did not return to the client');
const callback = new URL(current);
if (callback.searchParams.get('state') !== state) throw new Error('OIDC state mismatch');
const code = callback.searchParams.get('code');
if (!code) throw new Error(`Authorization failed: ${callback.searchParams.get('error') ?? 'missing code'}`);

response = await fetch(`${issuer}/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: verifier,
  }),
});
const token = await response.json();
if (!response.ok || !token.access_token || !token.id_token) throw new Error(`Token exchange failed: ${JSON.stringify(token)}`);

response = await fetch(`${issuer}/me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
const user = await response.json();
if (!response.ok || !user.sub || user.preferred_username !== username) {
  throw new Error(`UserInfo validation failed: ${JSON.stringify(user)}`);
}

const ssoVerifier = randomBytes(48).toString('base64url');
const ssoState = randomBytes(24).toString('base64url');
const ssoAuth = new URL(`${issuer}/auth`);
for (const [key, value] of Object.entries({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'openid profile enterprise',
  state: ssoState,
  nonce: randomBytes(24).toString('base64url'),
  code_challenge: createHash('sha256').update(ssoVerifier).digest('base64url'),
  code_challenge_method: 'S256',
})) ssoAuth.searchParams.set(key, value);

response = await request(ssoAuth);
current = nextUrl(ssoAuth, response);
for (let redirects = 0; redirects < 8 && !current.startsWith(redirectUri); redirects += 1) {
  response = await request(current);
  if (response.status === 200) throw new Error('Existing SSO session unexpectedly requested another login page');
  current = nextUrl(current, response);
}
const ssoCallback = new URL(current);
if (ssoCallback.searchParams.get('state') !== ssoState || !ssoCallback.searchParams.get('code')) {
  throw new Error('Existing SSO session did not complete a fresh authorization check');
}

let dynamicAccess = 'not_tested';
if (process.env.E2E_DB_FILE) {
  if (!/e2e/i.test(process.env.E2E_DB_FILE)) throw new Error('E2E_DB_FILE must contain e2e');
  const { DatabaseSync } = await import('node:sqlite');
  const testDatabase = new DatabaseSync(process.env.E2E_DB_FILE, { timeout: 5000 });
  testDatabase.prepare("UPDATE applications SET status='disabled' WHERE client_id=?").run(clientId);
  try {
    const deniedState = randomBytes(24).toString('base64url');
    const deniedVerifier = randomBytes(48).toString('base64url');
    const deniedAuth = new URL(`${issuer}/auth`);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile enterprise',
      state: deniedState,
      nonce: randomBytes(24).toString('base64url'),
      code_challenge: createHash('sha256').update(deniedVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    })) deniedAuth.searchParams.set(key, value);
    response = await request(deniedAuth);
    current = nextUrl(deniedAuth, response);
    for (let redirects = 0; redirects < 8 && !current.startsWith(redirectUri); redirects += 1) {
      response = await request(current);
      current = nextUrl(current, response);
    }
    const deniedCallback = new URL(current);
    if (deniedCallback.searchParams.get('state') !== deniedState || deniedCallback.searchParams.get('error') !== 'access_denied') {
      throw new Error('Disabled application was not denied during an existing SSO session');
    }
    dynamicAccess = 'revoked_without_reauthentication';
  } finally {
    testDatabase.prepare("UPDATE applications SET status='active' WHERE client_id=?").run(clientId);
    testDatabase.close();
  }
}

console.log(JSON.stringify({
  ok: true,
  flow: 'authorization_code_pkce_password',
  sso_reauthentication: 'session_without_password_after_fresh_access_check',
  dynamic_access_revocation: dynamicAccess,
  subject: user.sub,
  preferred_username: user.preferred_username,
  scope: token.scope,
}, null, 2));
