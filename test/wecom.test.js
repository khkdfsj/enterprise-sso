import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccessTokenPayload } from '../src/services/wecom.js';

const token = 'a'.repeat(64);

test('legacy WeCom token source accepts plain text and JSON payloads', () => {
  assert.equal(parseAccessTokenPayload(`  ${token}\n`), token);
  assert.equal(parseAccessTokenPayload(JSON.stringify({ access_token: token, expires_in: 7200 })), token);
});

test('legacy WeCom token source rejects malformed and error payloads', () => {
  assert.throws(() => parseAccessTokenPayload('short'));
  assert.throws(() => parseAccessTokenPayload('{broken'));
  assert.throws(() => parseAccessTokenPayload(JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' })));
});
