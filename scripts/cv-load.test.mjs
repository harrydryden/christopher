import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseBuilds, assertScratchDatabase, cvBuildCap, descriptionFor, libraryFixture, loadShape, maxOverlap, missedTargets,
  parseLatency, projection, requestSchedule, summarise, TARGETS, workerPoolMax,
} from './cv-load.mjs';
import { STUBS } from './cv-load-next-stubs.mjs';

test('database guard accepts only a local ava_cvload scratch database', () => {
  assert.equal(assertScratchDatabase('postgres://u:p@127.0.0.1:5432/ava_cvload').pathname, '/ava_cvload');
  assert.equal(assertScratchDatabase('postgres://u:p@localhost/ava_cvload_2').pathname, '/ava_cvload_2');
  for (const unsafe of ['postgres://u:p@127.0.0.1/christopher_dev', 'postgres://u:p@127.0.0.1/christopher_test',
    'postgres://u:p@db.example.com/ava_cvload', 'postgres://u:p@localhost/postgres', 'postgres://u:p@localhost/ava_cvload_christopher_dev', 'not a url'])
    assert.throws(() => assertScratchDatabase(unsafe), /scratch database/);
});

test('the default shape is fifty accounts asking for two CVs each at the production concurrency', () => {
  const shape = loadShape({});
  assert.deepEqual({ accounts: shape.accounts, drafts: shape.draftsPerAccount, concurrency: shape.concurrency, latency: shape.latency, pollMs: shape.pollMs, rate: shape.overloadRate },
    { accounts: 50, drafts: 2, concurrency: 3, latency: { min: 2000, max: 6000 }, pollMs: 10_000, rate: 0 });
  assert.equal(loadShape({ CV_LOAD_ACCOUNTS: '1', CV_LOAD_DRAFTS: '3' }).draftsPerAccount, 3);
  for (const bad of [{ CV_LOAD_ACCOUNTS: '0' }, { CV_LOAD_CONCURRENCY: '31' }, { CV_LOAD_DRAFTS: 'two' }, { CV_LOAD_529_RATE: '0.9' }, { CV_LOAD_GAP_QUIZ: 'maybe' }])
    assert.throws(() => loadShape(bad));
});

test('latency is one number or a range', () => {
  assert.deepEqual(parseLatency('1500'), { min: 1500, max: 1500 });
  assert.deepEqual(parseLatency(' 600-1800 '), { min: 600, max: 1800 });
  for (const bad of ['1800-600', 'fast', '1-900000']) assert.throws(() => parseLatency(bad));
});

test('the worker figures follow the production formulas', () => {
  assert.deepEqual([1, 2, 3, 6, 30].map(cvBuildCap), [1, 1, 2, 3, 15]);
  assert.deepEqual([3, 30].map(workerPoolMax), [10, 64]);
});

test('every account asks for each of its CVs once, inside the window, in time order, the same way every run', () => {
  const shape = { accounts: 4, draftsPerAccount: 3, windowSeconds: 10 };
  const schedule = requestSchedule(shape);
  assert.equal(schedule.length, 12);
  assert.equal(new Set(schedule.map(e => `${e.account}:${e.draft}`)).size, 12);
  assert.ok(schedule.every((e, i) => e.atMs >= 0 && e.atMs <= 10_000 && (i === 0 || schedule[i - 1].atMs <= e.atMs)));
  assert.deepEqual(requestSchedule(shape), schedule);
  assert.ok(requestSchedule({ ...shape, windowSeconds: 0 }).every(e => e.atMs === 0));
});

test('summaries and overlaps', () => {
  assert.deepEqual(summarise([30, 10, null, 20]), { n: 3, p50: 20, p95: 30, max: 30 });
  assert.deepEqual(summarise([]), { n: 0, p50: null, p95: null, max: null });
  assert.equal(maxOverlap([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 10, end: 20 }]), 2);
  assert.equal(maxOverlap([{ start: 0, end: 10 }, { start: 10, end: 20 }]), 1);
});

test('the fixtures are a usable Library and advert', () => {
  const library = libraryFixture(7);
  assert.equal(library.name, 'Load Candidate 7');
  assert.ok(library.entries.some(e => e.kind === 'education') && library.entries.filter(e => e.kind === 'experience').length === 3);
  assert.ok(library.entries.filter(e => e.employmentId).every(e => library.employment.some(job => job.id === e.employmentId)));
  const advert = descriptionFor('Meridian Care 3');
  assert.ok(advert.includes('Meridian Care 3') && advert.length > 80 && advert.length < 30_000);
});

const draft = (id, userId, status, createdAt) => ({ id, userId, status, createdAt, error: status === 'failed' ? 'boom' : null });
const steps = (draftId, motions, status = 'done') => motions.map(motion => ({ draftId, motion, status }));
const FULL = ['load_inputs', 'admit_budget', 'rubric', 'write', 'assess_batch', 'assess_batch', 'assemble', 'publish'];

