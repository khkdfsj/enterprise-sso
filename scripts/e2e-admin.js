import assert from 'node:assert/strict';

const base = process.env.E2E_ISSUER ?? 'http://127.0.0.1:3000';
const username = process.env.E2E_USERNAME;
const password = process.env.E2E_PASSWORD;
assert.ok(username && password);

const login = await fetch(`${base}/admin/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username, password }),
});
assert.equal(login.status, 302);
assert.equal(login.headers.get('location'), '/admin');
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
assert.match(cookie ?? '', /^enterprise_admin=/);
const dashboard = await fetch(`${base}/admin`, { headers: { cookie } });
assert.equal(dashboard.status, 200);
const html = await dashboard.text();
assert.match(html, /统一认证管理后台/);
assert.match(html, /当前管理员：开发管理员/);
assert.doesNotMatch(html, /CI-only-password/);
console.log(JSON.stringify({ ok: true, flow: 'central_admin_password_session', dashboard: 'rendered', password_exposure: false }, null, 2));
