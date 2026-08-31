import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { pool } from '../db.js';
import { authenticatePassword } from '../repositories/accounts.js';
import { publishTerm } from '../services/terms.js';
import { startTurnover } from '../services/turnover.js';
import { publicUrl } from '../public-url.js';

const router = express.Router();
const body = express.urlencoded({ extended: false, limit: '32kb' });
const ttlMs = 2 * 60 * 60 * 1000;
const adminLoginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function sign(value) {
  return createHmac('sha256', config.cookieKeys[0]).update(value).digest('base64url');
}
function makeSession(personId) {
  const payload = Buffer.from(JSON.stringify({ personId, csrf: randomBytes(24).toString('base64url'), expires: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readSession(req) {
  const raw = String(req.headers.cookie ?? '').split(';').map((v) => v.trim()).find((v) => v.startsWith('enterprise_admin='))?.slice(17);
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.expires > Date.now() ? session : null;
  } catch { return null; }
}
function cookie(value, maxAge = 7200) {
  return `enterprise_admin=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}
async function requireAdmin(req, res, next) {
  const session = readSession(req);
  if (!session) return res.redirect(publicUrl('/admin/login'));
  const [rows] = await pool.execute(
    `SELECT p.id,p.display_name,r.role FROM people p JOIN system_role_assignments r ON r.person_id=p.id
     WHERE p.id=? AND p.status IN ('active','probation') AND r.status='active'
       AND r.role IN ('super_admin','personnel_admin','application_admin','audit_viewer')
       AND (r.starts_at IS NULL OR r.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       AND (r.ends_at IS NULL OR r.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    [session.personId],
  );
  if (!rows[0]) return res.status(403).send(page('无权访问', '<p>当前账号没有后台权限。</p>'));
  req.admin = { ...session, person: rows[0], roles: rows.map((row) => row.role) };
  next();
}
function requireCsrf(req, res, next) {
  if (!req.admin || req.body.csrf !== req.admin.csrf) return res.status(400).send(page('请求失效', '<p>请刷新页面后重试。</p>'));
  next();
}
function page(title, content) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>body{font-family:system-ui;margin:0;background:#f4f6f8;color:#17212b}main{max-width:1180px;margin:auto;padding:24px}section{background:#fff;border-radius:14px;padding:20px;margin:16px 0;box-shadow:0 4px 18px #1c273312}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #e8edf2}input,select,button{padding:9px 11px;margin:4px;border:1px solid #cbd5df;border-radius:8px}button{background:#1769e0;color:#fff;cursor:pointer}a{color:#1769e0}small{color:#687786}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.metric{font-size:28px;font-weight:700}.warn{color:#a54800}</style></head><body><main>${content}</main></body></html>`;
}

router.get('/login', (_req, res) => res.send(page('统一认证后台登录', `<section><h1>统一认证管理后台</h1><form method="post"><label>UserID / 账号 <input name="username" autocomplete="username" required></label><label>密码 <input type="password" name="password" autocomplete="current-password" required></label><button>登录</button></form></section>`)));
router.post('/login', adminLoginLimit, body, async (req, res) => {
  const result = await authenticatePassword(req.body.username, req.body.password);
  if (!result.ok) return res.status(401).send(page('登录失败', `<section><p>账号或密码错误，或账号当前不可用。</p><a href="${publicUrl('/admin/login')}">返回</a></section>`));
  const [roles] = await pool.execute("SELECT role FROM system_role_assignments WHERE person_id=? AND status='active'", [result.personId]);
  if (!roles.length) return res.status(403).send(page('无权访问', '<section><p>此账号没有后台管理权限。</p></section>'));
  res.setHeader('Set-Cookie', cookie(makeSession(result.personId)));
  res.redirect(publicUrl('/admin'));
});
router.post('/logout', requireAdmin, body, requireCsrf, (req, res) => {
  res.setHeader('Set-Cookie', cookie('', 0));
  res.redirect(publicUrl('/admin/login'));
});

router.get('/', requireAdmin, async (req, res) => {
  const [[counts], [terms], [people], [apps], [turnovers], [departments], [positions]] = await Promise.all([
    pool.execute(`SELECT COUNT(*) total,SUM(status='active') active,SUM(status='retired') retired,SUM(permanent_member=1) permanent FROM people`),
    pool.execute('SELECT id,name,starts_at,ends_at,status FROM organization_terms ORDER BY starts_at DESC LIMIT 10'),
    pool.execute(`SELECT p.id,p.display_name,p.grade_year,p.status,p.permanent_member,d.name department,pos.name position
      FROM people p LEFT JOIN appointments ap ON ap.person_id=p.id AND ap.status='active'
      LEFT JOIN departments d ON d.id=ap.department_id LEFT JOIN positions pos ON pos.id=ap.position_id
      ORDER BY p.permanent_member DESC,p.grade_year,p.id LIMIT 200`),
    pool.execute('SELECT client_id,name,access_mode,status FROM applications ORDER BY name'),
    pool.execute('SELECT id,target_term_id,status,started_at,completed_at FROM turnover_runs ORDER BY started_at DESC LIMIT 10'),
    pool.execute("SELECT id,name FROM departments WHERE status='active' ORDER BY name"),
    pool.execute("SELECT id,name FROM positions WHERE status='active' ORDER BY rank_order DESC,name"),
  ]);
  const c = counts[0] ?? {};
  const csrf = esc(req.admin.csrf);
  res.send(page('统一认证管理后台', `<h1>统一认证管理后台</h1><p>当前管理员：${esc(req.admin.person.display_name)}（${esc(req.admin.person.id)}）</p>
    <section class="grid"><div><small>人员总数</small><div class="metric">${c.total ?? 0}</div></div><div><small>在职</small><div class="metric">${c.active ?? 0}</div></div><div><small>已卸任</small><div class="metric">${c.retired ?? 0}</div></div><div><small>永久账号</small><div class="metric">${c.permanent ?? 0}</div></div></section>
    <section><h2>届次与换届</h2><form method="post" action="${publicUrl('/admin/terms')}"><input type="hidden" name="csrf" value="${csrf}"><input name="id" placeholder="term-2027-2028" required><input name="name" placeholder="2027—2028 届" required><input type="datetime-local" name="starts_at" required><input type="datetime-local" name="ends_at" required><button>新建草稿</button></form><table><tr><th>届次</th><th>时间</th><th>状态</th><th>操作</th></tr>${terms.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.starts_at)}<br>${esc(t.ends_at)}</td><td>${esc(t.status)}</td><td><form method="post" action="${publicUrl('/admin/turnovers/start')}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="term_id" value="${esc(t.id)}"><button>开始换届并暂停非永久账号</button></form><form method="post" action="${publicUrl(`/admin/terms/${encodeURIComponent(t.id)}/review`)}"><input type="hidden" name="csrf" value="${csrf}"><button>提交复核</button></form><form method="post" action="${publicUrl(`/admin/terms/${encodeURIComponent(t.id)}/publish`)}"><input type="hidden" name="csrf" value="${csrf}"><button>发布</button></form></td></tr>`).join('')}</table></section>
    <section><h2>添加新届任职</h2><form method="post" action="${publicUrl('/admin/appointments')}"><input type="hidden" name="csrf" value="${csrf}"><select name="person_id" required>${people.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.display_name)}</option>`).join('')}</select><select name="term_id" required>${terms.filter((t) => ['draft', 'review'].includes(t.status)).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select><select name="department_id" required>${departments.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select><select name="position_id" required>${positions.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><button>加入待发布名单</button></form></section>
    <section><h2>人员（最多显示 200 人）</h2><table><tr><th>UserID</th><th>姓名 / 年级</th><th>部门 / 职位</th><th>状态与永久标记</th></tr>${people.map((p) => `<tr><td>${esc(p.id)}</td><td>${esc(p.display_name)}<br><small>${esc(p.grade_year ?? '')}</small></td><td>${esc(p.department ?? '')} / ${esc(p.position ?? '')}</td><td><form method="post" action="${publicUrl(`/admin/people/${encodeURIComponent(p.id)}`)}"><input type="hidden" name="csrf" value="${csrf}"><select name="status">${['candidate','probation','active','retired','left','graduated','dismissed'].map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><select name="permanent_member"><option value="0" ${p.permanent_member ? '' : 'selected'}>正常</option><option value="1" ${p.permanent_member ? 'selected' : ''}>永久</option></select><button>保存</button></form></td></tr>`).join('')}</table></section>
    <section><h2>接入应用</h2><table><tr><th>Client ID</th><th>名称</th><th>访问模式</th><th>状态</th></tr>${apps.map((a) => `<tr><td>${esc(a.client_id)}</td><td>${esc(a.name)}</td><td>${esc(a.access_mode)}</td><td>${esc(a.status)}</td></tr>`).join('')}</table></section>
    <section><h2>换届记录</h2><table><tr><th>ID</th><th>目标届次</th><th>状态</th><th>开始</th><th>完成</th></tr>${turnovers.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.target_term_id)}</td><td>${esc(t.status)}</td><td>${esc(t.started_at)}</td><td>${esc(t.completed_at ?? '')}</td></tr>`).join('')}</table></section>
    <form method="post" action="${publicUrl('/admin/logout')}"><input type="hidden" name="csrf" value="${csrf}"><button>退出后台</button></form>`));
});

router.post('/terms', requireAdmin, body, requireCsrf, async (req, res) => {
  if (!req.admin.roles.some((r) => ['super_admin', 'personnel_admin'].includes(r))) return res.sendStatus(403);
  const starts = new Date(req.body.starts_at).toISOString();
  const ends = new Date(req.body.ends_at).toISOString();
  if (starts >= ends) return res.status(400).send(page('时间错误', '<p>开始时间必须早于结束时间。</p>'));
  const now = new Date().toISOString();
  await pool.execute("INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)", [req.body.id, req.body.name, starts, ends, now, now]);
  res.redirect(publicUrl('/admin'));
});
router.post('/turnovers/start', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try { await startTurnover(req.body.term_id, req.admin.person.id); res.redirect(publicUrl('/admin')); } catch (error) { next(error); }
});
router.post('/terms/:id/review', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try {
    if (!req.admin.roles.some((r) => ['super_admin', 'personnel_admin'].includes(r))) return res.sendStatus(403);
    const [result] = await pool.execute("UPDATE organization_terms SET status='review',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'", [req.params.id]);
    if (!result.changes) return res.status(409).send(page('状态不允许', '<p>只有草稿届次可以提交复核。</p>'));
    res.redirect(publicUrl('/admin'));
  } catch (error) { next(error); }
});
router.post('/terms/:id/publish', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try { await publishTerm(req.params.id, req.admin.person.id); res.redirect(publicUrl('/admin')); } catch (error) { next(error); }
});
router.post('/appointments', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try {
    if (!req.admin.roles.some((r) => ['super_admin', 'personnel_admin'].includes(r))) return res.sendStatus(403);
    const [terms] = await pool.execute("SELECT starts_at,ends_at FROM organization_terms WHERE id=? AND status IN ('draft','review')", [req.body.term_id]);
    if (!terms[0]) return res.status(409).send(page('届次不可编辑', '<p>请选择草稿或复核中的届次。</p>'));
    const now = new Date().toISOString();
    await pool.execute(`INSERT INTO appointments
      (id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,?,'pending',?,?)`,
    [randomUUID(), req.body.person_id, req.body.term_id, req.body.department_id, req.body.position_id, terms[0].starts_at, terms[0].ends_at, now, now]);
    res.redirect(publicUrl('/admin'));
  } catch (error) { next(error); }
});
router.post('/people/:id', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try {
    if (!req.admin.roles.some((r) => ['super_admin', 'personnel_admin'].includes(r))) return res.sendStatus(403);
    const allowed = new Set(['candidate','probation','active','retired','left','graduated','dismissed']);
    if (!allowed.has(req.body.status) || !['0', '1'].includes(req.body.permanent_member)) return res.sendStatus(400);
    if (req.params.id === req.admin.person.id && req.body.status !== 'active') return res.status(409).send(page('不能停用自己', '<p>请由另一位超级管理员处理当前账号。</p>'));
    await pool.execute(`UPDATE people SET status=?,permanent_member=?,authorization_version=authorization_version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, [req.body.status, Number(req.body.permanent_member), req.params.id]);
    res.redirect(publicUrl('/admin'));
  } catch (error) { next(error); }
});

export const adminRouter = router;
