import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db.js';

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function requirePersonnelAdmin(connection, personId) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM system_role_assignments
     WHERE person_id=? AND role IN ('super_admin','personnel_admin') AND status='active'
       AND (starts_at IS NULL OR starts_at<=${nowSql})
       AND (ends_at IS NULL OR ends_at>${nowSql}) LIMIT 1`,
    [personId],
  );
  if (!rows[0]) throw new Error('Personnel administration permission is required');
}

export async function startTurnover(termId, actorPersonId) {
  return withTransaction(async (connection) => {
    await requirePersonnelAdmin(connection, actorPersonId);
    const [terms] = await connection.execute("SELECT id FROM organization_terms WHERE id=? AND status IN ('draft','review')", [termId]);
    if (!terms[0]) throw new Error('Target term must be draft or review');
    const [running] = await connection.execute("SELECT id FROM turnover_runs WHERE status='preparing' LIMIT 1");
    if (running[0]) throw new Error('Another turnover is already in progress');
    const id = randomUUID();
    const [counts] = await connection.execute(
      `SELECT COUNT(*) total FROM accounts a JOIN people p ON p.id=a.person_id
       WHERE p.permanent_member=0 AND a.status='active'`,
    );
    await connection.execute(
      `INSERT INTO turnover_runs(id,target_term_id,status,started_by,started_at,summary_json)
       VALUES (?,?,'preparing',?,${nowSql},?)`,
      [id, termId, actorPersonId, JSON.stringify({ suspended_accounts: Number(counts[0]?.total ?? 0) })],
    );
    await connection.execute(
      `INSERT INTO turnover_account_snapshots(turnover_id,account_id,previous_status)
       SELECT ?,a.id,a.status FROM accounts a JOIN people p ON p.id=a.person_id
       WHERE p.permanent_member=0 AND a.status='active'`,
      [id],
    );
    await connection.execute(
      `UPDATE accounts SET status='suspended',updated_at=${nowSql}
       WHERE id IN (SELECT account_id FROM turnover_account_snapshots WHERE turnover_id=?)`,
      [id],
    );
    return { turnoverId: id, termId, suspendedAccounts: Number(counts[0]?.total ?? 0) };
  });
}

export async function finishTurnover(connection, termId) {
  const [runs] = await connection.execute(
    "SELECT id FROM turnover_runs WHERE target_term_id=? AND status='preparing' LIMIT 1",
    [termId],
  );
  if (!runs[0]) return;
  await connection.execute(
    `UPDATE accounts SET status='active',updated_at=${nowSql}
     WHERE person_id IN (SELECT person_id FROM appointments WHERE term_id=? AND status='active')`,
    [termId],
  );
  await connection.execute(
    `UPDATE people SET status='retired',authorization_version=authorization_version+1,updated_at=${nowSql}
     WHERE permanent_member=0 AND status IN ('active','probation')
       AND id NOT IN (SELECT person_id FROM appointments WHERE term_id=? AND status='active')`,
    [termId],
  );
  await connection.execute(
    `UPDATE turnover_runs SET status='completed',completed_at=${nowSql} WHERE id=?`,
    [runs[0].id],
  );
}
