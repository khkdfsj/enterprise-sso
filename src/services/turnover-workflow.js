import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { hashPassword } from '../security/password.js';

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function workflowInputError(message, status = 400) {
  return Object.assign(new Error(message), { expose: true, status });
}

export async function createTurnoverWorkflow(values, actorPersonId) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await withTransaction(async (connection) => {
    const [source] = await connection.execute("SELECT id FROM organization_terms WHERE id=? AND status='active'", [values.sourceTermId]);
    if (!source[0]) throw workflowInputError('请选择当前生效届次');
    if (values.targetTermId === values.sourceTermId) throw workflowInputError('目标届次不能与当前生效届次相同，请使用下一届编号。', 409);
    const [running] = await connection.execute("SELECT id FROM turnover_workflows WHERE status='draft' LIMIT 1");
    if (running[0]) throw workflowInputError('已有未完成换届，请先继续该流程。', 409);
    const [target] = await connection.execute('SELECT id,name FROM organization_terms WHERE id=? LIMIT 1', [values.targetTermId]);
    if (target[0]) throw workflowInputError(`届次编号 ${values.targetTermId} 已存在，请使用新的下一届编号。`, 409);
    await connection.execute(
      "INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)",
      [values.targetTermId, values.targetTermName, values.startsAt, values.endsAt, now, now],
    );
    await connection.execute(
      "INSERT INTO turnover_workflows(id,source_term_id,target_term_id,target_grade_year,current_step,status,created_by,created_at,updated_at) VALUES (?,?,?,?,2,'draft',?,?,?)",
      [id, values.sourceTermId, values.targetTermId, values.targetGradeYear, actorPersonId, now, now],
    );
  });
  return id;
}

