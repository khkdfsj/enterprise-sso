import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { SqliteOidcAdapter } from '../oidc/sqlite-adapter.js';
import { hashPassword } from '../security/password.js';

if (config.production) throw new Error('Development seed cannot run in production');

const userId = process.env.DEV_ADMIN_USERID ?? 'dev-admin';
const username = process.env.DEV_ADMIN_USERNAME ?? userId;
const password = process.env.DEV_ADMIN_PASSWORD;
const clientId = process.env.DEV_CLIENT_ID ?? 'demo-app';
const clientSecret = process.env.DEV_CLIENT_SECRET;
const redirectUri = process.env.DEV_REDIRECT_URI ?? 'http://127.0.0.1:8080/callback';

if (!password || password === 'replace-before-use') throw new Error('Set DEV_ADMIN_PASSWORD before seeding');
if (!clientSecret || clientSecret === 'replace-before-use') throw new Error('Set DEV_CLIENT_SECRET before seeding');

const personId = userId;
const accountId = randomUUID();
const applicationId = randomUUID();
const passwordHash = await hashPassword(password);
const clientSecretHash = await hashPassword(clientSecret);
const now = new Date();

await withTransaction(async (connection) => {
  await connection.execute(
    `INSERT INTO people(id,employee_no,display_name,status,created_at,updated_at)
     VALUES (?,?,?,'active',?,?)`,
    [personId, username, '开发管理员', now, now],
  );
  await connection.execute(
    `INSERT INTO accounts(id,person_id,username,status,created_at,updated_at)
     VALUES (?,?,?,'active',?,?)`,
    [accountId, personId, username.toLowerCase(), now, now],
  );
  await connection.execute(
    `INSERT INTO password_credentials(account_id,password_hash,changed_at)
     VALUES (?,?,?)`,
    [accountId, passwordHash, now],
  );
  await connection.execute(
    `INSERT INTO applications(id,client_id,name,client_secret_hash,access_mode,status,created_at,updated_at)
     VALUES (?,?,?,?,'all_active','active',?,?)`,
    [applicationId, clientId, 'OIDC 开发测试应用', clientSecretHash, now, now],
  );
  await connection.execute(
    `INSERT INTO application_redirect_uris(application_id,redirect_uri,created_at) VALUES (?,?,?)`,
    [applicationId, redirectUri, now],
  );
  await connection.execute(
    "INSERT INTO system_role_assignments(person_id,role,status,starts_at,created_at) VALUES (?,'super_admin','active',?,?)",
    [personId, now, now],
  );
});

await new SqliteOidcAdapter('Client').upsert(clientId, {
  client_id: clientId,
  client_secret: clientSecret,
  client_name: 'OIDC 开发测试应用',
  redirect_uris: [redirectUri],
  post_logout_redirect_uris: [redirectUri],
  response_types: ['code'],
  grant_types: ['authorization_code'],
  token_endpoint_auth_method: 'client_secret_post',
  id_token_signed_response_alg: 'ES256',
}, undefined);

console.log(JSON.stringify({ personId, accountId, applicationId, clientId, redirectUri }, null, 2));
await pool.end();
