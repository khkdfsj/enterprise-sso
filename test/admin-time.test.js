import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBeijingTime, parseBeijingLocalTime } from '../src/admin/time.js';

test('admin timestamps are rendered in Asia/Shanghai', () => {
  assert.equal(formatBeijingTime('2026-09-01T00:27:38.000Z'), '2026-09-01 08:27:38');
  assert.equal(formatBeijingTime('2026-09-01 00:27:38'), '2026-09-01 08:27:38');
});

test('datetime-local input is interpreted as Asia/Shanghai', () => {
  assert.equal(parseBeijingLocalTime('2026-09-01T08:30'), '2026-09-01T00:30:00.000Z');
});
