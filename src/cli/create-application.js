import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { encryptJson, randomToken } from '../security/crypto.js';
import { hashPassword } from '../security/password.js';

const name = String(process.env.APP_NAME ?? '').trim();
const redirectUri = String(process.env.APP_REDIRECT_URI ?? '').trim();
const clientId = String(process.env.APP_CLIENT_ID ?? `app_${randomToken(18)}`).trim();
const clientSecret = randomToken(48);
const accessMode = process.env.APP_ACCESS_MODE === 'all_active' ? 'all_active' : 'rules';

if (!name || name.length > 180) throw new Error('APP_NAME is required and must not exceed 180 characters');
if (!/^https:\/\//i.test(redirectUri)) {
  const developmentLoopback = !config.production && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(redirectUri);
  if (!developmentLoopback) throw new Error('APP_REDIRECT_URI must use HTTPS (development loopback HTTP is allowed)');
}
if (!/^[A-Za-z0-9._~-]{3,120}$/.test(clientId)) throw new Error('APP_CLIENT_ID contains unsupported characters');

const applicationId = randomUUID();
const secretHash = await hashPassword(clientSecret);
const clientPayload = {
  client_id: clientId,
  client_secret: clientSecret,
  client_name: name,
  redirect_uris: [redirectUri],
  response_types: ['code'],
  grant_types: ['authorization_code'],
  token_endpoint_auth_method: 'client_secret_post',
  id_token_signed_response_alg: 'ES256',
};
const now = new Date();

await withTransaction(async (connection) => {
  await connection.execute(
    `INSERT INTO applications(id,client_id,name,client_secret_hash,access_mode,status,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?)`,
    [applicationId, clientId, name, secretHash, accessMode, now, now],
  );
  await connection.execute(
    'INSERT INTO application_redirect_uris(application_id,redirect_uri,created_at) VALUES (?,?,?)',
    [applicationId, redirectUri, now],
  );
  await connection.execute(
    `INSERT INTO oidc_objects(model,id,payload,created_at,updated_at)
     VALUES ('Client',?,?,?,?)`,
    [clientId, JSON.stringify(encryptJson(clientPayload)), now, now],
  );
});

console.log(JSON.stringify({
  application_id: applicationId,
  name,
  client_id: clientId,
  client_secret: clientSecret,
  redirect_uri: redirectUri,
  access_mode: accessMode,
  warning: 'client_secret is shown only now; store it in the application secret configuration',
}, null, 2));
await pool.end();
