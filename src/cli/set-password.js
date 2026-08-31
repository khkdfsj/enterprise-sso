import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { hashPassword } from '../security/password.js';

const userId = String(process.env.USER_ID ?? '').trim();
const password = process.env.NEW_PASSWORD;
if (!userId || !password) throw new Error('USER_ID and NEW_PASSWORD are required');
const passwordHash = await hashPassword(password);
await withTransaction(async (connection) => {
  const [people] = await connection.execute('SELECT id FROM people WHERE id=? LIMIT 1', [userId]);
  if (!people[0]) throw new Error('UserID was not found');
  const [accounts] = await connection.execute('SELECT id FROM accounts WHERE person_id=? LIMIT 1', [userId]);
  const accountId = accounts[0]?.id ?? randomUUID();
  if (!accounts[0]) {
    await connection.execute(
      "INSERT INTO accounts(id,person_id,username,status,created_at,updated_at) VALUES (?,?,?,'active',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      [accountId, userId, userId.toLowerCase()],
    );
  }
  await connection.execute(
    `INSERT INTO password_credentials(account_id,password_hash,must_change_password,changed_at)
     VALUES (?,?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(account_id) DO UPDATE SET password_hash=excluded.password_hash,password_version=password_version+1,
       must_change_password=1,changed_at=excluded.changed_at`,
    [accountId, passwordHash],
  );
  await connection.execute(
    "UPDATE accounts SET status='active',failed_attempts=0,locked_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    [accountId],
  );
});
console.log(JSON.stringify({ ok: true, user_id: userId, must_change_password: true }, null, 2));
await pool.end();
