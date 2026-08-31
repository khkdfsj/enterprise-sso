import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { authenticatePassword } from '../repositories/accounts.js';
import { audit } from '../repositories/audit.js';
import { decryptJson, encryptJson, randomToken, sha256 } from '../security/crypto.js';
import { hashPassword } from '../security/password.js';
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
function sign(value) { return createHmac('sha256', config.cookieKeys[0]).update(value).digest('base64url'); }
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
  return `enterprise_admin=${value}; Path=${publicUrl('/admin')}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
}
async function requireAdmin(req, res, next) {
  const session = readSession(req);
  if (!session) return res.redirect(publicUrl('/admin/login'));
  const [rows] = await pool.execute(
    `SELECT p.id,p.display_name,r.role FROM people p JOIN system_role_assignments r ON r.person_id=p.id
     WHERE p.id=? AND p.status IN ('active','probation') AND r.status='active'
       AND r.role IN ('super_admin','security_admin','personnel_admin','application_admin','audit_viewer')
       AND (r.starts_at IS NULL OR r.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       AND (r.ends_at IS NULL OR r.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    [session.personId],
  );
  if (!rows[0]) return res.status(403).send(loginPage('无权访问', '<p class="form-note">当前账号没有后台权限。</p>'));
  req.admin = { ...session, person: rows[0], roles: rows.map((row) => row.role) };
  next();
}
function requireCsrf(req, res, next) {
  if (!req.admin || req.body.csrf !== req.admin.csrf) return res.status(400).send(loginPage('请求失效', '<p class="form-note">页面已失效，请刷新后重试。</p>'));
  next();
}
function hasRole(req, roles) { return req.admin.roles.some((role) => roles.includes(role)); }
function forbidUnless(req, res, roles) {
  if (hasRole(req, roles)) return false;
  res.status(403).send(adminPage(req, '无权操作', '', '<div class="empty">当前管理员没有执行此操作的权限。</div>'));
  return true;
}
function loginPage(title, content) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><link rel="stylesheet" href="${publicUrl('/assets/admin.css')}"></head><body class="admin-login-page"><main class="admin-login"><div class="admin-brand"><span>ID</span><strong>统一认证控制台</strong></div><section class="login-box"><h1>${esc(title)}</h1>${content}</section></main></body></html>`;
}
const navItems = [
  ['overview', '/admin', '概览', '⌂'], ['applications', '/admin/applications', '应用接入', '▦'],
  ['people', '/admin/people', '人员与账号', '♙'], ['terms', '/admin/terms', '届次换届', '↻'],
  ['audit', '/admin/audit', '登录与审计', '≡'], ['integration', '/admin/integration', '接入指南', '⌘'],
];
function adminPage(req, title, active, content, subtitle = '') {
  const csrf = esc(req.admin.csrf);
  const nav = navItems.map(([key, href, label, icon]) => `<a class="nav-item ${active === key ? 'active' : ''}" href="${publicUrl(href)}"><span>${icon}</span>${label}</a>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)} · 统一认证</title><link rel="stylesheet" href="${publicUrl('/assets/admin.css')}"></head><body class="admin-page"><aside class="sidebar"><a class="console-brand" href="${publicUrl('/admin')}"><span>ID</span><div>统一认证<small>管理控制台</small></div></a><nav>${nav}</nav><div class="sidebar-foot"><div><strong>${esc(req.admin.person.display_name)}</strong><small>${esc(req.admin.person.id)}</small></div><form method="post" action="${publicUrl('/admin/logout')}"><input type="hidden" name="csrf" value="${csrf}"><button class="link-button">退出</button></form></div></aside><div class="workspace"><header class="topbar"><div><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><span class="env-badge">生产环境</span></header><main class="content">${content}</main></div><script src="${publicUrl('/assets/admin.js')}" defer></script></body></html>`;
}
function csrf(req) { return `<input type="hidden" name="csrf" value="${esc(req.admin.csrf)}">`; }
function badge(value, tone = '') { return `<span class="badge ${tone}">${esc(value)}</span>`; }
function statusBadge(value) {
  const labels = { active: '启用', disabled: '停用', probation: '试用', retired: '已卸任', candidate: '候选', graduated: '已毕业', left: '已离开', dismissed: '已移除', draft: '草稿', review: '复核中', scheduled: '待生效', archived: '已归档', completed: '已完成', preparing: '处理中' };
  return badge(labels[value] ?? value, ['active', 'completed'].includes(value) ? 'success' : ['disabled', 'retired', 'left', 'graduated', 'dismissed'].includes(value) ? 'muted' : 'warning');
}
function formatTime(value) { return value ? esc(String(value).replace('T', ' ').replace(/\.\d{3}Z$/, '')) : '—'; }
function validateRedirectUri(value) {
  let parsed;
  try { parsed = new URL(String(value ?? '').trim()); } catch { throw new Error('回调地址必须是完整 URL'); }
  if (parsed.username || parsed.password || parsed.hash) throw new Error('回调地址不能包含账号、密码或锚点');
  const allowedHttp = parsed.protocol === 'http:' && config.internalHttpRedirectHosts.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !allowedHttp && !(config.nodeEnv !== 'production' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('回调地址必须使用 HTTPS，或使用已批准的内网 HTTP 主机');
  return parsed.toString();
}
async function updateClient(connection, clientId, transform) {
  const [rows] = await connection.execute("SELECT payload FROM oidc_objects WHERE model='Client' AND id=?", [clientId]);
  if (!rows[0]) throw new Error('OIDC 客户端不存在');
  const payload = decryptJson(JSON.parse(rows[0].payload));
  transform(payload);
  await connection.execute("UPDATE oidc_objects SET payload=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE model='Client' AND id=?", [JSON.stringify(encryptJson(payload)), clientId]);
}
function secretResult(req, title, application, secret, extra = '') {
  return adminPage(req, title, 'applications', `<div class="notice success-notice"><strong>操作成功</strong><p>客户端密钥只显示这一次。请立即写入业务系统的安全配置，不要放入 GitHub。</p></div><section class="card"><div class="detail-list"><div><span>应用</span><strong>${esc(application.name)}</strong></div><div><span>Client ID</span><code>${esc(application.client_id)}</code></div><div><span>Client Secret</span><div class="secret-row"><code class="secret" id="one-time-secret">${esc(secret)}</code><button class="button secondary small" type="button" data-copy="#one-time-secret">复制</button></div></div>${extra}</div><div class="card-actions"><a class="button primary" href="${publicUrl(`/admin/applications/${encodeURIComponent(application.id)}`)}">进入应用配置</a></div></section>`);
}

router.get('/login', (_req, res) => res.send(loginPage('管理员登录', `<p class="login-subtitle">使用具有管理权限的统一认证账号</p><form method="post" class="stack-form"><label>UserID<input name="username" autocomplete="username" placeholder="学号或工号" required></label><label>密码<input type="password" name="password" autocomplete="current-password" placeholder="请输入密码" required></label><button class="button primary">登录控制台</button></form>`)));
router.post('/login', adminLoginLimit, body, async (req, res) => {
  const result = await authenticatePassword(req.body.username, req.body.password);
  if (!result.ok) return res.status(401).send(loginPage('登录失败', '<div class="notice danger">账号或密码错误，或账号当前不可用。</div><a class="button secondary full" href="' + publicUrl('/admin/login') + '">返回登录</a>'));
  const [roles] = await pool.execute("SELECT role FROM system_role_assignments WHERE person_id=? AND status='active'", [result.personId]);
  if (!roles.length) return res.status(403).send(loginPage('无权访问', '<p class="form-note">此账号没有后台管理权限。</p>'));
  res.setHeader('Set-Cookie', cookie(makeSession(result.personId)));
  res.redirect(publicUrl('/admin'));
});
router.post('/logout', requireAdmin, body, requireCsrf, (req, res) => { res.setHeader('Set-Cookie', cookie('', 0)); res.redirect(publicUrl('/admin/login')); });

router.get('/', requireAdmin, async (req, res) => {
  const [[people], [apps], [events], [sessions], [recentApps], [recentEvents]] = await Promise.all([
    pool.execute("SELECT COUNT(*) total,SUM(status IN ('active','probation')) available,SUM(permanent_member=1) permanent FROM people"),
    pool.execute("SELECT COUNT(*) total,SUM(status='active') active,SUM(provisioning_enabled=1) provisioning FROM applications"),
    pool.execute("SELECT COUNT(*) total,SUM(result='failure') failures FROM audit_logs WHERE created_at>=datetime('now','-24 hours')"),
    pool.execute("SELECT COUNT(*) total FROM oidc_objects WHERE model='Session' AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))"),
    pool.execute('SELECT id,client_id,name,access_mode,status,updated_at FROM applications ORDER BY updated_at DESC LIMIT 5'),
    pool.execute('SELECT event_type,result,actor_person_id,target_id,created_at FROM audit_logs ORDER BY id DESC LIMIT 8'),
  ]);
  const p = people[0] ?? {}; const a = apps[0] ?? {}; const e = events[0] ?? {}; const s = sessions[0] ?? {};
  const cards = [[a.active ?? 0, '启用应用', 'applications'], [p.available ?? 0, '可登录人员', 'people'], [s.total ?? 0, '有效会话', 'audit'], [e.total ?? 0, '24 小时认证事件', 'audit']].map(([value, label, link]) => `<a class="stat-card" href="${publicUrl(`/admin/${link}`)}"><span>${label}</span><strong>${value}</strong><small>查看详情 →</small></a>`).join('');
  const appRows = recentApps.map((app) => `<tr><td><a class="table-link" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">${esc(app.name)}</a><small>${esc(app.client_id)}</small></td><td>${app.access_mode === 'all_active' ? '全部有效人员' : '按规则授权'}</td><td>${statusBadge(app.status)}</td><td>${formatTime(app.updated_at)}</td></tr>`).join('');
  const eventRows = recentEvents.map((event) => `<tr><td>${esc(event.event_type)}</td><td>${esc(event.actor_person_id ?? '系统')}</td><td>${badge(event.result, event.result === 'success' ? 'success' : event.result === 'failure' ? 'danger' : 'warning')}</td><td>${formatTime(event.created_at)}</td></tr>`).join('');
  res.send(adminPage(req, '系统概览', 'overview', `<div class="stats-grid">${cards}</div><div class="two-column"><section class="card"><div class="card-header"><div><h2>最近应用</h2><p>统一认证接入状态</p></div><a class="button secondary small" href="${publicUrl('/admin/applications')}">管理应用</a></div><div class="table-wrap"><table><thead><tr><th>应用</th><th>访问策略</th><th>状态</th><th>更新</th></tr></thead><tbody>${appRows || '<tr><td colspan="4" class="empty-cell">暂无应用</td></tr>'}</tbody></table></div></section><section class="card"><div class="card-header"><div><h2>最近认证事件</h2><p>成功、失败与拒绝记录</p></div><a class="button secondary small" href="${publicUrl('/admin/audit')}">查看审计</a></div><div class="table-wrap"><table><thead><tr><th>事件</th><th>主体</th><th>结果</th><th>时间</th></tr></thead><tbody>${eventRows || '<tr><td colspan="4" class="empty-cell">暂无事件</td></tr>'}</tbody></table></div></section></div><section class="card quick-start"><div><h2>接入新业务系统</h2><p>创建应用后获得 Client ID 和一次性 Client Secret，再配置精确回调地址与访问范围。</p></div><a class="button primary" href="${publicUrl('/admin/applications#new-application')}">新建接入应用</a></section>`, '认证、应用与人员状态集中查看'));
});

