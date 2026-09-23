import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDedicatedDatabase, summarise } from './benchmark-users.mjs';
test('database guard accepts only the exact dedicated local database', () => {
  assert.equal(assertDedicatedDatabase('postgres://u:p@127.0.0.1:55439/christopher_users_benchmark').pathname, '/christopher_users_benchmark');
  for (const unsafe of ['postgres://u:p@example.com/christopher_users_benchmark','postgres://u:p@localhost/ava_test','postgres://u:p@localhost/postgres'])
    assert.throws(() => assertDedicatedDatabase(unsafe), /dedicated local/);
});
test('summary reports errors and percentiles', () => {
  assert.deepEqual(summarise([{ ms: 10, ok: true },{ ms: 30, ok: false },{ ms: 20, ok: true }]),
    { requests: 3, errors: 1, p50Ms: 20, p95Ms: 30, maxMs: 30 });
});
