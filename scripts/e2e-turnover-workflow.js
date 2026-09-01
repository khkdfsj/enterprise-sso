import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database, pool } from '../src/db.js';
import { verifyPassword } from '../src/security/password.js';
import { addWorkflowMembers, createTurnoverWorkflow, publishTurnoverWorkflow, saveRetainedMembers } from '../src/services/turnover-workflow.js';
import { activateScheduledTerms } from '../src/services/terms.js';

if (!process.env.DB_FILE || !/e2e/i.test(process.env.DB_FILE)) throw new Error('Workflow E2E requires an isolated e2e database');

const admin = database.prepare("SELECT person_id id FROM system_role_assignments WHERE role='super_admin' AND status='active' LIMIT 1").get();
if (!admin) throw new Error('Seeded super administrator was not found');

const now = new Date();
const oldStart = new Date(now.getTime() - 365 * 86400_000).toISOString();
const effectiveAt = new Date(now.getTime() - 1000).toISOString();
const future = new Date(now.getTime() + 365 * 86400_000).toISOString();
const sourceTerm = `workflow-source-${randomUUID()}`;
const targetTerm = `workflow-target-${randomUUID()}`;
const department = randomUUID();
const people = {
  member: '2023000001',
  vice: '2024000002',
  dropped: '2025000003',
  permanent: '2007510002',
  newcomer: '2026000004',
};

