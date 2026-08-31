import { withTransaction } from '../db.js';
import { finishTurnover } from './turnover.js';

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function activateTerm(connection, term) {
  const effectiveAt = term.starts_at;
  await connection.execute(
    `UPDATE appointments
     SET status='ended',ends_at=CASE WHEN ends_at>? THEN ? ELSE ends_at END,updated_at=${nowSql}
     WHERE status='active' AND term_id<>?`,
    [effectiveAt, effectiveAt, term.id],
  );
  await connection.execute(
    `UPDATE organization_terms SET status='archived',updated_at=${nowSql}
     WHERE status='active' AND id<>?`,
    [term.id],
  );
  await connection.execute(
    `UPDATE appointments SET status='active',updated_at=${nowSql}
     WHERE term_id=? AND status='scheduled'`,
    [term.id],
  );
  await connection.execute(
    `UPDATE organization_terms SET status='active',published_at=COALESCE(published_at,${nowSql}),updated_at=${nowSql}
     WHERE id=?`,
    [term.id],
  );
  await connection.execute(
    `UPDATE people SET authorization_version=authorization_version+1,updated_at=${nowSql}
     WHERE id IN (
       SELECT person_id FROM appointments WHERE term_id=?
       UNION
       SELECT person_id FROM appointments WHERE status='ended' AND ends_at=?
     )`,
    [term.id, effectiveAt],
  );
  await connection.execute(
    `UPDATE term_publications SET activated_at=${nowSql} WHERE term_id=?`,
    [term.id],
  );
  await finishTurnover(connection, term.id);
}

export async function publishTerm(termId, approverPersonId) {
  return withTransaction(async (connection) => {
    const [admins] = await connection.execute(
      `SELECT 1 FROM system_role_assignments
       WHERE person_id=? AND role IN ('super_admin','personnel_admin') AND status='active'
         AND (starts_at IS NULL OR starts_at<=${nowSql})
         AND (ends_at IS NULL OR ends_at>${nowSql}) LIMIT 1`,
      [approverPersonId],
    );
    if (!admins[0]) throw new Error('Approver does not have personnel administration permission');

    const [terms] = await connection.execute(
      "SELECT * FROM organization_terms WHERE id=? AND status='review' LIMIT 1",
      [termId],
    );
    const term = terms[0];
    if (!term) throw new Error('Term is not ready for publication');
    const [counts] = await connection.execute(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
       FROM appointments WHERE term_id=?`,
      [termId],
    );
    if (!counts[0]?.total || Number(counts[0].total) !== Number(counts[0].pending)) {
      throw new Error('Every appointment in the term must be pending before publication');
    }

    await connection.execute(
      `UPDATE appointments SET status='scheduled',approved_by=?,approved_at=${nowSql},updated_at=${nowSql}
       WHERE term_id=? AND status='pending'`,
      [approverPersonId, termId],
    );
    await connection.execute(
      `UPDATE organization_terms SET status='scheduled',published_at=${nowSql},updated_at=${nowSql} WHERE id=?`,
      [termId],
    );
    await connection.execute(
      `INSERT INTO term_publications(term_id,published_by,effective_at,published_at)
       VALUES (?,?,?,${nowSql})`,
      [termId, approverPersonId, term.starts_at],
    );
    if (new Date(term.starts_at).getTime() <= Date.now()) await activateTerm(connection, term);
    return { termId, status: new Date(term.starts_at).getTime() <= Date.now() ? 'active' : 'scheduled', effectiveAt: term.starts_at };
  });
}

export async function activateScheduledTerms() {
  return withTransaction(async (connection) => {
    const [terms] = await connection.execute(
      `SELECT * FROM organization_terms
       WHERE status='scheduled' AND starts_at<=${nowSql}
       ORDER BY starts_at,id`,
    );
    for (const term of terms) await activateTerm(connection, term);
    return terms.length;
  });
}
