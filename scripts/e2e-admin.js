import assert from 'node:assert/strict';

const base = process.env.E2E_ISSUER ?? 'http://127.0.0.1:3000';
const username = process.env.E2E_USERNAME;
const password = process.env.E2E_PASSWORD;
const basePath = new URL(base).pathname.replace(/\/$/, '');
assert.ok(username && password);

const login = await fetch(`${base}/admin/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username, password }),
});
assert.equal(login.status, 302);
assert.equal(login.headers.get('location'), `${basePath}/admin`);
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
assert.match(cookie ?? '', /^enterprise_admin=/);
const dashboard = await fetch(`${base}/admin`, { headers: { cookie } });
assert.equal(dashboard.status, 200);
const html = await dashboard.text();
assert.match(html, /系统概览/);
assert.match(html, /统一认证<small>管理控制台/);
assert.match(html, /应用接入/);
assert.match(html, /人员与账号/);
assert.match(html, /登录与审计/);
assert.match(html, /\/assets\/admin\.css/);
assert.doesNotMatch(html, /<style(?:\s|>)/i);
assert.doesNotMatch(html, /CI-only-password/);
const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
assert.ok(csrf);
const stylesheet = await fetch(`${base}/assets/admin.css`);
assert.equal(stylesheet.status, 200);
assert.match(await stylesheet.text(), /\.admin-page/);
const adminScript = await fetch(`${base}/assets/admin.js`);
assert.equal(adminScript.status, 200);

for (const [path, marker] of [
  ['/admin/applications', /新建接入应用/],
  ['/admin/people', /统一人员目录/],
  ['/admin/terms', /届次与换届/],
  ['/admin/audit', /最近 300 条事件/],
  ['/admin/integration', /OIDC 服务地址/],
]) {
  const page = await fetch(`${base}${path}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), marker);
}

const created = await fetch(`${base}/admin/applications`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    csrf,
    name: 'CI 后台接入测试',
    client_id: 'ci-admin-created-app',
    redirect_uri: 'http://127.0.0.1:8080/admin-created-callback',
    access_mode: 'rules',
    provisioning_enabled: '1',
  }),
});
assert.equal(created.status, 200);
const createdHtml = await created.text();
assert.match(createdHtml, /应用创建成功/);
assert.match(createdHtml, /客户端密钥只显示这一次/);
assert.doesNotMatch(createdHtml, /CI-only-password/);
const applications = await fetch(`${base}/admin/applications`, { headers: { cookie } });
assert.match(await applications.text(), /CI 后台接入测试/);

console.log(JSON.stringify({ ok: true, flow: 'central_admin_password_session', dashboard: 'rendered', modules: ['applications', 'people', 'terms', 'audit', 'integration'], application_creation: 'verified', stylesheet: 'loaded', password_exposure: false }, null, 2));