export async function deleteTurnoverWorkflowDraft(workflowId) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT w.id,w.target_term_id,t.name target_name,t.status target_status,
        (SELECT COUNT(*) FROM turnover_workflow_members m WHERE m.workflow_id=w.id) member_count,
        (SELECT COUNT(*) FROM appointments a WHERE a.term_id=w.target_term_id) appointment_count,
        (SELECT COUNT(*) FROM term_publications p WHERE p.term_id=w.target_term_id) publication_count,
        (SELECT COUNT(*) FROM turnover_runs r WHERE r.target_term_id=w.target_term_id) run_count
       FROM turnover_workflows w JOIN organization_terms t ON t.id=w.target_term_id
       WHERE w.id=? AND w.status='draft'`,
      [workflowId],
    );
    const workflow = rows[0];
    if (!workflow) throw workflowInputError('换届草稿不存在或已经发布，不能删除。', 404);
    if (workflow.target_status !== 'draft' || workflow.appointment_count || workflow.publication_count || workflow.run_count) {
      throw workflowInputError('目标届次已经产生正式数据，不能作为草稿删除。', 409);
    }
    const [deletedWorkflow] = await connection.execute("DELETE FROM turnover_workflows WHERE id=? AND status='draft'", [workflow.id]);
    if (!deletedWorkflow.changes) throw workflowInputError('换届草稿状态已变化，请刷新后重试。', 409);
    const [deletedTerm] = await connection.execute("DELETE FROM organization_terms WHERE id=? AND status='draft'", [workflow.target_term_id]);
    if (!deletedTerm.changes) throw workflowInputError('目标届次状态已变化，请刷新后重试。', 409);
    return {
      id: workflow.id,
      targetTermId: workflow.target_term_id,
      targetName: workflow.target_name,
      memberCount: workflow.member_count,
    };
  });
}

function promotedPosition(positionsByCode, previousCode, previousId) {
  if (previousCode === 'member') return positionsByCode.get('vice-minister') ?? previousId;
  if (previousCode === 'vice-minister') return positionsByCode.get('minister') ?? previousId;
  return previousId;
}

export async function saveRetainedMembers(workflowId, personIds) {
  await withTransaction(async (connection) => {
    const [workflows] = await connection.execute("SELECT * FROM turnover_workflows WHERE id=? AND status='draft'", [workflowId]);
    const workflow = workflows[0];
    if (!workflow) throw new Error('换届流程不存在或已发布');
    const [positions] = await connection.execute("SELECT id,code FROM positions WHERE status='active'");
    const positionsByCode = new Map(positions.map((item) => [item.code, item.id]));
    await connection.execute("DELETE FROM turnover_workflow_members WHERE workflow_id=? AND source='retained'", [workflowId]);
    for (const personId of [...new Set(personIds)]) {
      const [rows] = await connection.execute(
        `SELECT p.id,p.display_name,p.grade_year,a.department_id,a.position_id,pos.code
         FROM people p JOIN appointments a ON a.person_id=p.id AND a.term_id=? AND a.status='active'
         JOIN positions pos ON pos.id=a.position_id
         WHERE p.id=? AND p.permanent_member=0 AND pos.code NOT IN ('alumni','teacher','super-admin') LIMIT 1`,
        [workflow.source_term_id, personId],
      );
      const person = rows[0];
      if (!person) continue;
      await connection.execute(
        `INSERT INTO turnover_workflow_members(id,workflow_id,person_id,user_id,display_name,grade_year,department_id,previous_position_id,proposed_position_id,source,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'retained',?,?)`,
        [randomUUID(), workflowId, person.id, person.id, person.display_name, person.grade_year, person.department_id, person.position_id, promotedPosition(positionsByCode, person.code, person.position_id), new Date().toISOString(), new Date().toISOString()],
      );
    }
    await connection.execute(`UPDATE turnover_workflows SET current_step=3,updated_at=${nowSql} WHERE id=?`, [workflowId]);
  });
}

export async function addWorkflowMembers(workflowId, members) {
  await withTransaction(async (connection) => {
    const [workflows] = await connection.execute("SELECT * FROM turnover_workflows WHERE id=? AND status='draft'", [workflowId]);
    const workflow = workflows[0];
    if (!workflow) throw new Error('换届流程不存在或已发布');
    const [positions] = await connection.execute("SELECT id FROM positions WHERE code='member' AND status='active' LIMIT 1");
    if (!positions[0]) throw new Error('系统缺少委员职位');
    for (const member of members) {
      const userId = String(member.userId ?? '').trim();
      const displayName = String(member.displayName ?? '').trim();
      if (!/^[A-Za-z0-9_.@-]{2,120}$/.test(userId) || !displayName || displayName.length > 160) throw new Error(`新委员资料不正确：${userId || '空 UserID'}`);
      const [existing] = await connection.execute('SELECT id FROM people WHERE id=?', [userId]);
      if (existing[0]) throw new Error(`${userId} 已在人员目录，请在留任步骤处理`);
      const [departments] = await connection.execute("SELECT id FROM departments WHERE id=? AND status='active'", [member.departmentId]);
      if (!departments[0]) throw new Error(`${userId} 的部门不存在`);
      const now = new Date().toISOString();
      await connection.execute(
        `INSERT INTO turnover_workflow_members(id,workflow_id,person_id,user_id,display_name,grade_year,department_id,previous_position_id,proposed_position_id,source,created_at,updated_at)
         VALUES (?,?,NULL,?,?,?,?,NULL,?,'new',?,?)
         ON CONFLICT(workflow_id,user_id) DO UPDATE SET display_name=excluded.display_name,grade_year=excluded.grade_year,department_id=excluded.department_id,updated_at=excluded.updated_at`,
        [randomUUID(), workflowId, userId, displayName, workflow.target_grade_year, member.departmentId, positions[0].id, now, now],
      );
    }
    await connection.execute(`UPDATE turnover_workflows SET current_step=CASE WHEN current_step<4 THEN 4 ELSE current_step END,updated_at=${nowSql} WHERE id=?`, [workflowId]);
  });
}

export async function publishTurnoverWorkflow(workflowId, actorPersonId) {
  const [newRows] = await pool.execute("SELECT user_id FROM turnover_workflow_members WHERE workflow_id=? AND source='new' ORDER BY user_id", [workflowId]);
  const passwordHashes = new Map();
  for (const row of newRows) {
    if (!/^\d{6,120}$/.test(row.user_id)) throw new Error(`新委员 ${row.user_id} 不是可生成默认密码的数字 UserID`);
    passwordHashes.set(row.user_id, await hashPassword(row.user_id.slice(-6)));
  }
  return withTransaction(async (connection) => {
    const [workflows] = await connection.execute("SELECT w.*,t.starts_at,t.ends_at FROM turnover_workflows w JOIN organization_terms t ON t.id=w.target_term_id WHERE w.id=? AND w.status='draft'", [workflowId]);
    const workflow = workflows[0];
    if (!workflow) throw new Error('换届流程不存在或已发布');
    const [members] = await connection.execute('SELECT * FROM turnover_workflow_members WHERE workflow_id=? ORDER BY source,user_id', [workflowId]);
    if (!members.length) throw new Error('新届名单不能为空');
    const now = new Date().toISOString();
    const activeNow = new Date(workflow.starts_at).getTime() <= Date.now();
    for (const member of members) {
      if (member.source === 'new') {
        const accountId = randomUUID();
        await connection.execute("INSERT INTO people(id,employee_no,display_name,status,grade_year,permanent_member,source_system,created_at,updated_at) VALUES (?,?,?,?,?,0,'turnover_workflow',?,?)", [member.user_id, member.user_id, member.display_name, activeNow ? 'active' : 'candidate', member.grade_year, now, now]);
        await connection.execute("INSERT INTO accounts(id,person_id,username,status,created_at,updated_at) VALUES (?,?,?,?,?,?)", [accountId, member.user_id, member.user_id.toLowerCase(), activeNow ? 'active' : 'pending', now, now]);
        await connection.execute("INSERT INTO password_credentials(account_id,password_hash,must_change_password,changed_at) VALUES (?,?,1,?)", [accountId, passwordHashes.get(member.user_id), now]);
        if (config.wecom.corpId) await connection.execute("INSERT OR IGNORE INTO wecom_identities(person_id,corp_id,wecom_userid,status,bound_at) VALUES (?,?,?,'active',?)", [member.user_id, config.wecom.corpId, member.user_id, now]);
        await connection.execute("INSERT INTO person_status_history(person_id,from_status,to_status,reason,changed_by,effective_at,created_at) VALUES (?,NULL,?,'换届新增委员',?,?,?)", [member.user_id, activeNow ? 'active' : 'candidate', actorPersonId, activeNow ? now : workflow.starts_at, now]);
      } else {
        await connection.execute(`UPDATE people SET display_name=?,grade_year=?,status='active',authorization_version=authorization_version+1,updated_at=${nowSql} WHERE id=?`, [member.display_name, member.grade_year, member.person_id]);
        await connection.execute(`UPDATE accounts SET status='active',failed_attempts=0,locked_until=NULL,updated_at=${nowSql} WHERE person_id=?`, [member.person_id]);
      }
      await connection.execute(
        `INSERT INTO appointments(id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,approved_by,approved_at,created_at,updated_at)
         VALUES (?,?,?,?,?,1,?,?,?, ?,?,?,?)`,
        [randomUUID(), member.user_id, workflow.target_term_id, member.department_id, member.proposed_position_id, workflow.starts_at, workflow.ends_at, activeNow ? 'active' : 'scheduled', actorPersonId, now, now, now],
      );
    }
    await connection.execute(
      `INSERT INTO appointments(id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,approved_by,approved_at,created_at,updated_at)
       SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
        a.person_id,?,a.department_id,a.position_id,1,?,?,?, ?,?,?,?
       FROM appointments a JOIN people p ON p.id=a.person_id
       WHERE a.term_id=? AND a.status='active' AND p.permanent_member=1`,
      [workflow.target_term_id, workflow.starts_at, workflow.ends_at, activeNow ? 'active' : 'scheduled', actorPersonId, now, now, now, workflow.source_term_id],
    );
    if (activeNow) {
      await connection.execute(`UPDATE appointments SET status='ended',ends_at=CASE WHEN ends_at>? THEN ? ELSE ends_at END,updated_at=${nowSql} WHERE term_id=? AND status='active'`, [workflow.starts_at, workflow.starts_at, workflow.source_term_id]);
      await connection.execute(`UPDATE organization_terms SET status='archived',updated_at=${nowSql} WHERE id=?`, [workflow.source_term_id]);
      await connection.execute(`UPDATE organization_terms SET status='active',published_at=?,updated_at=${nowSql} WHERE id=?`, [now, workflow.target_term_id]);
      await connection.execute(`UPDATE people SET status='retired',authorization_version=authorization_version+1,updated_at=${nowSql} WHERE permanent_member=0 AND id IN (SELECT person_id FROM appointments WHERE term_id=?) AND id NOT IN (SELECT person_id FROM appointments WHERE term_id=?)`, [workflow.source_term_id, workflow.target_term_id]);
      await connection.execute(`UPDATE accounts SET status='suspended',updated_at=${nowSql} WHERE person_id IN (SELECT id FROM people WHERE status='retired' AND permanent_member=0)`, []);
    } else {
      await connection.execute(`UPDATE organization_terms SET status='scheduled',published_at=?,updated_at=${nowSql} WHERE id=?`, [now, workflow.target_term_id]);
    }
    await connection.execute('INSERT INTO term_publications(term_id,published_by,effective_at,published_at,activated_at) VALUES (?,?,?,?,?)', [workflow.target_term_id, actorPersonId, workflow.starts_at, now, activeNow ? now : null]);
    await connection.execute(`UPDATE turnover_workflows SET current_step=5,status='published',published_at=?,updated_at=${nowSql} WHERE id=?`, [now, workflowId]);
    return { workflowId, termId: workflow.target_term_id, status: activeNow ? 'active' : 'scheduled', members: members.length };
  });
}
