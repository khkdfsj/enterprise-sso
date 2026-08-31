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
assert.match(html, /统一认证管理后台/);
assert.match(html, /当前管理员：开发管理员/);
assert.match(html, /\/assets\/admin\.css/);
assert.doesNotMatch(html, /<style(?:\s|>)/i);
assert.doesNotMatch(html, /CI-only-password/);
const stylesheet = await fetch(`${base}/assets/admin.css`);
assert.equal(stylesheet.status, 200);
assert.match(await stylesheet.text(), /\.admin-page/);
console.log(JSON.stringify({ ok: true, flow: 'central_admin_password_session', dashboard: 'rendered', stylesheet: 'loaded', password_exposure: false }, null, 2));
