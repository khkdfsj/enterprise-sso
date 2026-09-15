import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const issuer = process.env.E2E_ISSUER ?? 'http://127.0.0.1:3000';
const requestId = 'public-people-test-0001';
const response = await fetch(`${issuer}/api/v1/public/people`, {
  headers: { 'X-Request-ID': requestId }
});
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
assert.equal(response.headers.get('access-control-allow-origin'), '*');
assert.match(response.headers.get('cache-control') ?? '', /max-age=60/);
assert.equal(response.headers.get('x-request-id'), requestId);

const payload = await response.json();
assert.equal(payload.ok, true);
assert.equal(payload.request_id, requestId);
assert.equal(payload.count, 1);
assert.deepEqual(payload.people, [{ user_id: 'dev-admin', name: '开发管理员' }]);
assert.deepEqual(Object.keys(payload.people[0]).sort(), ['name', 'user_id']);

const database = new DatabaseSync(process.env.E2E_DB_FILE);
database.prepare('UPDATE people SET public_directory_visible=0 WHERE id=?').run('dev-admin');
const hiddenResponse = await fetch(`${issuer}/api/v1/public/people`);
assert.equal(hiddenResponse.status, 200);
const hiddenPayload = await hiddenResponse.json();
assert.equal(hiddenPayload.count, 0);
assert.deepEqual(hiddenPayload.people, []);
database.prepare('UPDATE people SET public_directory_visible=1 WHERE id=?').run('dev-admin');
database.close();

const preflight = await fetch(`${issuer}/api/v1/public/people`, { method: 'OPTIONS' });
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

const missing = await fetch(`${issuer}/api/v1/public/not-a-resource`);
assert.equal(missing.status, 404);
const missingPayload = await missing.json();
assert.equal(missingPayload.ok, false);
assert.equal(missingPayload.error, 'endpoint_not_found');
assert.equal(typeof missingPayload.request_id, 'string');

const unsupported = await fetch(`${issuer}/api/v1/public/people?status=active`);
assert.equal(unsupported.status, 400);
const unsupportedPayload = await unsupported.json();
assert.equal(unsupportedPayload.ok, false);
assert.equal(unsupportedPayload.error, 'unsupported_parameters');

console.log(JSON.stringify({ ok: true, endpoint: 'public_active_people', fields: ['user_id', 'name'] }));
