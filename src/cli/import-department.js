import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { database, pool } from '../db.js';

const args = new Set(process.argv.slice(2));
const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const departmentFile = valueAfter('--department');
const authFile = valueAfter('--auth');
const commit = args.has('--commit');
const rollbackId = valueAfter('--rollback');
const actor = valueAfter('--actor') ?? null;
const permanentIds = new Set((valueAfter('--permanent') ?? '2023195077,2007510002,88487016').split(',').map((v) => v.trim()).filter(Boolean));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gradeFrom(member) {
  const text = [member.grade, member.posts, member.bm].filter(Boolean).join(' ');
  const match = text.match(/(?:^|\D)(2[0-9])级/);
  return match ? 2000 + Number(match[1]) : null;
}

function canonicalStatus(grade, permanent) {
  if (permanent) return 'active';
  if (grade && grade <= 2023) return 'retired';
  if (grade === 2026) return 'candidate';
  return 'active';
}

function positionFor(grade, posts) {
  if (/老师/.test(posts ?? '')) return ['teacher', '老师', 100];
  if (/超级管理员/.test(posts ?? '')) return ['super-admin', '超级管理员', 1000];
  if (grade === 2024) return ['minister', '部长', 40];
  if (grade === 2025) return ['vice-minister', '副部长', 30];
  if (grade === 2026) return ['member', '委员', 10];
  return ['alumni', '已卸任', 0];
}

