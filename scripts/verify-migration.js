import assert from 'node:assert/strict';
import { database, pool } from '../src/db.js';

const expectedPeople = Number(process.env.EXPECTED_PEOPLE ?? 120);
const expectedAppointments = Number(process.env.EXPECTED_APPOINTMENTS ?? 120);
const expectedPermanent = ['2007510002', '2023195077', '88487016'];
const people = Number(database.prepare('SELECT COUNT(*) count FROM people').get().count);
const appointments = Number(database.prepare('SELECT COUNT(*) count FROM appointments').get().count);
const mismatches = Number(database.prepare('SELECT COUNT(*) count FROM wecom_identities WHERE person_id<>wecom_userid').get().count);
const permanent = database.prepare('SELECT id FROM people WHERE permanent_member=1 ORDER BY id').all().map((row) => row.id);
const admins = database.prepare("SELECT person_id FROM system_role_assignments WHERE role='super_admin' AND status='active' ORDER BY person_id").all().map((row) => row.person_id);

assert.equal(people, expectedPeople);
assert.equal(appointments, expectedAppointments);
assert.equal(mismatches, 0);
assert.deepEqual(permanent, expectedPermanent);
assert.deepEqual(admins, expectedPermanent);
console.log(JSON.stringify({ ok: true, people, appointments, canonical_userid_mismatches: mismatches, permanent_super_admins: admins }, null, 2));
await pool.end();
