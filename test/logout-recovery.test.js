import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogoutRecovery, readLogoutRecovery } from '../src/oidc/logout-recovery.js';

const key = 'test-only-cookie-key';
const values = { clientId: 'app-1', returnUri: 'http://210.47.163.181/studio/' };

test('signed logout recovery survives lost session state but expires after ten minutes', () => {
  const token = createLogoutRecovery(values, key, 1000);
  assert.deepEqual(readLogoutRecovery(token, key, 1000), { ...values, expires: 601000 });
  assert.equal(readLogoutRecovery(token, key, 601001), null);
  assert.equal(readLogoutRecovery(token, 'another-key', 1000), null);
  assert.equal(readLogoutRecovery(`${token}a`, key, 1000), null);
});

test('logout recovery rejects missing identity and non-http return targets', () => {
  assert.equal(createLogoutRecovery({ returnUri: values.returnUri }, key), '');
  assert.equal(readLogoutRecovery(createLogoutRecovery({ clientId: 'app-1', returnUri: 'javascript:alert(1)' }, key), key), null);
});
