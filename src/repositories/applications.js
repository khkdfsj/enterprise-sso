import { pool } from '../db.js';

export async function findApplication(clientId) {
  const [rows] = await pool.execute('SELECT * FROM applications WHERE client_id=? LIMIT 1', [clientId]);
  return rows[0];
}

export async function canAccessApplication(personId, clientId) {
  const app = await findApplication(clientId);
  if (!app || app.status !== 'active') return false;

  const [people] = await pool.execute('SELECT status FROM people WHERE id=? LIMIT 1', [personId]);
  if (!people[0] || !['active', 'probation'].includes(people[0].status)) return false;
  if (app.access_mode === 'all_active') return true;

  const [rules] = await pool.execute(
    `SELECT r.effect
     FROM application_access_rules r
     WHERE r.application_id=?
       AND (r.starts_at IS NULL OR r.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       AND (r.ends_at IS NULL OR r.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       AND (
         (r.subject_type='person' AND r.subject_id=?) OR
         (r.subject_type='department' AND EXISTS (
           SELECT 1 FROM appointments ap WHERE ap.person_id=? AND ap.department_id=r.subject_id
             AND ap.status='active' AND ap.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ap.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
         )) OR
         (r.subject_type='position' AND EXISTS (
           SELECT 1 FROM appointments ap WHERE ap.person_id=? AND ap.position_id=r.subject_id
             AND ap.status='active' AND ap.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ap.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
         ))
       )
     ORDER BY CASE r.effect WHEN 'deny' THEN 0 ELSE 1 END`,
    [app.id, personId, personId, personId],
  );
  if (rules.some((r) => r.effect === 'deny')) return false;
  return rules.some((r) => r.effect === 'allow');
}
