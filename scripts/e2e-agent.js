import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';
import { decryptJson, randomToken, sha256 } from '../src/security/crypto.js';

const issuer = process.env.E2E_ISSUER ?? 'http://127.0.0.1:3000';
const identity = 'codex:test:agent-api';
const token = randomToken(48);
const credentialId = randomUUID();
const expires = new Date(Date.now() + 3600_000).toISOString();
const [admins] = await pool.execute("SELECT person_id FROM accounts WHERE username='admin' LIMIT 1");
assert.ok(admins[0]?.person_id);
await pool.execute(
  "INSERT INTO agent_api_credentials(id,agent_identity,display_name,token_hash,status,expires_at,created_by,created_at) VALUES (?,?,?,?,'active',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  [credentialId, identity, 'Agent API E2E', sha256(token), expires, admins[0].person_id],
);

function headers(requestId, extra = {}) {
  return { authorization: `Bearer ${token}`, 'x-esso-agent-identity': identity, 'x-request-id': requestId, ...extra };
}

let response = await fetch(`${issuer}/api/v1/agent/capabilities`, { headers: headers('agent-capabilities-0001') });
assert.equal(response.status, 200);
let payload = await response.json();
assert.equal(payload.package_name, 'ESSO-DFSJ');
assert.equal(payload.agent_identity, identity);

const registerId = 'agent-register-idempotent-0001';
const registration = {
  agent_identity: identity,
  name: 'Agent API Test Service',
  project_root_url: `${issuer}/agent-test-project/`,
  access_mode: 'rules',
  provisioning_enabled: false,
};
response = await fetch(`${issuer}/api/v1/agent/services`, { method: 'POST', headers: headers(registerId, { 'content-type': 'application/json' }), body: JSON.stringify(registration) });
assert.equal(response.status, 201);
payload = await response.json();
assert.equal(payload.idempotent_replay, false);
assert.equal(payload.service.created_by_agent, identity);
const serviceId = payload.service.id;
let packageToken = payload.package_token;

response = await fetch(`${issuer}/api/v1/agent/services`, { method: 'POST', headers: headers(registerId, { 'content-type': 'application/json' }), body: JSON.stringify(registration) });
assert.equal(response.status, 200);
payload = await response.json();
assert.equal(payload.idempotent_replay, true);
assert.equal(payload.service.id, serviceId);
packageToken = payload.package_token;

response = await fetch(`${issuer}/api/v1/agent/services/${serviceId}/package`, { headers: headers('agent-package-download-0001', { 'x-esso-package-token': packageToken }) });
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type'), /application\/zip/);
assert.ok((await response.arrayBuffer()).byteLength > 1000);
response = await fetch(`${issuer}/api/v1/agent/services/${serviceId}/package`, { headers: headers('agent-package-download-0002', { 'x-esso-package-token': packageToken }) });
assert.equal(response.status, 410);

response = await fetch(`${issuer}/api/v1/agent/services/${serviceId}/monitor`, { method: 'POST', headers: headers('agent-monitor-start-0001') });
assert.equal(response.status, 200);
payload = await response.json();
assert.equal(payload.status, 'testing');

response = await fetch(`${issuer}/api/v1/agent/services/${serviceId}`, { headers: headers('agent-service-status-0001') });
assert.equal(response.status, 200);
payload = await response.json();
assert.equal(payload.service.id, serviceId);
assert.match(payload.tests.login.url, /ESSO-DFSJ\/test-login\.php$/);

const [clientRows] = await pool.execute("SELECT o.payload FROM applications a JOIN oidc_objects o ON o.model='Client' AND o.id=a.client_id WHERE a.id=?", [serviceId]);
const clientSecret = decryptJson(JSON.parse(clientRows[0].payload)).client_secret;
const timestamp = Math.floor(Date.now() / 1000);
response = await fetch(`${issuer}/api/v1/integration-tests/${serviceId}/login?sub=${encodeURIComponent(admins[0].person_id)}&ts=${timestamp}&proof=invalid`);
assert.equal(response.status, 403);
const loginProof = createHmac('sha256', clientSecret).update(`login|${admins[0].person_id}|${timestamp}`).digest('hex');
response = await fetch(`${issuer}/api/v1/integration-tests/${serviceId}/login?sub=${encodeURIComponent(admins[0].person_id)}&ts=${timestamp}&proof=${loginProof}`);
assert.equal(response.status, 200);
const logoutProof = createHmac('sha256', clientSecret).update(`logout|${timestamp}`).digest('hex');
response = await fetch(`${issuer}/api/v1/integration-tests/${serviceId}/logout?ts=${timestamp}&proof=${logoutProof}`);
assert.equal(response.status, 200);
response = await fetch(`${issuer}/api/v1/agent/services/${serviceId}`, { headers: headers('agent-service-status-0002') });
payload = await response.json();
assert.equal(payload.tests.login.status, 'passed');
assert.equal(payload.tests.logout.status, 'passed');

response = await fetch(`${issuer}/api/v1/agent/capabilities`, { headers: { ...headers('agent-identity-mismatch-0001'), 'x-esso-agent-identity': 'codex:test:wrong-agent' } });
assert.equal(response.status, 403);

const [apps] = await pool.execute("SELECT COUNT(*) count FROM applications WHERE name='Agent API Test Service'");
assert.equal(Number(apps[0].count), 1);
await pool.end();
console.log('Agent API E2E passed');
