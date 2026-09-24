import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDedicatedDatabase, benchmarkShape, needsRender, pollSchedule, POLL_CADENCE, SCAN_STATUS_PATH, summarise, WORK_STATUS_PATH } from './benchmark-users.mjs';
test('database guard accepts only the exact dedicated local database', () => {
  assert.equal(assertDedicatedDatabase('postgres://u:p@127.0.0.1:55439/christopher_users_benchmark').pathname, '/christopher_users_benchmark');
  for (const unsafe of ['postgres://u:p@example.com/christopher_users_benchmark','postgres://u:p@localhost/ava_test','postgres://u:p@localhost/postgres'])
    assert.throws(() => assertDedicatedDatabase(unsafe), /dedicated local/);
});
test('summary reports errors and percentiles', () => {
  assert.deepEqual(summarise([{ ms: 10, ok: true },{ ms: 30, ok: false },{ ms: 20, ok: true }]),
    { requests: 3, errors: 1, p50Ms: 20, p95Ms: 30, maxMs: 30 });
});
test('the default shape is the hundred-account fixture, and the thousand-account one shares a large catalogue out', () => {
  const small = benchmarkShape({});
  assert.deepEqual({ accounts: small.accounts, companies: small.companies, follows: small.follows, tabs: small.pollingTabs }, { accounts: 100, companies: 20, follows: 20, tabs: 100 });
  assert.deepEqual(small.expected, { users: 100, userJobs: 100_000, libraries: 110, cvs: 100, applications: 100, decisions: 100, queuedTasks: 30 });
  const large = benchmarkShape({ USERS_BENCHMARK_ACCOUNTS: '1000', USERS_BENCHMARK_COMPANIES: '1500', USERS_BENCHMARK_FOLLOWS: '20', USERS_POLLING_TABS: '300' });
  assert.equal(large.expected.userJobs, 1000 * 20 * 50);
  assert.equal(large.pollingTabs, 300);
  // An account cannot follow more companies than there are, nor open more tabs than there are accounts.
  assert.equal(benchmarkShape({ USERS_BENCHMARK_COMPANIES: '5' }).follows, 5);
  assert.equal(benchmarkShape({ USERS_BENCHMARK_ACCOUNTS: '10', USERS_POLLING_TABS: '50' }).pollingTabs, 10);
  for (const unsafe of [{ USERS_BENCHMARK_ACCOUNTS: '5' }, { USERS_BENCHMARK_COMPANIES: '1.5' }, { USERS_POLLING_SECONDS: '10' }, { USERS_BENCHMARK_FOLLOWS: 'many' }])
    assert.throws(() => benchmarkShape(unsafe), /must be a whole number/);
});
test('open tabs poll work status every ten seconds and the banner every thirty, each from its own start', () => {
  const events = pollSchedule(4, 30);
  const work = events.filter(e => e.path === WORK_STATUS_PATH), scan = events.filter(e => e.path === SCAN_STATUS_PATH);
  assert.equal(work.length, 4 * 3);
  assert.equal(scan.length, 4);
  assert.deepEqual(scan.map(e => e.atMs), [0, 2500, 5000, 7500]);
  assert.deepEqual(work.filter(e => e.tab === 1).map(e => e.atMs), [2500, 12_500, 22_500]);
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].atMs <= e.atMs));
  assert.deepEqual(POLL_CADENCE, { workStatusMs: 10_000, scanStatusMs: 30_000 });
});
test('a tab renders again only for a version it has not shown, and never for its first reading or a failed one', () => {
  assert.equal(needsRender(undefined, { ok: true, version: 'a' }), false);
  assert.equal(needsRender('a', { ok: true, version: 'a' }), false);
  assert.equal(needsRender('a', { ok: true, version: 'b' }), true);
  assert.equal(needsRender('a', { ok: false }), false);
});
