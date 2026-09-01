import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { encryptJson } from '../security/crypto.js';
import { hashPassword } from '../security/password.js';

export const ADMIN_CLIENT_ID = 'enterprise-sso-admin';
export const ADMIN_APPLICATION_ID = 'system-enterprise-sso-admin';

export function adminClientSecret() {
  return createHmac('sha256', config.oidcStorageKey)
    .update('enterprise-sso-admin-client-v1')
    .digest('base64url');
}

export function adminCallbackUrl() {
  return `${config.issuer}/admin/callback`;
}

export function adminLoggedOutUrl() {
  return `${config.issuer}/admin/logged-out`;
}

export async function ensureSystemAdminClient() {
  const now = new Date().toISOString();
  const secret = adminClientSecret();
  const callback = adminCallbackUrl();
  const loggedOut = adminLoggedOutUrl();
  const payload = {
    client_id: ADMIN_CLIENT_ID,
    client_secret: secret,
    client_name: '统一认证管理后台',
    redirect_uris: [callback],
    post_logout_redirect_uris: [loggedOut],
    response_types: ['code'],
    grant_types: ['authorization_code'],
    token_endpoint_auth_method: 'client_secret_post',
    id_token_signed_response_alg: 'ES256',
  };
  const [existing] = await pool.execute('SELECT id FROM applications WHERE client_id=?', [ADMIN_CLIENT_ID]);
  const hash = existing[0] ? null : await hashPassword(secret);
  await withTransaction(async (connection) => {
    if (!existing[0]) {
      await connection.execute(
        `INSERT INTO applications
          (id,client_id,name,description,client_secret_hash,access_mode,status,integration_status,home_url,created_at,updated_at)
         VALUES (?,?,?,'系统内置管理客户端',?,'all_active','active','ready',?,?,?)`,
        [ADMIN_APPLICATION_ID, ADMIN_CLIENT_ID, '统一认证管理后台', hash, `${config.issuer}/admin`, now, now],
      );
      await connection.execute(
        'INSERT INTO application_redirect_uris(application_id,redirect_uri,created_at) VALUES (?,?,?)',
        [ADMIN_APPLICATION_ID, callback, now],
      );
    }
    await connection.execute(
      `INSERT INTO oidc_objects(model,id,payload,created_at,updated_at)
       VALUES ('Client',?,?,?,?)
       ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`,
      [ADMIN_CLIENT_ID, JSON.stringify(encryptJson(payload)), now, now],
    );
  });
}