router.get('/applications', requireAdmin, async (req, res) => {
  const [apps] = await pool.execute(`SELECT a.*,COUNT(DISTINCT r.id) redirect_count,COUNT(DISTINCT ar.id) rule_count FROM applications a LEFT JOIN application_redirect_uris r ON r.application_id=a.id LEFT JOIN application_access_rules ar ON ar.application_id=a.id GROUP BY a.id ORDER BY a.name`);
  const rows = apps.map((app) => `<tr><td><a class="table-link" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">${esc(app.name)}</a><small>${esc(app.client_id)}</small></td><td>${app.access_mode === 'all_active' ? '全部有效人员' : `规则授权（${app.rule_count} 条）`}</td><td>${app.redirect_count}</td><td>${app.provisioning_enabled ? badge('已启用', 'success') : badge('未启用', 'muted')}</td><td>${statusBadge(app.status)}</td><td><a class="button secondary small" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">配置</a></td></tr>`).join('');
  const create = hasRole(req, ['super_admin', 'application_admin']) ? `<section class="card" id="new-application"><div class="card-header"><div><h2>新建接入应用</h2><p>同时创建 OIDC 客户端并生成一次性密钥</p></div></div><form class="form-grid" method="post" action="${publicUrl('/admin/applications')}">${csrf(req)}<label>应用名称<input name="name" maxlength="180" placeholder="例如：值班管理后台" required></label><label>Client ID（可选）<input name="client_id" maxlength="120" placeholder="留空自动生成"></label><label class="span-2">登录回调地址<input name="redirect_uri" type="url" placeholder="http://210.47.163.114/path/sso/callback.php" required></label><label>访问范围<select name="access_mode"><option value="rules">按授权规则</option><option value="all_active">全部有效人员</option></select></label><label class="check-label"><input type="checkbox" name="provisioning_enabled" value="1">允许业务系统发起快捷注册</label><div class="form-actions span-2"><button class="button primary">创建应用并生成密钥</button></div></form></section>` : '';
  res.send(adminPage(req, '应用接入', 'applications', `<section class="card"><div class="card-header"><div><h2>已接入应用</h2><p>管理 OIDC 客户端、回调地址、访问范围和快捷注册</p></div><span class="count">${apps.length} 个应用</span></div><div class="table-wrap"><table><thead><tr><th>应用</th><th>访问范围</th><th>回调</th><th>快捷注册</th><th>状态</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-cell">尚未接入应用</td></tr>'}</tbody></table></div></section>${create}`, '认证平台的核心接入配置'));
});

