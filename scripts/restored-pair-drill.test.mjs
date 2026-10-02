import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeFixtureSnapshot, validatePairDrillUrls } from './restored-pair-drill.mjs';

const source = 'postgres://postgres:postgres@127.0.0.1:55439/christopher_users_benchmark';
const target = 'postgres://postgres:postgres@127.0.0.1:55439/christopher_recovery_drill';
const container = 'jtbd-90-postgres-20260929';

test('restored pair drill accepts only the named Docker server and two local database names', () => {
  assert.equal(validatePairDrillUrls(source, target, container).target.pathname, '/christopher_recovery_drill');
  for (const candidate of [
    [source.replace('127.0.0.1', 'example.com'), target, container],
    [source.replace('55439', '5432'), target.replace('55439', '5432'), container],
    [source.replace('christopher_users_benchmark', 'ava_test'), target, container],
    [source, target.replace('christopher_recovery_drill', 'production'), container],
    [source, target, 'another-postgres'],
  ]) assert.throws(() => validatePairDrillUrls(...candidate));
});

test('the restored worker will not boot with a non-synthetic or runnable fixture', () => {
  const safe = { users: 1, companies: 1, subscriptions: 1, sources: 1, jobs: 1,
    libraries: 1, applications: 1, tasks: 1, activeSubscriptions: 0, discoverySources: 0, discoveryCandidates: 0,
    runnableSources: 0, externalUrls: 0, otherTasks: 0, runningTasks: 0,
    email: 'restored-drill@example.invalid', domain: 'restored-drill.invalid',
    companyStatus: 'paused', subscriptionStatus: 'paused', sourceStatus: 'disabled',
    taskType: 'reevaluate_gate', taskStatus: 'queued', roleVisible: false,
    userId: '00000000-0000-4000-8000-000000000001', taskSubject: '00000000-0000-4000-8000-000000000001' };
  assert.equal(assertSafeFixtureSnapshot(safe), safe);
  for (const change of [
    { users: 2 }, { activeSubscriptions: 1 }, { discoverySources: 1 }, { discoveryCandidates: 1 },
    { runnableSources: 1 }, { externalUrls: 1 }, { otherTasks: 1 },
    { runningTasks: 1 }, { taskType: 'scan_company' }, { email: 'other@example.invalid' },
    { roleVisible: true }, { taskSubject: 'some-other-account' },
  ]) assert.throws(() => assertSafeFixtureSnapshot({ ...safe, ...change }));
});
