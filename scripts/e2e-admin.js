import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';

const base = process.env.E2E_ISSUER ?? 'http://127.0.0.1:3000';
const username = process.env.E2E_USERNAME;
const password = process.env.E2E_PASSWORD;
assert.ok(username && password);

const cookies = new Map();
function storeCookies(response) {
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';', 1)[0];
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const content = pair.slice(separator + 1);
    if (content) cookies.set(name, content); else cookies.delete(name);
  }
}
function cookieHeader() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
async function request(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookies.size) headers.set('cookie', cookieHeader());
  const response = await fetch(url, { ...options, headers, redirect: 'manual' });
  storeCookies(response);
  return response;
}
function nextUrl(current, response) {
  const location = response.headers.get('location');
  assert.ok(location, `Expected redirect from ${current}, got ${response.status}`);
  return new URL(location, current).toString();
}
function unzip(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(compressed).toString('utf8') : compressed.toString('utf8'));
    offset = start + compressedSize;
  }
  return files;
}

let response = await request(`${base}/admin/login`);
assert.equal(response.status, 302);
let current = nextUrl(`${base}/admin/login`, response);
response = await request(current);
current = nextUrl(current, response);
response = await request(current);
const hostedLogin = await response.text();
assert.equal(response.status, 200);
assert.match(hostedLogin, /部门统一身份认证/);
const loginCsrf = hostedLogin.match(/name="csrf" value="([^"]+)"/)?.[1];
assert.ok(loginCsrf);
const passwordUrl = `${new URL(current).origin}${new URL(current).pathname}/password`;
response = await request(passwordUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrf: loginCsrf, username, password }),
});
current = nextUrl(passwordUrl, response);
for (let redirects = 0; redirects < 10 && !current.includes('/admin/callback'); redirects += 1) {
  response = await request(current);
  current = nextUrl(current, response);
}
assert.match(current, /\/admin\/callback/);
response = await request(current);
assert.equal(response.status, 302);
assert.match(response.headers.get('set-cookie') ?? '', /enterprise_admin=/);

const dashboard = await request(new URL(response.headers.get('location'), current));
assert.equal(dashboard.status, 200);
const html = await dashboard.text();
assert.match(html, /系统概览/);
assert.match(html, /接入服务管理/);
assert.match(html, /部门人员管理/);
assert.match(html, /系统管理/);
assert.match(html, /新增接入服务/);
assert.match(html, /\/assets\/admin\.css/);
assert.doesNotMatch(html, /<style(?:\s|>)/i);
assert.doesNotMatch(html, /CI-only-password/);
const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
assert.ok(csrf);

for (const [path, marker] of [
  ['/admin/applications', /服务纵览/],
  ['/admin/applications/new', /登记项目基本信息/],
  ['/admin/monitoring', /服务连通状态/],
  ['/admin/people', /统一人员目录/],
  ['/admin/organization', /部门与职位/],
  ['/admin/terms', /五步换届流程/],
  ['/admin/turnovers/new', /确定目标届次与新委员年级/],
  ['/admin/sessions', /统一认证会话/],
  ['/admin/audit', /最近 300 条事件/],
  ['/admin/integration', /ESSO-DFSJ 文件说明/],
]) {
  const page = await request(`${base}${path}`);
  assert.equal(page.status, 200, path);
  assert.match(await page.text(), marker);
}