router.post('/applications', requireAdmin, body, requireCsrf, async (req, res, next) => {
  try {
    if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return;
    const name = String(req.body.name ?? '').trim();
    const clientId = String(req.body.client_id ?? '').trim() || `app_${randomToken(12)}`;
    const redirectUri = validateRedirectUri(req.body.redirect_uri);
    const accessMode = req.body.access_mode === 'all_active' ? 'all_active' : 'rules';
    if (!name || name.length > 180 || !/^[A-Za-z0-9._~-]{3,120}$/.test(clientId)) throw new Error('应用名称或 Client ID 格式不正确');
    const id = randomUUID(); const secret = randomToken(48); const hash = await hashPassword(secret); const now = new Date().toISOString();
    const clientPayload = { client_id: clientId, client_secret: secret, client_name: name, redirect_uris: [redirectUri], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_post', id_token_signed_response_alg: 'ES256' };
    await withTransaction(async (connection) => {
      await connection.execute("INSERT INTO applications(id,client_id,name,client_secret_hash,access_mode,provisioning_enabled,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?)", [id, clientId, name, hash, accessMode, req.body.provisioning_enabled === '1' ? 1 : 0, now, now]);
      await connection.execute('INSERT INTO application_redirect_uris(application_id,redirect_uri,created_at) VALUES (?,?,?)', [id, redirectUri, now]);
      await connection.execute("INSERT INTO oidc_objects(model,id,payload,created_at,updated_at) VALUES ('Client',?,?,?,?)", [clientId, JSON.stringify(encryptJson(clientPayload)), now, now]);
    });
    await audit(req, 'application_create', 'success', { actorPersonId: req.admin.person.id, targetType: 'application', targetId: clientId });
    res.send(secretResult(req, '应用创建成功', { id, name, client_id: clientId }, secret, `<div><span>回调地址</span><code>${esc(redirectUri)}</code></div>`));
  } catch (error) { next(error); }
});

router.get('/applications/:id', requireAdmin, async (req, res) => {
  const [[apps], [redirects], [rules], [departments], [positions]] = await Promise.all([
    pool.execute('SELECT * FROM applications WHERE id=?', [req.params.id]), pool.execute('SELECT * FROM application_redirect_uris WHERE application_id=? ORDER BY id', [req.params.id]), pool.execute('SELECT * FROM application_access_rules WHERE application_id=? ORDER BY id DESC', [req.params.id]), pool.execute("SELECT id,name FROM departments WHERE status='active' ORDER BY name"), pool.execute("SELECT id,name FROM positions WHERE status='active' ORDER BY rank_order DESC,name"),
  ]);
  const app = apps[0]; if (!app) return res.sendStatus(404);
  const canEdit = hasRole(req, ['super_admin', 'application_admin']);
  const redirectRows = redirects.map((item) => `<li><code>${esc(item.redirect_uri)}</code>${canEdit && redirects.length > 1 ? `<form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/redirects/remove`)}">${csrf(req)}<input type="hidden" name="redirect_id" value="${item.id}"><button class="icon-button danger-text" title="移除">×</button></form>` : ''}</li>`).join('');
  const ruleRows = rules.map((rule) => `<tr><td>${rule.effect === 'allow' ? badge('允许', 'success') : badge('拒绝', 'danger')}</td><td>${{ person: '人员', department: '部门', position: '职位' }[rule.subject_type]}</td><td><code>${esc(rule.subject_id)}</code></td><td>${formatTime(rule.starts_at)} — ${formatTime(rule.ends_at)}</td><td>${canEdit ? `<form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/rules/remove`)}">${csrf(req)}<input type="hidden" name="rule_id" value="${rule.id}"><button class="button ghost small">移除</button></form>` : ''}</td></tr>`).join('');
  const subjectOptions = `<optgroup label="人员"><option value="person:">输入 UserID 后提交</option></optgroup><optgroup label="部门">${departments.map((d) => `<option value="department:${esc(d.id)}">${esc(d.name)}</option>`).join('')}</optgroup><optgroup label="职位">${positions.map((p) => `<option value="position:${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>`;
  const controls = canEdit ? `<div class="two-column"><section class="card"><div class="card-header"><div><h2>基本设置</h2><p>控制应用状态和访问模式</p></div></div><form class="form-grid" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/settings`)}">${csrf(req)}<label>应用名称<input name="name" value="${esc(app.name)}" required></label><label>状态<select name="status"><option value="active" ${app.status === 'active' ? 'selected' : ''}>启用</option><option value="disabled" ${app.status === 'disabled' ? 'selected' : ''}>停用</option></select></label><label>访问范围<select name="access_mode"><option value="all_active" ${app.access_mode === 'all_active' ? 'selected' : ''}>全部有效人员</option><option value="rules" ${app.access_mode === 'rules' ? 'selected' : ''}>按规则授权</option></select></label><label class="check-label"><input type="checkbox" name="provisioning_enabled" value="1" ${app.provisioning_enabled ? 'checked' : ''}>允许快捷注册 API</label><div class="form-actions span-2"><button class="button primary">保存设置</button></div></form></section><section class="card"><div class="card-header"><div><h2>客户端密钥</h2><p>密钥不可查看，只能重新生成</p></div></div><div class="danger-zone"><p>轮换后旧密钥立即失效，需要同步更新业务系统配置。</p><form method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/rotate-secret`)}">${csrf(req)}<button class="button danger">轮换 Client Secret</button></form></div></section></div>` : '';
  const addRedirect = canEdit ? `<form class="inline-form" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/redirects`)}">${csrf(req)}<input name="redirect_uri" type="url" placeholder="新增精确回调地址" required><button class="button secondary">添加回调</button></form>` : '';
  const addRule = canEdit && app.access_mode === 'rules' ? `<form class="rule-form" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/rules`)}">${csrf(req)}<select name="effect"><option value="allow">允许</option><option value="deny">拒绝</option></select><select name="subject_choice">${subjectOptions}</select><input name="person_id" placeholder="选择人员时填写 UserID"><input type="datetime-local" name="starts_at"><input type="datetime-local" name="ends_at"><button class="button secondary">添加规则</button></form>` : '';
  const registration = canEdit && app.provisioning_enabled ? `<section class="card"><div class="card-header"><div><h2>生成快捷注册链接</h2><p>15 分钟单次有效，密码只在统一认证中心设置</p></div></div><form class="form-grid compact-grid" method="post" action="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}/registration`)}">${csrf(req)}<label>UserID<input name="user_id" required></label><label>姓名<input name="display_name" required></label><div class="form-actions span-2"><button class="button secondary">生成一次性注册链接</button></div></form></section>` : '';
  res.send(adminPage(req, app.name, 'applications', `<div class="breadcrumb"><a href="${publicUrl('/admin/applications')}">应用接入</a><span>/</span>${esc(app.name)}</div><section class="app-summary"><div><span class="app-avatar">${esc(app.name.slice(0, 1))}</span><div><h2>${esc(app.name)}</h2><code>${esc(app.client_id)}</code></div></div><div>${statusBadge(app.status)} ${app.access_mode === 'all_active' ? badge('全部有效人员') : badge('按规则授权', 'warning')}</div></section>${controls}<section class="card"><div class="card-header"><div><h2>登录回调地址</h2><p>仅允许精确匹配的 OIDC 回调</p></div><span class="count">${redirects.length} 个</span></div><ul class="uri-list">${redirectRows}</ul>${addRedirect}</section><section class="card"><div class="card-header"><div><h2>访问规则</h2><p>拒绝规则优先；按人员、部门或职位授权</p></div><span class="count">${rules.length} 条</span></div>${addRule}<div class="table-wrap"><table><thead><tr><th>效果</th><th>主体类型</th><th>主体</th><th>有效时间</th><th></th></tr></thead><tbody>${ruleRows || '<tr><td colspan="5" class="empty-cell">暂无规则；规则模式下，无允许规则即无法访问</td></tr>'}</tbody></table></div></section>${registration}`, `Client ID：${app.client_id}`));
});