function slug(value, prefix) {
  return `${prefix}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
}

function rollback(batchId) {
  const batch = database.prepare("SELECT * FROM migration_batches WHERE id=? AND status='committed'").get(batchId);
  if (!batch) throw new Error('Committed migration batch was not found');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('DELETE FROM appointments WHERE migration_batch_id=?').run(batchId);
    database.prepare('DELETE FROM system_role_assignments WHERE person_id IN (SELECT id FROM people WHERE migration_batch_id=?)').run(batchId);
    database.prepare('DELETE FROM wecom_identities WHERE person_id IN (SELECT id FROM people WHERE migration_batch_id=?)').run(batchId);
    database.prepare('DELETE FROM accounts WHERE person_id IN (SELECT id FROM people WHERE migration_batch_id=?)').run(batchId);
    database.prepare('DELETE FROM person_status_history WHERE person_id IN (SELECT id FROM people WHERE migration_batch_id=?)').run(batchId);
    database.prepare('DELETE FROM people WHERE migration_batch_id=?').run(batchId);
    database.prepare("UPDATE migration_batches SET status='rolled_back',rolled_back_at=? WHERE id=?").run(new Date().toISOString(), batchId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, rolled_back: batchId };
}

if (rollbackId) {
  console.log(JSON.stringify(rollback(rollbackId), null, 2));
  await pool.end();
  process.exit(0);
}
if (!departmentFile || !authFile) throw new Error('--department and --auth JSON files are required');

const department = readJson(departmentFile);
const auth = readJson(authFile);
const fingerprint = createHash('sha256').update(JSON.stringify({ department, auth })).digest('hex');
const batchId = `departmentifo-${fingerprint.slice(0, 16)}`;
const memberByUserId = new Map(department.members.map((m) => [String(m.stuno).trim(), m]));
const authByUserId = new Map(auth.users.filter((u) => u.app_id === 'member-platform').map((u) => [String(u.username).trim(), u]));
const userIds = new Set([...memberByUserId.keys(), ...authByUserId.keys()]);
const conflicts = [];
const people = [];

for (const userId of userIds) {
  if (!userId) continue;
  const member = memberByUserId.get(userId);
  const login = authByUserId.get(userId);
  const names = new Set([member?.name, login?.display_name].filter(Boolean));
  if (names.size > 1) conflicts.push({ source_record_id: member?.id ?? login?.id, user_id: userId, conflict_type: 'display_name_mismatch', detail: [...names] });
  const grade = gradeFrom(member ?? {});
  const permanent = permanentIds.has(userId);
  const [positionCode, positionName, rank] = positionFor(grade, member?.posts);
  people.push({
    userId,
    name: member?.name ?? login?.display_name ?? userId,
    member,
    login,
    grade,
    permanent,
    status: canonicalStatus(grade, permanent),
    positionCode,
    positionName,
    rank,
  });
}

for (const id of permanentIds) {
  if (!userIds.has(id)) conflicts.push({ source_record_id: null, user_id: id, conflict_type: 'required_permanent_user_missing', detail: {} });
}
for (const person of people) {
  if (database.prepare('SELECT 1 FROM people WHERE id=?').get(person.userId)) {
    conflicts.push({ source_record_id: person.member?.id ?? person.login?.id, user_id: person.userId, conflict_type: 'target_user_exists', detail: {} });
  }
}
const blocking = conflicts.filter((c) => ['required_permanent_user_missing', 'target_user_exists'].includes(c.conflict_type));
const summary = {
  batch_id: batchId,
  mode: commit ? 'commit' : 'preview',
  people: people.length,
  departments: department.departments.length,
  active: people.filter((p) => p.status === 'active').length,
  retired: people.filter((p) => p.status === 'retired').length,
  candidate: people.filter((p) => p.status === 'candidate').length,
  permanent_super_admins: people.filter((p) => p.permanent).map((p) => ({ user_id: p.userId, name: p.name })),
  grade_2024_ministers: people.filter((p) => p.grade === 2024).length,
  grade_2025_vice_ministers: people.filter((p) => p.grade === 2025).length,
  conflicts: conflicts.length,
  blocking_conflicts: blocking.length,
  source_fingerprint: fingerprint,
};

if (!commit) {
  console.log(JSON.stringify({ ...summary, conflict_detail: conflicts }, null, 2));
  await pool.end();
  process.exit(blocking.length ? 2 : 0);
}
if (blocking.length) throw new Error('Blocking migration conflicts must be resolved before commit');
if (database.prepare('SELECT 1 FROM migration_batches WHERE source_system=? AND source_fingerprint=?').get(department.source, fingerprint)) {
  throw new Error('This exact source export was already imported or previewed');
}

const now = new Date().toISOString();
const termId = 'term-2026-2027';
const startsAt = '2026-08-31T00:00:00.000Z';
const endsAt = '2027-08-31T00:00:00.000Z';
database.exec('BEGIN IMMEDIATE');
try {
  database.prepare(`INSERT INTO migration_batches
    (id,source_system,source_fingerprint,source_exported_at,status,summary_json,created_by,created_at,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(batchId, department.source, fingerprint, department.exported_at, 'committed', JSON.stringify(summary), actor, now, now);
  const insertConflict = database.prepare(`INSERT INTO migration_conflicts
    (batch_id,source_record_id,user_id,conflict_type,detail_json,created_at) VALUES (?,?,?,?,?,?)`);
  for (const conflict of conflicts) insertConflict.run(batchId, String(conflict.source_record_id ?? ''), conflict.user_id, conflict.conflict_type, JSON.stringify(conflict.detail), now);

  database.prepare(`INSERT OR IGNORE INTO organization_terms(id,name,starts_at,ends_at,status,published_at,created_at,updated_at)
    VALUES (?,?,?,?,'active',?,?,?)`).run(termId, '2026—2027 届', startsAt, endsAt, now, now, now);
  const departmentMap = new Map();
  const insertDepartment = database.prepare(`INSERT OR IGNORE INTO departments(id,parent_id,name,code,status,created_at,updated_at)
    VALUES (?,?,?,?, 'active',?,?)`);
  for (const source of department.departments) {
    const id = `legacy-department-${source.id}`;
    departmentMap.set(String(source.id), id);
    insertDepartment.run(id, null, source.name, slug(source.id, 'dept'), now, now);
  }
  const fallbackDepartment = 'legacy-department-unassigned';
  insertDepartment.run(fallbackDepartment, null, '未分配部门', 'unassigned', now, now);

  const positionMap = new Map();
  const insertPosition = database.prepare(`INSERT OR IGNORE INTO positions(id,code,name,rank_order,status,created_at,updated_at)
    VALUES (?,?,?,?,'active',?,?)`);
  for (const person of people) {
    const id = `position-${person.positionCode}`;
    positionMap.set(person.positionCode, id);
    insertPosition.run(id, person.positionCode, person.positionName, person.rank, now, now);
  }

  const insertPerson = database.prepare(`INSERT INTO people
    (id,employee_no,display_name,status,grade_year,permanent_member,source_system,source_record_id,migration_batch_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insertAccount = database.prepare(`INSERT INTO accounts(id,person_id,username,status,created_at,updated_at)
    VALUES (?,?,?,'active',?,?)`);
  const insertWecom = database.prepare(`INSERT INTO wecom_identities(person_id,corp_id,wecom_userid,status,bound_at)
    VALUES (?,?,?,'active',?)`);
  const insertAppointment = database.prepare(`INSERT INTO appointments
    (id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,source_system,source_record_id,migration_batch_id,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?,'active',?,?,?,?,?)`);
  const insertStatus = database.prepare(`INSERT INTO person_status_history
    (person_id,from_status,to_status,reason,changed_by,effective_at,created_at) VALUES (?,?,?,?,?,?,?)`);
  const insertRole = database.prepare(`INSERT OR IGNORE INTO system_role_assignments
    (person_id,role,status,granted_by,starts_at,created_at) VALUES (?,'super_admin','active',?,?,?)`);
  for (const person of people) {
    const sourceId = String(person.member?.id ?? `auth-${person.login?.id}`);
    insertPerson.run(person.userId, person.userId, person.name, person.status, person.grade, person.permanent ? 1 : 0, department.source, sourceId, batchId, now, now);
    insertAccount.run(randomUUID(), person.userId, person.userId.toLowerCase(), now, now);
    if (config.wecom.corpId) insertWecom.run(person.userId, config.wecom.corpId, person.userId, now);
    insertStatus.run(person.userId, person.member?.status ?? null, person.status, '2026 届次迁移规则', actor, now, now);
    if (person.status === 'active') {
      insertAppointment.run(randomUUID(), person.userId, termId, departmentMap.get(String(person.member?.department_id)) ?? fallbackDepartment, positionMap.get(person.positionCode), startsAt, endsAt, department.source, sourceId, batchId, now, now);
    }
    if (person.permanent) insertRole.run(person.userId, actor, now, now);
  }
  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}

console.log(JSON.stringify({ ok: true, ...summary, rollback_command: `npm run personnel:import -- --rollback ${batchId}` }, null, 2));
await pool.end();
