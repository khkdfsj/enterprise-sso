import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database, pool } from '../src/db.js';
import { publishTerm } from '../src/services/terms.js';

if (!process.env.DB_FILE || !/e2e/i.test(process.env.DB_FILE)) {
  throw new Error('Turnover E2E test requires a DB_FILE containing e2e');
}

const admin = database.prepare(
  `SELECT p.id,p.authorization_version FROM people p
   JOIN system_role_assignments r ON r.person_id=p.id
   WHERE r.role='super_admin' AND r.status='active' LIMIT 1`,
).get();
if (!admin) throw new Error('Seeded super administrator was not found');

const oldTerm = randomUUID();
const newTerm = randomUUID();
const department = randomUUID();
const memberPosition = randomUUID();
const leaderPosition = randomUUID();
const oldAppointment = randomUUID();
const newAppointment = randomUUID();
const now = new Date();
const oldStart = new Date(now.getTime() - 365 * 86400_000).toISOString();
const effectiveAt = new Date(now.getTime() - 1000).toISOString();
const future = new Date(now.getTime() + 365 * 86400_000).toISOString();

database.exec('BEGIN IMMEDIATE');
try {
  database.prepare('INSERT INTO departments(id,name,code,status,created_at,updated_at) VALUES (?,?,?,\'active\',?,?)')
    .run(department, '技术部', `dept-${department}`, now.toISOString(), now.toISOString());
  database.prepare('INSERT INTO positions(id,code,name,rank_order,status,created_at,updated_at) VALUES (?,?,?,10,\'active\',?,?)')
    .run(memberPosition, `member-${memberPosition}`, '委员', now.toISOString(), now.toISOString());
  database.prepare('INSERT INTO positions(id,code,name,rank_order,status,created_at,updated_at) VALUES (?,?,?,30,\'active\',?,?)')
    .run(leaderPosition, `leader-${leaderPosition}`, '部长', now.toISOString(), now.toISOString());
  database.prepare('INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,\'active\',?,?)')
    .run(oldTerm, '上一届', oldStart, future, now.toISOString(), now.toISOString());
  database.prepare('INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,\'review\',?,?)')
    .run(newTerm, '新一届', effectiveAt, future, now.toISOString(), now.toISOString());
  database.prepare(`INSERT INTO appointments
    (id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?,\'active\',?,?)`)
    .run(oldAppointment, admin.id, oldTerm, department, memberPosition, oldStart, future, now.toISOString(), now.toISOString());
  database.prepare(`INSERT INTO appointments
    (id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?,\'pending\',?,?)`)
    .run(newAppointment, admin.id, newTerm, department, leaderPosition, effectiveAt, future, now.toISOString(), now.toISOString());
  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}

const result = await publishTerm(newTerm, admin.id);
const oldState = database.prepare('SELECT status,ends_at FROM appointments WHERE id=?').get(oldAppointment);
const newState = database.prepare('SELECT status FROM appointments WHERE id=?').get(newAppointment);
const terms = database.prepare('SELECT id,status FROM organization_terms WHERE id IN (?,?)').all(oldTerm, newTerm);
const version = database.prepare('SELECT authorization_version FROM people WHERE id=?').get(admin.id);

assert.equal(result.status, 'active');
assert.equal(oldState.status, 'ended');
assert.equal(oldState.ends_at, effectiveAt);
assert.equal(newState.status, 'active');
assert.equal(terms.find((term) => term.id === oldTerm).status, 'archived');
assert.equal(terms.find((term) => term.id === newTerm).status, 'active');
assert.equal(Number(version.authorization_version), Number(admin.authorization_version) + 1);

console.log(JSON.stringify({
  ok: true,
  publication: 'atomic',
  previous_appointment: 'ended',
  new_appointment: 'active',
  authorization_version_incremented: true,
}, null, 2));
await pool.end();