let generatedSecret = '';
const probe = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    ok: true,
    client_id: 'ci-admin-created-app',
    signature: createHmac('sha256', generatedSecret).update('enterprise-sso-connectivity-v1').digest('hex'),
  }));
});
await new Promise((resolve) => probe.listen(8081, '127.0.0.1', resolve));
try {
  const created = await request(`${base}/admin/applications`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf,
      name: 'CI 后台接入测试',
      client_id: 'ci-admin-created-app',
      project_root_url: 'http://127.0.0.1:8081/',
      access_mode: 'rules',
      provisioning_enabled: '1',
    }),
  });
  assert.equal(created.status, 200);
  const createdHtml = await created.text();
  assert.match(createdHtml, /下载 ESSO-DFSJ 接入包/);
  assert.doesNotMatch(createdHtml, /id="wizard-secret"/);
  const appId = createdHtml.match(/\/admin\/applications\/([^/]+)\/monitor\/start/)?.[1];
  const packagePath = createdHtml.match(/href="([^"]+\/package\/[^"]+)"/)?.[1];
  assert.ok(packagePath && appId);
  const packageResponse = await request(new URL(packagePath, base));
  assert.equal(packageResponse.status, 200);
  assert.equal(packageResponse.headers.get('content-type'), 'application/zip');
  assert.match(packageResponse.headers.get('content-disposition') ?? '', /ESSO-DFSJ\.zip/);
  const packageFiles = unzip(Buffer.from(await packageResponse.arrayBuffer()));
  for (const file of ['config.php', 'SsoClient.php', 'login.php', 'callback.php', 'logout.php', 'health.php', 'test-login.php', 'test-logout.php', 'README.txt']) {
    assert.ok(packageFiles.has(`ESSO-DFSJ/${file}`), file);
  }
  assert.match(packageFiles.get('ESSO-DFSJ/README.txt'), /禁止改名/);
  assert.match(packageFiles.get('ESSO-DFSJ/login.php'), /\$ssoUser/);
  assert.match(packageFiles.get('ESSO-DFSJ/login.php'), /\$essoLogoutUrl/);
  assert.match(packageFiles.get('ESSO-DFSJ/config.php'), /ESSO-DFSJ\/callback\.php/);
  generatedSecret = packageFiles.get('ESSO-DFSJ/config.php').match(/'client_secret' => '([^']+)'/)?.[1] ?? '';
  assert.ok(generatedSecret);
  const expiredDownload = await request(new URL(packagePath, base));
  assert.equal(expiredDownload.status, 410);

  const started = await request(`${base}/admin/applications/${appId}/monitor/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(started.status, 302);
  let onboarding = await request(new URL(started.headers.get('location'), base));
  let onboardingHtml = await onboarding.text();
  assert.match(onboardingHtml, /基础连通与凭据/);
  assert.match(onboardingHtml, /业务系统和客户端凭据均已验证/);

  const timestamp = Math.floor(Date.now() / 1000);
  const proof = createHmac('sha256', generatedSecret).update(`login|dev-admin|${timestamp}`).digest('hex');
  response = await request(`${base}/admin/applications/${appId}/verify-login?sub=dev-admin&ts=${timestamp}&proof=${proof}`);
  assert.equal(response.status, 302);
  response = await request(`${base}/admin/applications/${appId}/verify-logout`);
  assert.equal(response.status, 302);
  onboarding = await request(`${base}/admin/applications/${appId}/onboarding?step=3`);
  onboardingHtml = await onboarding.text();
  assert.match(onboardingHtml, /接入验收全部通过/);
  assert.match(onboardingHtml, /认证、注销和连通性都提供代码与真实测试/);

  const database = new DatabaseSync(process.env.E2E_DB_FILE);
  database.prepare("UPDATE system_role_assignments SET status='disabled' WHERE person_id='dev-admin' AND role='super_admin'").run();
  let list = await request(`${base}/admin/applications`);
  assert.equal(list.status, 403);
  const now = new Date();
  const starts = new Date(now.getTime() - 3600_000).toISOString();
  const ends = new Date(now.getTime() + 3600_000).toISOString();
  database.prepare("INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES ('ci-delete-term','CI','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','active',?,?)").run(starts, starts);
  database.prepare("INSERT INTO departments(id,name,code,status,created_at,updated_at) VALUES ('ci-delete-dept','CI','ci-delete-dept','active',?,?)").run(starts, starts);
  database.prepare("INSERT INTO positions(id,code,name,rank_order,status,created_at,updated_at) VALUES ('ci-teacher','teacher','指导老师',10,'active',?,?)").run(starts, starts);
  database.prepare("INSERT INTO appointments(id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,created_at,updated_at) VALUES (?,'dev-admin','ci-delete-term','ci-delete-dept','ci-teacher',1,?,?,'active',?,?)").run(randomUUID(), starts, ends, starts, starts);
  list = await request(`${base}/admin/applications`);
  assert.equal(list.status, 200);
  assert.match(await list.text(), new RegExp(`/admin/applications/${appId}/delete`));
  database.prepare("UPDATE appointments SET status='ended' WHERE person_id='dev-admin' AND position_id='ci-teacher'").run();
  database.prepare("INSERT INTO positions(id,code,name,rank_order,status,created_at,updated_at) VALUES ('ci-minister','minister','部长',40,'active',?,?)").run(starts, starts);
  database.prepare("INSERT INTO appointments(id,person_id,term_id,department_id,position_id,is_primary,starts_at,ends_at,status,created_at,updated_at) VALUES (?,'dev-admin','ci-delete-term','ci-delete-dept','ci-minister',1,?,?,'active',?,?)").run(randomUUID(), starts, ends, starts, starts);
  database.close();
  list = await request(`${base}/admin/applications`);
  assert.equal(list.status, 403, 'non-operations minister must not see service management');
  const operationsDatabase = new DatabaseSync(process.env.E2E_DB_FILE);
  operationsDatabase.prepare("UPDATE departments SET name='运行部',code='operations' WHERE id='ci-delete-dept'").run();
  operationsDatabase.close();
  list = await request(`${base}/admin/applications`);
  assert.equal(list.status, 200, 'operations member can see service management');
  const listHtml = await list.text();
  assert.match(listHtml, new RegExp(`/admin/applications/${appId}/delete`), 'service creator can manage own service');
  const deletePage = await request(`${base}/admin/applications/${appId}/delete`);
  assert.equal(deletePage.status, 200);
  assert.match(await deletePage.text(), /确认永久删除/);
  const deleted = await request(`${base}/admin/applications/${appId}/delete`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, confirm_name: 'CI 后台接入测试' }),
  });
  assert.equal(deleted.status, 302);
  const deletedList = await request(new URL(deleted.headers.get('location'), base));
  assert.doesNotMatch(await deletedList.text(), /ci-admin-created-app/);
  const restoreDatabase = new DatabaseSync(process.env.E2E_DB_FILE);
  restoreDatabase.prepare("INSERT INTO organization_terms(id,name,starts_at,ends_at,status,created_at,updated_at) VALUES ('ci-draft-target','CI 待删除届次',?,?, 'draft',?,?)").run(starts, ends, starts, starts);
  restoreDatabase.prepare("INSERT INTO turnover_workflows(id,source_term_id,target_term_id,target_grade_year,current_step,status,created_by,created_at,updated_at) VALUES ('ci-draft-workflow','ci-delete-term','ci-draft-target',2026,2,'draft','dev-admin',?,?)").run(starts, starts);
  restoreDatabase.close();
  const terms = await request(`${base}/admin/terms`);
  assert.equal(terms.status, 200);
  assert.match(await terms.text(), /\/admin\/turnovers\/ci-draft-workflow\/delete/);
  const draftDeletePage = await request(`${base}/admin/turnovers/ci-draft-workflow/delete`);
  assert.equal(draftDeletePage.status, 200);
  assert.match(await draftDeletePage.text(), /确认删除草稿/);
  const wrongDraftName = await request(`${base}/admin/turnovers/ci-draft-workflow/delete`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, confirm_name: '错误名称' }),
  });
  assert.equal(wrongDraftName.status, 400);
  assert.match(await wrongDraftName.text(), /输入的目标届次名称不一致/);
  const deletedDraft = await request(`${base}/admin/turnovers/ci-draft-workflow/delete`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, confirm_name: 'CI 待删除届次' }),
  });
  assert.equal(deletedDraft.status, 302);
  const deletedDraftList = await request(new URL(deletedDraft.headers.get('location'), base));
  assert.match(await deletedDraftList.text(), /草稿已删除/);
  const verifyDatabase = new DatabaseSync(process.env.E2E_DB_FILE);
  assert.equal(verifyDatabase.prepare("SELECT COUNT(*) count FROM turnover_workflows WHERE id='ci-draft-workflow'").get().count, 0);
  assert.equal(verifyDatabase.prepare("SELECT COUNT(*) count FROM organization_terms WHERE id='ci-draft-target'").get().count, 0);
  assert.equal(verifyDatabase.prepare("SELECT COUNT(*) count FROM organization_terms WHERE id='ci-delete-term'").get().count, 1);
  verifyDatabase.prepare("UPDATE system_role_assignments SET status='active' WHERE person_id='dev-admin' AND role='super_admin'").run();
  verifyDatabase.close();

  const batchPage = await request(`${base}/admin/people/batch?term=ci-delete-term`);
  assert.equal(batchPage.status, 200);
  assert.match(await batchPage.text(), /向已建届次批量加入委员/);
  const batchCreated = await request(`${base}/admin/people/batch`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, term_id: 'ci-delete-term', grade_year: '2026', default_department_id: 'ci-delete-dept', batch: '2026123401,批量甲\n2026123402,批量乙,运行部' }),
  });
  assert.equal(batchCreated.status, 302);
  const batchDatabase = new DatabaseSync(process.env.E2E_DB_FILE);
  assert.equal(batchDatabase.prepare("SELECT COUNT(*) count FROM appointments a JOIN positions p ON p.id=a.position_id WHERE a.term_id='ci-delete-term' AND a.person_id IN ('2026123401','2026123402') AND p.name='委员'").get().count, 2);
  batchDatabase.close();

  const platformPage = await request(`${base}/admin/people/2026123401/platform-access?term=ci-delete-term`);
  assert.equal(platformPage.status, 200);
  assert.match(await platformPage.text(), /平台身份与部长、副部长、委员等部门职务完全独立/);
  const platformUpdated = await request(`${base}/admin/people/2026123401/platform-access`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, term: 'ci-delete-term', platform_identity: 'admin', permanent_member: '1' }),
  });
  assert.equal(platformUpdated.status, 302);
  const privilegeDatabase = new DatabaseSync(process.env.E2E_DB_FILE);
  assert.equal(privilegeDatabase.prepare("SELECT permanent_member FROM people WHERE id='2026123401'").get().permanent_member, 1);
  assert.equal(privilegeDatabase.prepare("SELECT status FROM system_role_assignments WHERE person_id='2026123401' AND role='super_admin'").get().status, 'active');
  privilegeDatabase.close();
} finally {
  await new Promise((resolve) => probe.close(resolve));
}

console.log(JSON.stringify({
  ok: true,
  flow: 'admin_via_internal_oidc',
  navigation: ['service_management', 'personnel_management', 'system_management'],
  onboarding: ['registration', 'ESSO-DFSJ_package', 'signed_connectivity', 'login_verification', 'logout_verification'],
  permissions: 'platform_identity_independent_from_department_position',
  batch_members: 'existing_term_supported',
  deletion: 'service_creator_or_platform_admin_with_confirmation',
  password_exposure: false,
}, null, 2));
