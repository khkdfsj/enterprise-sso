import { pool, withTransaction } from '../db.js';
import { verifyPassword } from '../security/password.js';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export async function authenticatePassword(username, password) {
  const normalized = String(username ?? '').trim().toLowerCase();
  if (!normalized || !password) return { ok: false, reason: 'invalid_credentials' };

  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT a.id account_id,a.person_id,a.status account_status,a.failed_attempts,a.locked_until,
              p.status person_status,pc.password_hash
       FROM accounts a
       JOIN people p ON p.id=a.person_id
       JOIN password_credentials pc ON pc.account_id=a.id
       WHERE a.username=?`,
      [normalized],
    );
    const account = rows[0];
    if (!account) return { ok: false, reason: 'invalid_credentials' };
    if (account.account_status !== 'active' || !['active', 'probation'].includes(account.person_status)) {
      return { ok: false, reason: 'account_unavailable' };
    }
    if (account.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
      return { ok: false, reason: 'temporarily_locked' };
    }

    const valid = await verifyPassword(account.password_hash, password);
    if (!valid) {
      const attempts = Number(account.failed_attempts) + 1;
      const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
        : null;
      await connection.execute(
        "UPDATE accounts SET failed_attempts=?,locked_until=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        [attempts >= MAX_FAILED_ATTEMPTS ? 0 : attempts, lockedUntil, account.account_id],
      );
      return { ok: false, reason: lockedUntil ? 'temporarily_locked' : 'invalid_credentials' };
    }

    await connection.execute(
      "UPDATE accounts SET failed_attempts=0,locked_until=NULL,last_login_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      [account.account_id],
    );
    return { ok: true, personId: account.person_id, accountId: account.account_id };
  });
}

export async function findAccountClaims(personId) {
  const [rows] = await pool.execute(
    `SELECT p.id,p.employee_no,p.display_name,p.status,p.authorization_version,a.username,a.status account_status,
            d.id department_id,d.name department_name,pos.id position_id,pos.name position_name
     FROM people p
     JOIN accounts a ON a.person_id=p.id
     LEFT JOIN appointments ap ON ap.person_id=p.id AND ap.status='active'
       AND ap.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ap.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     LEFT JOIN departments d ON d.id=ap.department_id
     LEFT JOIN positions pos ON pos.id=ap.position_id
     WHERE p.id=?
     ORDER BY ap.is_primary DESC, pos.rank_order DESC
     LIMIT 1`,
    [personId],
  );
  const row = rows[0];
  if (!row || row.account_status !== 'active' || !['active', 'probation'].includes(row.status)) return undefined;
  return row;
}

export async function findPersonByWecom(corpId, wecomUserId) {
  const [rows] = await pool.execute(
    `SELECT p.id
     FROM wecom_identities wi
     JOIN people p ON p.id=wi.person_id
     JOIN accounts a ON a.person_id=p.id
     WHERE wi.corp_id=? AND wi.wecom_userid=? AND wi.status='active'
       AND a.status='active' AND p.status IN ('active','probation') LIMIT 1`,
    [corpId, wecomUserId],
  );
  return rows[0]?.id;
}
