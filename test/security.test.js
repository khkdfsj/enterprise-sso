import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptJson, encryptJson, randomToken, safeEqualHex, sha256 } from '../src/security/crypto.js';
import { hashPassword, verifyPassword } from '../src/security/password.js';

test('encrypted OIDC payload round-trips and uses a fresh IV', () => {
  const payload = { sub: 'person-1', nested: { scope: ['openid'] } };
  const first = encryptJson(payload);
  const second = encryptJson(payload);
  assert.deepEqual(decryptJson(first), payload);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
});

test('constant-time hex comparison rejects malformed input', () => {
  const digest = sha256('browser-secret');
  assert.equal(safeEqualHex(digest, sha256('browser-secret')), true);
  assert.equal(safeEqualHex(digest, sha256('another-secret')), false);
  assert.equal(safeEqualHex('z'.repeat(64), 'z'.repeat(64)), false);
});

test('random tokens are URL safe and non-repeating', () => {
  const first = randomToken();
  const second = randomToken();
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
});

test('Argon2id passwords verify with the configured pepper', async () => {
  const encoded = await hashPassword('correct horse battery staple');
  assert.match(encoded, /^\$argon2id\$/);
  assert.equal(await verifyPassword(encoded, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(encoded, 'wrong password'), false);
  await assert.rejects(() => hashPassword('short'));
});
