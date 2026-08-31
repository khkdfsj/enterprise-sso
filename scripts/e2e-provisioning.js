import assert from 'node:assert/strict';
import { database, pool } from '../src/db.js';
import { authenticatePassword } from '../src/repositories/accounts.js';

const base = process.env.E2E_ISSUER ?? 'http://127.0.0.1:3000';
const clientId = process.env.E2E_CLIENT_ID;
const clientSecret = process.env.E2E_CLIENT_SECRET;
assert.ok(clientId && clientSecret);
database.prepare('UPDATE applications SET provisioning_enabled=1 WHERE client_id=?').run(clientId);

const authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
const created = await fetch(`${base}/api/v1/registrations`, {
  method: 'POST',
  headers: { authorization, 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: '2026999999', display_name: '快捷注册测试用户' }),
});
assert.equal(created.status, 201);
const registration = await created.json();
assert.equal(registration.user_id, '2026999999');
assert.match(registration.registration_url, /\/register\//);

const form = await fetch(registration.registration_url);
assert.equal(form.status, 200);
assert.match(await form.text(), /UserID：2026999999/);
const completed = await fetch(registration.registration_url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: 'Quick-registration-2026!' }),
});
assert.equal(completed.status, 200);
const authenticated = await authenticatePassword('2026999999', 'Quick-registration-2026!');
assert.equal(authenticated.ok, true);
assert.equal(authenticated.personId, '2026999999');

const replay = await fetch(registration.registration_url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: 'Quick-registration-2026!' }),
});
assert.equal(replay.status, 410);
const invalidClient = await fetch(`${base}/api/v1/registrations`, {
  method: 'POST',
  headers: { authorization: `Basic ${Buffer.from(`${clientId}:wrong`).toString('base64')}`, 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: '2026999998', display_name: '不应创建' }),
});
assert.equal(invalidClient.status, 401);

console.log(JSON.stringify({ ok: true, flow: 'client_initiated_hosted_quick_registration', canonical_user_id: authenticated.personId, replay: 'rejected', invalid_client: 'rejected' }, null, 2));
await pool.end();