test('build analysis: slots, waits, overlap, narrative, duplicates and leftovers', () => {
  const analysis = analyseBuilds({
    drafts: [draft('a', 'u1', 'ready', 0), draft('b', 'u1', 'ready', 0), draft('c', 'u2', 'failed', 1_000)],
    steps: [...steps('a', FULL), ...steps('b', FULL.filter(m => m !== 'assemble')), ...steps('b', ['publish']), ...steps('c', ['load_inputs']), ...steps('c', ['rubric'], 'running')],
    claims: [
      { draftId: 'a', at: 2_000, readyWaitMs: 2_000 }, { draftId: 'b', at: 9_000, readyWaitMs: 9_000 },
      { draftId: 'c', at: 3_000, readyWaitMs: 2_000 }, { draftId: 'c', at: 70_000, readyWaitMs: 500 },
    ],
    ends: [
      { draftId: 'a', at: 10_000, ms: 8_000, result: { ready: true } }, { draftId: 'b', at: 20_000, ms: 11_000, result: { ready: true } },
      { draftId: 'c', at: 8_000, ms: 5_000, error: 'retry' }, { draftId: 'c', at: 75_000, ms: 5_000, result: { failed: true } },
    ],
    holds: { count: 1, amountUsd: 2.5 }, leases: 0,
  });
  assert.deepEqual(analysis.byStatus, { ready: 2, failed: 1 });
  assert.equal(analysis.retried, 1);
  assert.deepEqual(analysis.firstSlotMs, { n: 3, p50: 2_000, p95: 9_000, max: 9_000 });
  assert.equal(analysis.queueWaitMs.max, 9_000);
  assert.equal(analysis.maxConcurrentBuilds, 2);
  assert.equal(analysis.maxConcurrentBuildsOneAccount, 2);
  assert.deepEqual(analysis.duplicatePublishes, ['b']);
  assert.deepEqual(analysis.incompleteNarratives, [{ id: 'b', missing: ['assemble'], open: 0 }]);
  assert.deepEqual(analysis.failed, [{ id: 'c', error: 'boom' }]);
  assert.equal(analysis.wallMs.max, 74_000);
});

test('missed targets are named; a clean run at full concurrency passes', () => {
  const clean = {
    shape: { accounts: 2, draftsPerAccount: 2, latency: { min: 1000, max: 3000 } }, timedOut: false,
    builds: { builds: 4, byStatus: { ready: 4 }, maxConcurrentBuilds: 4, firstSlotMs: { p95: 3_000 }, failed: [], duplicatePublishes: [], holdsLeft: { count: 0 }, leasesLeft: 0, incompleteNarratives: [], slotMs: { p50: 1, p95: 1, max: 1 }, wallMs: { p50: 1, p95: 1, max: 1 } },
    requests: { errors: 0, ms: { p95: 100 } }, polls: { errors: 0, ms: { p95: 50 } }, database: { maxConnections: 20 },
  };
  assert.deepEqual(missedTargets(clean), []);
  const queued = structuredClone(clean);
  queued.builds.maxConcurrentBuilds = 2;
  queued.builds.firstSlotMs.p95 = (TARGETS.firstSlotP95Seconds + 1) * 1000;
  queued.builds.holdsLeft = { count: 1, amountUsd: 1 };
  queued.database.maxConnections = 80;
  const missed = missedTargets(queued);
  assert.equal(missed.length, 4);
  assert.match(missed[0], /at most 2 builds ran at once; 4 were asked for together/);
  const p = projection(clean, 60_000);
  assert.equal(p.factor, 30);
  // The queue's idle poll is not model time, so it is not rescaled.
  const polled = projection({ ...clean, shape: { ...clean.shape, queuePollMs: 3_000 }, builds: { ...clean.builds, firstSlotMs: { p50: 2_000, p95: 13_000, max: 13_000 } } }, 60_000);
  assert.deepEqual(polled.firstSlotSeconds, { p50: 2, p95: 303, max: 303 });
  // A scaled run is judged on its projected wait, not on the flattering scaled clock.
  const scaled = { ...structuredClone(clean), projection: { ...p, firstSlotSeconds: { p95: 90 } } };
  assert.match(missedTargets(scaled).join(), /first slot p95 90\.0s \(projected at 60000ms per request\)/);
  assert.deepEqual(missedTargets({ ...scaled, projection: { ...p, firstSlotSeconds: { p95: 30 } } }), []);
});

test('the Next.js stubs cover the request modules the action and the route import', async () => {
  assert.deepEqual(Object.keys(STUBS).sort(), ['next/cache', 'next/headers', 'next/navigation']);
  const navigation = await import(`data:text/javascript,${encodeURIComponent(STUBS['next/navigation'])}`);
  assert.throws(() => navigation.redirect('/cv/abc'), error => error.url === '/cv/abc');
  globalThis.__cvLoad = { cookie: () => 'signed' };
  const headers = await import(`data:text/javascript,${encodeURIComponent(STUBS['next/headers'])}`);
  assert.deepEqual((await headers.cookies()).get('ava_session'), { name: 'ava_session', value: 'signed' });
  assert.equal((await headers.cookies()).get('other'), undefined);
  delete globalThis.__cvLoad;
});