router.post('/applications/:id/settings', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const name = String(req.body.name ?? '').trim(); if (!name || !['active', 'disabled'].includes(req.body.status) || !['all_active', 'rules'].includes(req.body.access_mode)) return res.sendStatus(400); await withTransaction(async (connection) => { const [apps] = await connection.execute('SELECT client_id FROM applications WHERE id=?', [req.params.id]); if (!apps[0]) throw new Error('应用不存在'); await connection.execute("UPDATE applications SET name=?,status=?,access_mode=?,provisioning_enabled=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [name, req.body.status, req.body.access_mode, req.body.provisioning_enabled === '1' ? 1 : 0, req.params.id]); await updateClient(connection, apps[0].client_id, (payload) => { payload.client_name = name; }); }); await audit(req, 'application_update', 'success', { actorPersonId: req.admin.person.id, targetType: 'application', targetId: req.params.id }); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}`)); } catch (error) { next(error); } });
router.post('/applications/:id/redirects', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const uri = validateRedirectUri(req.body.redirect_uri); await withTransaction(async (connection) => { const [apps] = await connection.execute('SELECT client_id FROM applications WHERE id=?', [req.params.id]); if (!apps[0]) throw new Error('应用不存在'); await connection.execute("INSERT INTO application_redirect_uris(application_id,redirect_uri,created_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", [req.params.id, uri]); await updateClient(connection, apps[0].client_id, (payload) => { payload.redirect_uris = [...new Set([...(payload.redirect_uris ?? []), uri])]; }); }); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}`)); } catch (error) { next(error); } });
router.post('/applications/:id/redirects/remove', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; await withTransaction(async (connection) => { const [items] = await connection.execute('SELECT r.redirect_uri,a.client_id,(SELECT COUNT(*) FROM application_redirect_uris WHERE application_id=a.id) total FROM application_redirect_uris r JOIN applications a ON a.id=r.application_id WHERE r.id=? AND r.application_id=?', [req.body.redirect_id, req.params.id]); if (!items[0] || items[0].total <= 1) throw new Error('应用必须至少保留一个回调地址'); await connection.execute('DELETE FROM application_redirect_uris WHERE id=?', [req.body.redirect_id]); await updateClient(connection, items[0].client_id, (payload) => { payload.redirect_uris = (payload.redirect_uris ?? []).filter((uri) => uri !== items[0].redirect_uri); }); }); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}`)); } catch (error) { next(error); } });
router.post('/applications/:id/rotate-secret', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const secret = randomToken(48); const hash = await hashPassword(secret); let app; await withTransaction(async (connection) => { const [apps] = await connection.execute('SELECT id,name,client_id FROM applications WHERE id=?', [req.params.id]); app = apps[0]; if (!app) throw new Error('应用不存在'); await connection.execute("UPDATE applications SET client_secret_hash=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [hash, app.id]); await updateClient(connection, app.client_id, (payload) => { payload.client_secret = secret; }); }); await audit(req, 'client_secret_rotate', 'success', { actorPersonId: req.admin.person.id, targetType: 'application', targetId: app.client_id }); res.send(secretResult(req, '密钥轮换成功', app, secret)); } catch (error) { next(error); } });
router.post('/applications/:id/rules', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const [choiceType, choiceId] = String(req.body.subject_choice ?? '').split(':', 2); const type = choiceType; const subjectId = type === 'person' ? String(req.body.person_id ?? '').trim() : choiceId; if (!['person', 'department', 'position'].includes(type) || !subjectId || !['allow', 'deny'].includes(req.body.effect)) return res.sendStatus(400); const table = { person: 'people', department: 'departments', position: 'positions' }[type]; const [subject] = await pool.execute(`SELECT id FROM ${table} WHERE id=?`, [subjectId]); if (!subject[0]) throw new Error('授权主体不存在'); const starts = req.body.starts_at ? new Date(req.body.starts_at).toISOString() : null; const ends = req.body.ends_at ? new Date(req.body.ends_at).toISOString() : null; if (starts && ends && starts >= ends) throw new Error('结束时间必须晚于开始时间'); await pool.execute("INSERT INTO application_access_rules(application_id,effect,subject_type,subject_id,starts_at,ends_at,created_at) VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", [req.params.id, req.body.effect, type, subjectId, starts, ends]); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}`)); } catch (error) { next(error); } });
router.post('/applications/:id/rules/remove', requireAdmin, body, requireCsrf, async (req, res) => { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; await pool.execute('DELETE FROM application_access_rules WHERE id=? AND application_id=?', [req.body.rule_id, req.params.id]); res.redirect(publicUrl(`/admin/applications/${encodeURIComponent(req.params.id)}`)); });
router.post('/applications/:id/registration', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'application_admin'])) return; const userId = String(req.body.user_id ?? '').trim(); const displayName = String(req.body.display_name ?? '').trim(); if (!/^[A-Za-z0-9_.@-]{2,120}$/.test(userId) || !displayName || displayName.length > 160) return res.sendStatus(400); const [apps] = await pool.execute('SELECT id,name,client_id FROM applications WHERE id=? AND provisioning_enabled=1', [req.params.id]); const app = apps[0]; if (!app) throw new Error('该应用未启用快捷注册'); const token = randomToken(32); const id = randomUUID(); const expires = new Date(Date.now() + 15 * 60_000).toISOString(); await pool.execute("INSERT INTO quick_registration_tokens(id,application_id,token_hash,user_id,display_name,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))", [id, app.id, sha256(token), userId, displayName, expires, req.admin.person.id]); const url = `${config.issuer}/register/${token}`; res.send(adminPage(req, '注册链接已生成', 'applications', `<div class="notice success-notice"><strong>链接 15 分钟内单次有效</strong><p>请发送给 ${esc(displayName)}（${esc(userId)}），密码只在统一认证中心设置。</p></div><section class="card"><div class="secret-row"><code class="secret" id="registration-url">${esc(url)}</code><button class="button secondary small" type="button" data-copy="#registration-url">复制链接</button></div><div class="card-actions"><a class="button primary" href="${publicUrl(`/admin/applications/${encodeURIComponent(app.id)}`)}">返回应用</a></div></section>`)); } catch (error) { next(error); } });

router.get('/people', requireAdmin, async (req, res) => {
  const [people] = await pool.execute(`SELECT p.id,p.display_name,p.grade_year,p.status,p.permanent_member,a.status account_status,a.last_login_at,d.name department,pos.name position FROM people p LEFT JOIN accounts a ON a.person_id=p.id LEFT JOIN appointments ap ON ap.person_id=p.id AND ap.status='active' LEFT JOIN departments d ON d.id=ap.department_id LEFT JOIN positions pos ON pos.id=ap.position_id ORDER BY p.permanent_member DESC,p.grade_year,p.id LIMIT 300`);
  const canEdit = hasRole(req, ['super_admin', 'personnel_admin']);
  const rows = people.map((p) => `<tr><td><strong>${esc(p.display_name)}</strong><small>${esc(p.id)}</small></td><td>${esc(p.department ?? '—')}<small>${esc(p.position ?? '未设置')}</small></td><td>${esc(p.grade_year ?? '—')}</td><td>${statusBadge(p.status)} ${p.permanent_member ? badge('永久', 'info') : ''}</td><td>${formatTime(p.last_login_at)}</td><td>${canEdit ? `<form class="row-form" method="post" action="${publicUrl(`/admin/people/${encodeURIComponent(p.id)}`)}">${csrf(req)}<select name="status">${['candidate','probation','active','retired','left','graduated','dismissed'].map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><select name="permanent_member"><option value="0" ${p.permanent_member ? '' : 'selected'}>正常</option><option value="1" ${p.permanent_member ? 'selected' : ''}>永久</option></select><button class="button ghost small">保存</button></form>` : ''}</td></tr>`).join('');
  res.send(adminPage(req, '人员与账号', 'people', `<section class="card"><div class="card-header"><div><h2>统一人员目录</h2><p>UserID 是企业微信身份和各业务系统的唯一主键</p></div><span class="count">${people.length} 人</span></div><div class="table-wrap"><table><thead><tr><th>人员</th><th>部门 / 职位</th><th>年级</th><th>状态</th><th>最近登录</th><th>管理</th></tr></thead><tbody>${rows}</tbody></table></div></section>`, '人员状态会实时影响所有接入应用'));
});

router.get('/terms', requireAdmin, async (req, res) => {
  const [[terms], [people], [departments], [positions], [turnovers]] = await Promise.all([pool.execute('SELECT * FROM organization_terms ORDER BY starts_at DESC LIMIT 20'), pool.execute("SELECT id,display_name FROM people WHERE status IN ('active','probation','candidate','retired') ORDER BY id"), pool.execute("SELECT id,name FROM departments WHERE status='active' ORDER BY name"), pool.execute("SELECT id,name FROM positions WHERE status='active' ORDER BY rank_order DESC,name"), pool.execute('SELECT * FROM turnover_runs ORDER BY started_at DESC LIMIT 20')]);
  const canEdit = hasRole(req, ['super_admin', 'personnel_admin']);
  const termRows = terms.map((t) => `<tr><td><strong>${esc(t.name)}</strong><small>${esc(t.id)}</small></td><td>${formatTime(t.starts_at)}<small>至 ${formatTime(t.ends_at)}</small></td><td>${statusBadge(t.status)}</td><td>${canEdit ? `<div class="action-row"><form method="post" action="${publicUrl('/admin/turnovers/start')}">${csrf(req)}<input type="hidden" name="term_id" value="${esc(t.id)}"><button class="button ghost small">开始换届</button></form><form method="post" action="${publicUrl(`/admin/terms/${encodeURIComponent(t.id)}/review`)}">${csrf(req)}<button class="button ghost small">提交复核</button></form><form method="post" action="${publicUrl(`/admin/terms/${encodeURIComponent(t.id)}/publish`)}">${csrf(req)}<button class="button primary small">发布</button></form></div>` : ''}</td></tr>`).join('');
  const forms = canEdit ? `<div class="two-column"><section class="card"><div class="card-header"><div><h2>新建届次</h2><p>先建立草稿，再编制任职名单</p></div></div><form class="form-grid" method="post" action="${publicUrl('/admin/terms')}">${csrf(req)}<label>届次编号<input name="id" placeholder="term-2027-2028" required></label><label>显示名称<input name="name" placeholder="2027—2028 届" required></label><label>开始时间<input type="datetime-local" name="starts_at" required></label><label>结束时间<input type="datetime-local" name="ends_at" required></label><div class="form-actions span-2"><button class="button primary">创建草稿</button></div></form></section><section class="card"><div class="card-header"><div><h2>添加任职</h2><p>加入草稿或复核中的新届名单</p></div></div><form class="form-grid" method="post" action="${publicUrl('/admin/appointments')}">${csrf(req)}<label>人员<select name="person_id">${people.map((p) => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.display_name)}</option>`).join('')}</select></label><label>届次<select name="term_id">${terms.filter((t) => ['draft','review'].includes(t.status)).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label><label>部门<select name="department_id">${departments.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><label>职位<select name="position_id">${positions.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><div class="form-actions span-2"><button class="button secondary">加入待发布名单</button></div></form></section></div>` : '';
  const turnoverRows = turnovers.map((t) => `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.target_term_id)}</td><td>${statusBadge(t.status)}</td><td>${formatTime(t.started_at)}</td><td>${formatTime(t.completed_at)}</td></tr>`).join('');
  res.send(adminPage(req, '届次与换届', 'terms', `${forms}<section class="card"><div class="card-header"><div><h2>届次</h2><p>发布新届时原子切换人员任职</p></div></div><div class="table-wrap"><table><thead><tr><th>届次</th><th>有效时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${termRows}</tbody></table></div></section><section class="card"><div class="card-header"><div><h2>换届记录</h2><p>永久人员不受自动暂停影响</p></div></div><div class="table-wrap"><table><thead><tr><th>记录 ID</th><th>目标届次</th><th>状态</th><th>开始</th><th>完成</th></tr></thead><tbody>${turnoverRows || '<tr><td colspan="5" class="empty-cell">暂无记录</td></tr>'}</tbody></table></div></section>`, '人员管理的年度附加流程'));
});

router.get('/audit', requireAdmin, async (req, res) => {
  if (forbidUnless(req, res, ['super_admin', 'security_admin', 'audit_viewer', 'application_admin'])) return;
  const [logs] = await pool.execute('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300');
  const rows = logs.map((log) => `<tr><td>${formatTime(log.created_at)}</td><td>${esc(log.event_type)}</td><td>${esc(log.actor_person_id ?? '系统')}</td><td>${esc(log.target_id ?? '—')}</td><td>${badge(log.result, log.result === 'success' ? 'success' : log.result === 'failure' ? 'danger' : 'warning')}</td><td><code>${esc(log.ip_address ?? '—')}</code></td></tr>`).join('');
  res.send(adminPage(req, '登录与审计', 'audit', `<section class="card"><div class="card-header"><div><h2>最近 300 条事件</h2><p>登录、扫码、应用访问和管理操作</p></div></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>事件</th><th>人员</th><th>目标</th><th>结果</th><th>来源 IP</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-cell">暂无记录</td></tr>'}</tbody></table></div></section>`, '用于问题排查和安全追溯'));
});

router.get('/integration', requireAdmin, (req, res) => {
  const endpoints = [['Issuer', config.issuer], ['Discovery', `${config.issuer}/.well-known/openid-configuration`], ['Authorization', `${config.issuer}/auth`], ['Token', `${config.issuer}/token`], ['UserInfo', `${config.issuer}/me`], ['JWKS', `${config.issuer}/jwks`]];
  const rows = endpoints.map(([name, url]) => `<div class="endpoint-row"><span>${name}</span><code id="ep-${name}">${esc(url)}</code><button type="button" class="button ghost small" data-copy="#ep-${name}">复制</button></div>`).join('');
  res.send(adminPage(req, '接入指南', 'integration', `<section class="card"><div class="card-header"><div><h2>OIDC 服务地址</h2><p>业务系统优先通过 Discovery 自动读取端点</p></div></div><div class="endpoint-list">${rows}</div></section><div class="two-column"><section class="card"><h2>标准接入流程</h2><ol class="steps"><li><span>1</span><div><strong>在“应用接入”中新建应用</strong><p>填写名称和精确回调地址，保存一次性 Client Secret。</p></div></li><li><span>2</span><div><strong>业务系统安装通用 SDK</strong><p>配置 Issuer、Client ID、Client Secret 和回调地址。</p></div></li><li><span>3</span><div><strong>配置访问范围</strong><p>选择全部有效人员，或按人员、部门、职位添加规则。</p></div></li><li><span>4</span><div><strong>从业务入口验收</strong><p>测试密码登录、企业微信扫码、免重复登录和无权拒绝。</p></div></li></ol></section><section class="card"><h2>业务系统获得的身份</h2><div class="claim-list"><code>sub</code><span>唯一 UserID（本企业为学号）</span><code>preferred_username</code><span>登录账号</span><code>name</code><span>姓名</span><code>department</code><span>当前部门</span><code>position</code><span>当前职位</span></div><div class="notice info">业务系统不写登录页面，也不接触用户密码；只需发起 OIDC 登录并读取回调身份。</div></section></div>`, '给业务开发人员和 Agent 使用的参数'));
});

router.post('/terms', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; const starts = new Date(req.body.starts_at).toISOString(); const ends = new Date(req.body.ends_at).toISOString(); if (starts >= ends) throw new Error('开始时间必须早于结束时间'); const now = new Date().toISOString(); await pool.execute("INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?)", [req.body.id, req.body.name, starts, ends, now, now]); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/turnovers/start', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; await startTurnover(req.body.term_id, req.admin.person.id); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/terms/:id/review', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; const [result] = await pool.execute("UPDATE organization_terms SET status='review',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'", [req.params.id]); if (!result.changes) throw new Error('只有草稿届次可以提交复核'); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/terms/:id/publish', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; await publishTerm(req.params.id, req.admin.person.id); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/appointments', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; const [terms] = await pool.execute("SELECT starts_at,ends_at FROM organization_terms WHERE id=? AND status IN ('draft','review')", [req.body.term_id]); if (!terms[0]) throw new Error('请选择草稿或复核中的届次'); const now = new Date().toISOString(); await pool.execute("INSERT INTO appointments(id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,'pending',?,?)", [randomUUID(), req.body.person_id, req.body.term_id, req.body.department_id, req.body.position_id, terms[0].starts_at, terms[0].ends_at, now, now]); res.redirect(publicUrl('/admin/terms')); } catch (error) { next(error); } });
router.post('/people/:id', requireAdmin, body, requireCsrf, async (req, res, next) => { try { if (forbidUnless(req, res, ['super_admin', 'personnel_admin'])) return; const allowed = new Set(['candidate','probation','active','retired','left','graduated','dismissed']); if (!allowed.has(req.body.status) || !['0','1'].includes(req.body.permanent_member)) return res.sendStatus(400); if (req.params.id === req.admin.person.id && req.body.status !== 'active') throw new Error('不能停用当前登录账号'); await pool.execute("UPDATE people SET status=?,permanent_member=?,authorization_version=authorization_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [req.body.status, Number(req.body.permanent_member), req.params.id]); res.redirect(publicUrl('/admin/people')); } catch (error) { next(error); } });

export const adminRouter = router;
