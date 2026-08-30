import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { hashPassword } from '../security/password.js';

const username = String(process.env.ADMIN_USERNAME ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const displayName = String(process.env.ADMIN_DISPLAY_NAME ?? '').trim();
const employeeNo = String(process.env.ADMIN_EMPLOYEE_NO ?? username).trim();
const wecomUserId = String(process.env.ADMIN_WECOM_USERID ?? '').trim();
if (!username || !password || !displayName) throw new Error('ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_DISPLAY_NAME are required');

const passwordHash = await hashPassword(password);
const personId = randomUUID();
const accountId = randomUUID();
const now = new Date();

await withTransaction(async (connection) => {
  const [existing] = await connection.execute(
    "SELECT 1 FROM system_role_assignments WHERE role='super_admin' AND status='active' LIMIT 1",
  );
  if (existing[0]) throw new Error('An active super administrator already exists');
  await connection.execute(
    "INSERT INTO people(id,employee_no,display_name,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)",
    [personId, employeeNo || null, displayName, now, now],
  );
  await connection.execute(
    "INSERT INTO accounts(id,person_id,username,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)",
    [accountId, personId, username, now, now],
  );
  await connection.execute(
    'INSERT INTO password_credentials(account_id,password_hash,changed_at) VALUES (?,?,?)',
    [accountId, passwordHash, now],
  );
  if (wecomUserId) {
    if (!config.wecom.corpId) throw new Error('WECOM_CORP_ID must be configured before binding an administrator');
    await connection.execute(
      "INSERT INTO wecom_identities(person_id,corp_id,wecom_userid,status,bound_at) VALUES (?,?,?,'active',?)",
      [personId, config.wecom.corpId, wecomUserId, now],
    );
  }
  await connection.execute(
    "INSERT INTO system_role_assignments(person_id,role,status,starts_at,created_at) VALUES (?,'super_admin','active',?,?)",
    [personId, now, now],
  );
});

console.log(JSON.stringify({ person_id: personId, account_id: accountId, username, role: 'super_admin' }, null, 2));
await pool.end();
