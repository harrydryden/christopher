import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assertDedicatedDatabase, backoffDelays, benchmarkShape, calibrated, needsRender, POLL_MODEL, quietSchedule, refreshPathFor, REFRESH_PATHS, SCAN_STATUS_PATH, seedAccounts, summarise, TARGETS, WORK_STATUS_PATH } from './benchmark-users.mjs';
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
test('the poll model is the app\'s backoff: ten seconds, half as long again while nothing changes, a minute at most, ten again after a change', () => {
  assert.deepEqual(POLL_MODEL, { firstMs: 10_000, longestMs: 60_000, bannerFirstMs: 30_000 });
  assert.deepEqual(backoffDelays([false, false, false, false, false]), [10_000, 15_000, 22_500, 33_750, 50_625, 60_000]);
  assert.deepEqual(backoffDelays([false, false, true, false]), [10_000, 15_000, 22_500, 10_000, 15_000]);
  assert.equal(WORK_STATUS_PATH, '/api/work-status?scope=roles');
});
test('an idle tab asks nothing, and before a run only the banner asks, backing off to a minute', () => {
  assert.deepEqual(quietSchedule('idle', 100, 600), []);
  const events = quietSchedule('pre-scan', 2, 180);
  assert.ok(events.every(e => e.path === SCAN_STATUS_PATH));
  assert.deepEqual(events.filter(e => e.tab === 0).map(e => e.atMs), [0, 30_000, 75_000, 135_000]);
  assert.deepEqual(events.filter(e => e.tab === 1).map(e => e.atMs), [15_000, 45_000, 90_000, 150_000]);
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].atMs <= e.atMs));
  assert.throws(() => quietSchedule('run', 1, 60), /unknown quiet phase/);
});
test('a refresh is the Shortlisted view for nine tabs in ten and Matched for the tenth, held to the measured rate', () => {
  const paths = Array.from({ length: 100 }, (_, tab) => refreshPathFor(tab));
  assert.equal(paths.filter(p => p === REFRESH_PATHS.matched).length, 10);
  assert.equal(paths.filter(p => p === REFRESH_PATHS.shortlisted).length, 90);
  assert.equal(REFRESH_PATHS.shortlisted, '/');
  assert.ok(calibrated(2.3) && calibrated(2.8) && calibrated(3.3));
  assert.ok(!calibrated(2.29) && !calibrated(3.31));
  assert.equal(TARGETS.refreshP95Ms, 2_000);
});
test('a tab renders again only for a version it has not shown, and never for its first reading or a failed one', () => {
  assert.equal(needsRender(undefined, { ok: true, version: 'a' }), false);
  assert.equal(needsRender('a', { ok: true, version: 'a' }), false);
  assert.equal(needsRender('a', { ok: true, version: 'b' }), true);
  assert.equal(needsRender('a', { ok: false }), false);
});

test('the shared account seed leaves the rows the shape expects, when an empty database is at hand', async t => {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return t.skip('no database');
  const { Client } = createRequire(new URL('../apps/web/package.json', import.meta.url))('pg');
  const client = new Client({ connectionString: url });
  try { await client.connect(); } catch (error) { if (error?.code === 'ECONNREFUSED') return t.skip('database not reachable'); throw error; }
  try {
    // Inside a transaction that is rolled back, so the seed leaves nothing behind.
    await client.query('begin');
    const { rows: [state] } = await client.query('select (select count(*)::int from companies) + (select count(*)::int from cv_drafts) as n');
    if (state.n) return t.skip('the database already has companies or CVs');
    const shape = benchmarkShape({ USERS_BENCHMARK_ACCOUNTS: '10', USERS_BENCHMARK_COMPANIES: '2', USERS_BENCHMARK_FOLLOWS: '2', USERS_BENCHMARK_JOBS_PER_COMPANY: '3' });
    const sessions = await seedAccounts(client, shape, Math.floor(Date.now() / 1000) + 60);
    const { rows: [counts] } = await client.query(`select
      (select count(*)::int from users where email like '%@benchmark.invalid') users,
      (select count(*)::int from user_jobs uj join users u on u.id = uj.user_id where u.email like '%@benchmark.invalid') "userJobs",
      (select count(*)::int from cv_drafts) cvs, (select count(*)::int from applications) applications`);
    assert.deepEqual(counts, { users: shape.expected.users, userJobs: shape.expected.userJobs, cvs: shape.expected.cvs, applications: shape.expected.applications });
    assert.equal(sessions.length, shape.accounts);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
});
