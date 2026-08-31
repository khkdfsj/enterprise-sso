import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccessTokenPayload, parseWecomUserResponse } from '../src/services/wecom.js';

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

test('WeCom user response uses canonical UserID variants', () => {
  assert.equal(parseWecomUserResponse({ userid: '2023195077' }), '2023195077');
  assert.equal(parseWecomUserResponse({ UserId: '2007510002' }), '2007510002');
  assert.throws(() => parseWecomUserResponse({ errcode: 0 }));
});