database.exec('BEGIN IMMEDIATE');
try {
  database.prepare("INSERT INTO departments(id,name,code,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(department, '运行部', `workflow-${department}`, now.toISOString(), now.toISOString());
  for (const [id, code, name, rank] of [['position-vice-minister','vice-minister','副部长',30],['position-minister','minister','部长',40],['position-teacher','teacher','老师',100]]) {
    database.prepare("INSERT OR IGNORE INTO positions(id,code,name,rank_order,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(id, code, name, rank, now.toISOString(), now.toISOString());
  }
  database.prepare("INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)").run(sourceTerm, '测试上一届', oldStart, future, now.toISOString(), now.toISOString());
  for (const [kind, userId] of Object.entries(people).filter(([key]) => key !== 'newcomer')) {
    database.prepare("INSERT INTO people(id,employee_no,display_name,status,grade_year,permanent_member,source_system,created_at,updated_at) VALUES (?,?,?,'active',?,?, 'workflow_e2e',?,?)").run(userId, userId, `测试${kind}`, Number(userId.slice(0, 4)), kind === 'permanent' ? 1 : 0, now.toISOString(), now.toISOString());
    database.prepare("INSERT INTO accounts(id,person_id,username,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)").run(randomUUID(), userId, userId, now.toISOString(), now.toISOString());
  }
  const positionIds = new Map(database.prepare("SELECT code,id FROM positions WHERE code IN ('member','vice-minister','minister','teacher')").all().map((row) => [row.code, row.id]));
  const positions = { member: positionIds.get('member'), vice: positionIds.get('vice-minister'), dropped: positionIds.get('member'), permanent: positionIds.get('teacher') };
  for (const [kind, userId] of Object.entries(people).filter(([key]) => key !== 'newcomer')) {
    for (const [table, id] of [['people', userId], ['organization_terms', sourceTerm], ['departments', department], ['positions', positions[kind]]]) assert.ok(database.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id), `${table}:${id} must exist before appointment`);
    try {
      database.prepare("INSERT INTO appointments(id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,'active',?,?)").run(randomUUID(), userId, sourceTerm, department, positions[kind], oldStart, future, now.toISOString(), now.toISOString());
    } catch (error) {
      throw new Error(`appointment insert failed for ${kind}:${userId}:${positions[kind]}`, { cause: error });
    }
  }
  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
}

const workflowId = await createTurnoverWorkflow({ sourceTermId: sourceTerm, targetTermId: targetTerm, targetTermName: '测试新一届', targetGradeYear: 2026, startsAt: effectiveAt, endsAt: future }, admin.id);
await saveRetainedMembers(workflowId, [people.member, people.vice]);
let proposals = database.prepare(`SELECT m.user_id,p.code FROM turnover_workflow_members m JOIN positions p ON p.id=m.proposed_position_id WHERE m.workflow_id=? ORDER BY m.user_id`).all(workflowId);
assert.equal(proposals.find((p) => p.user_id === people.member).code, 'vice-minister');
assert.equal(proposals.find((p) => p.user_id === people.vice).code, 'minister');

await addWorkflowMembers(workflowId, [{ userId: people.newcomer, displayName: '测试新委员', departmentId: department }]);
const published = await publishTurnoverWorkflow(workflowId, admin.id);
assert.equal(published.status, 'active');

const dropped = database.prepare('SELECT p.status,a.status account_status FROM people p JOIN accounts a ON a.person_id=p.id WHERE p.id=?').get(people.dropped);
assert.equal(dropped.status, 'retired');
assert.equal(dropped.account_status, 'suspended');
const permanent = database.prepare('SELECT COUNT(*) count FROM appointments WHERE person_id=? AND term_id=? AND status=?').get(people.permanent, targetTerm, 'active');
assert.equal(Number(permanent.count), 1);
const newcomer = database.prepare(`SELECT pc.password_hash,pc.must_change_password,a.status account_status,p.status FROM people p JOIN accounts a ON a.person_id=p.id JOIN password_credentials pc ON pc.account_id=a.id WHERE p.id=?`).get(people.newcomer);
assert.equal(await verifyPassword(newcomer.password_hash, people.newcomer.slice(-6)), true);
assert.equal(newcomer.must_change_password, 1);
assert.equal(newcomer.account_status, 'active');
assert.equal(newcomer.status, 'active');
const workflow = database.prepare('SELECT status,current_step FROM turnover_workflows WHERE id=?').get(workflowId);
assert.equal(workflow.status, 'published');
assert.equal(workflow.current_step, 5);
proposals = database.prepare(`SELECT a.person_id,p.code FROM appointments a JOIN positions p ON p.id=a.position_id WHERE a.term_id=? AND a.status='active' ORDER BY a.person_id`).all(targetTerm);
assert.equal(proposals.find((p) => p.person_id === people.member).code, 'vice-minister');
assert.equal(proposals.find((p) => p.person_id === people.vice).code, 'minister');
assert.equal(proposals.find((p) => p.person_id === people.newcomer).code, 'member');

const scheduledTerm = `workflow-scheduled-${randomUUID()}`;
const scheduledNewcomer = '2027000005';
const scheduledStart = new Date(now.getTime() + 30 * 86400_000).toISOString();
const scheduledEnd = new Date(now.getTime() + 395 * 86400_000).toISOString();
const scheduledWorkflow = await createTurnoverWorkflow({ sourceTermId: targetTerm, targetTermId: scheduledTerm, targetTermName: '测试预约届次', targetGradeYear: 2027, startsAt: scheduledStart, endsAt: scheduledEnd }, admin.id);
await saveRetainedMembers(scheduledWorkflow, [people.newcomer]);
await addWorkflowMembers(scheduledWorkflow, [{ userId: scheduledNewcomer, displayName: '测试预约委员', departmentId: department }]);
const scheduledResult = await publishTurnoverWorkflow(scheduledWorkflow, admin.id);
assert.equal(scheduledResult.status, 'scheduled');
assert.equal(database.prepare('SELECT status FROM appointments WHERE person_id=? AND term_id=?').get(people.newcomer, targetTerm).status, 'active');
const pendingNewcomer = database.prepare('SELECT p.status,a.status account_status FROM people p JOIN accounts a ON a.person_id=p.id WHERE p.id=?').get(scheduledNewcomer);
assert.equal(pendingNewcomer.status, 'candidate');
assert.equal(pendingNewcomer.account_status, 'pending');

const activationTime = new Date(now.getTime() - 500).toISOString();
database.prepare('UPDATE organization_terms SET starts_at=? WHERE id=?').run(activationTime, scheduledTerm);
database.prepare('UPDATE appointments SET starts_at=? WHERE term_id=?').run(activationTime, scheduledTerm);
database.prepare('UPDATE term_publications SET effective_at=? WHERE term_id=?').run(activationTime, scheduledTerm);
assert.equal(await activateScheduledTerms(), 1);
const activatedNewcomer = database.prepare('SELECT p.status,a.status account_status FROM people p JOIN accounts a ON a.person_id=p.id WHERE p.id=?').get(scheduledNewcomer);
assert.equal(activatedNewcomer.status, 'active');
assert.equal(activatedNewcomer.account_status, 'active');
assert.equal(database.prepare('SELECT status FROM organization_terms WHERE id=?').get(scheduledTerm).status, 'active');

console.log(JSON.stringify({ ok: true, resumable_steps: 5, promotions: ['委员→副部长', '副部长→部长'], nonselected: 'retired', permanent: 'carried', default_password: 'UserID last six digits with change-required flag', scheduled_activation: 'keeps current roster until effective time' }, null, 2));
await pool.end();
