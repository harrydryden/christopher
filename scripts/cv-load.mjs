/**
 * CV builder load harness: many accounts asking for several CVs each within seconds, served by the
 * production worker's queue at a production concurrency, with a scripted model.
 *
 *   createdb ava_cvload
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ava_cvload pnpm db:migrate
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ava_cvload node scripts/cv-load.mjs
 *
 * The database must be a local scratch database whose name starts with `ava_cvload` and holds no
 * accounts; `christopher_dev` and `christopher_test` are refused by name. Drop and recreate it
 * between runs.
 *
 * What runs for real: the interface's `requestCv` server action (session, Library, budget quote,
 * the account's three-build cap and lock, the role lock, the draft, the application, the task), the
 * worker's `TaskQueue` with its lanes and CV cap and the production handler, the engine, the
 * validators, PDFKit, the budget hold and its renewals, the lease, the journal, and the CV page's
 * status poll (`GET /api/work-status?cv=`). What is scripted: the model's answers and their timing.
 * See scripts/cv-load-worker.mts and scripts/cv-load-web.mts for the two children.
 *
 * Shape and knobs (environment):
 *   CV_LOAD_ACCOUNTS            accounts, each with its own Library (default 50)
 *   CV_LOAD_DRAFTS              CVs each account asks for, each for a different role (default 2;
 *                               the interface refuses a fourth build in flight)
 *   CV_LOAD_WINDOW_SECONDS      the requests are spread across this window (default 10)
 *   CV_LOAD_CONCURRENCY         WORKER_CONCURRENCY (default 3, what production runs)
 *   CV_CONCURRENCY              the worker's CV build slots, beside the general ones (default 8, as
 *                               apps/worker/src/env.ts defaults it); CV_LOAD_CV_CONCURRENCY also works
 *   CV_LOAD_LATENCY_MS          per model request, uniform MIN-MAX (default 2000-6000). The whole run
 *                               scales with it: a build is 12 requests, about 8 of them in sequence,
 *                               so a 50 x 2 run at concurrency 3 takes about 7 minutes at 600-1800
 *                               and about 25 at the default. Shorten it to fit the time you have and
 *                               read the times as scaled; `projection` in the report rescales them
 *   CV_LOAD_TTFB_SHARE          share of each request's latency before its stream begins (default 0.2)
 *   CV_LOAD_529_RATE            chance each request attempt is answered 529 overloaded; the scripted
 *                               client retries twice as the SDK does before the call fails (default 0)
 *   CV_LOAD_GAP_QUIZ            none (default: the planner asks nothing, builds run straight
 *                               through) or ask (every build pauses for its evidence questions)
 *   CV_LOAD_POLL_MS             one open CV page per account polls at this cadence (default 10000,
 *                               AutoRefresh's FIRST_POLL_MS)
 *   CV_LOAD_QUEUE_POLL_MS       the worker's idle queue poll (default 3000, the production default)
 *   CV_LOAD_MAX_SECONDS         give up after this long (default 1800)
 *   CV_LOAD_PROJECT_CALL_MS     mean production request time the projection rescales to (default
 *                               60000; an assumption, not a measurement)
 *   CV_LOAD_REPORT_PATH         JSON report (default /tmp/ava-cv-load-report.json)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * What "50 users building CVs at the same time" has to mean to pass. A run with a shortened scripted
 * latency has its time to first slot judged on the projection to CV_LOAD_PROJECT_CALL_MS, because
 * the scaled clock would flatter the product; the request and poll times are real either way.
 */
export const TARGETS = Object.freeze({
  /** Every account's builds are running together, not queued behind each other's. */
  concurrentBuildsPerAccount: 1,
  firstSlotP95Seconds: 60,
  requestP95Ms: 4_000,
  pollP95Ms: 1_000,
  maxFailedBuilds: 0,
  maxDuplicatePublishes: 0,
  maxHoldsLeft: 0,
  maxLeasesLeft: 0,
  maxIncompleteNarratives: 0,
  maxRequestErrors: 0,
  maxPollErrors: 0,
  /** DEPLOY.md: keep PostgreSQL's active backends under about 70 on the 103-connection plan. */
  maxDbConnections: 70,
});

/** The motions every published build must have written, in some order. */
export const REQUIRED_MOTIONS = Object.freeze(['load_inputs', 'admit_budget', 'rubric', 'write', 'assess_batch', 'assemble', 'publish']);

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function loadShape(env = process.env) {
  const whole = (name, fallback, min, max) => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const share = (name, fallback, max) => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > max) throw new Error(`${name} must be a number from 0 to ${max}`);
    return value;
  };
  const gapQuiz = env.CV_LOAD_GAP_QUIZ || 'none';
  if (!['none', 'ask'].includes(gapQuiz)) throw new Error('CV_LOAD_GAP_QUIZ must be none or ask');
  return {
    accounts: whole('CV_LOAD_ACCOUNTS', 50, 1, 500),
    draftsPerAccount: whole('CV_LOAD_DRAFTS', 2, 1, 5),
    windowSeconds: whole('CV_LOAD_WINDOW_SECONDS', 10, 0, 600),
    concurrency: whole('CV_LOAD_CONCURRENCY', 3, 1, 30),
    cvConcurrency: whole(env.CV_CONCURRENCY !== undefined ? 'CV_CONCURRENCY' : 'CV_LOAD_CV_CONCURRENCY', 8, 1, 30),
    latency: parseLatency(env.CV_LOAD_LATENCY_MS),
    ttfbShare: share('CV_LOAD_TTFB_SHARE', 0.2, 0.9),
    overloadRate: share('CV_LOAD_529_RATE', 0, 0.5),
    gapQuiz,
    pollMs: whole('CV_LOAD_POLL_MS', 10_000, 1_000, 120_000),
    queuePollMs: whole('CV_LOAD_QUEUE_POLL_MS', 3_000, 100, 30_000),
    maxSeconds: whole('CV_LOAD_MAX_SECONDS', 1_800, 30, 21_600),
    projectCallMs: whole('CV_LOAD_PROJECT_CALL_MS', 60_000, 1_000, 900_000),
  };
}

export function parseLatency(raw) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(raw ?? '2000-6000').trim());
  if (!match) throw new Error('CV_LOAD_LATENCY_MS must be N or MIN-MAX milliseconds');
  const min = Number(match[1]), max = Number(match[2] ?? match[1]);
  if (max < min || max > 600_000) throw new Error('CV_LOAD_LATENCY_MS must be MIN-MAX with MAX >= MIN and at most 600000');
  return { min, max };
}

/** The worker's CV build slots: CV_CONCURRENCY, apart from the general slots (apps/worker/src/index.ts). */
export const cvBuildCap = (_concurrency, cvConcurrency = 8) => cvConcurrency;

/** The worker's database pool for its general and CV slots, as apps/worker/src/env.ts sizes it. */
export const workerPoolMax = (concurrency, cvConcurrency = 8) => (concurrency + cvConcurrency) * 2 + 4;

export function assertScratchDatabase(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('DATABASE_URL must name the local ava_cvload scratch database'); }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
      || !/^ava_cvload[a-z0-9_]*$/.test(database) || /christopher_(dev|test)/.test(database))
    throw new Error('DATABASE_URL must name a local scratch database called ava_cvload (never christopher_dev or christopher_test)');
  return url;
}

/** A small deterministic generator, so the same shape asks in the same order every run. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

/** Every request, in time order: each account's drafts at their own moments inside the window. */
export function requestSchedule(shape, seed = 7) {
  const random = seeded(seed);
  const events = [];
  for (let account = 0; account < shape.accounts; account++)
    for (let draft = 0; draft < shape.draftsPerAccount; draft++)
      events.push({ account, draft, atMs: Math.round(random() * shape.windowSeconds * 1000) });
  return events.sort((a, b) => a.atMs - b.atMs || a.account - b.account || a.draft - b.draft);
}

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function summarise(values) {
  const finite = values.filter(Number.isFinite);
  const round = v => (v === null ? null : Math.round(v));
  return { n: finite.length, p50: round(percentile(finite, 0.5)), p95: round(percentile(finite, 0.95)), max: round(finite.length ? Math.max(...finite) : null) };
}

/** The most intervals open at one moment. An interval that ends as another starts does not overlap it. */
export function maxOverlap(intervals) {
  const edges = intervals.flatMap(({ start, end }) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, most = 0;
  for (const [, step] of edges) { open += step; most = Math.max(most, open); }
  return most;
}

/**
 * Everything the report says about the builds, from what the database and the worker recorded.
 * Pure, so it is tested without a database.
 */
export function analyseBuilds({ drafts, steps, claims, ends, holds, leases }) {
  const claimsByDraft = group(claims, c => c.draftId);
  const endsByDraft = group(ends, e => e.draftId);
  const stepsByDraft = group(steps, s => s.draftId);
  const builds = drafts.map(draft => {
    const created = draft.createdAt;
    const mine = (claimsByDraft.get(draft.id) ?? []).sort((a, b) => a.at - b.at);
    const finished = (endsByDraft.get(draft.id) ?? []).sort((a, b) => a.at - b.at);
    const rows = stepsByDraft.get(draft.id) ?? [];
    const motions = new Set(rows.map(r => r.motion));
    const publishes = rows.filter(r => r.motion === 'publish' && r.status === 'done').length;
    const readyResults = finished.filter(e => e.result && e.result.ready).length;
    const lastEnd = finished.at(-1)?.at ?? null;
    return {
      id: draft.id, userId: draft.userId, status: draft.status, error: draft.error ?? null,
      attempts: mine.length,
      firstSlotMs: mine.length ? mine[0].at - created : null,
      queueWaitMs: mine.length ? mine.reduce((sum, c) => sum + c.readyWaitMs, 0) : null,
      slotMs: finished.reduce((sum, e) => sum + e.ms, 0),
      wallMs: lastEnd !== null ? lastEnd - created : null,
      steps: rows.length,
      openSteps: rows.filter(r => r.status === 'running').length,
      missingMotions: draft.status === 'ready' ? REQUIRED_MOTIONS.filter(m => !motions.has(m)) : [],
      publishes: Math.max(publishes, readyResults),
      intervals: finished.map(e => ({ start: e.at - e.ms, end: e.at })),
    };
  });
  const ready = builds.filter(b => b.status === 'ready');
  const incomplete = ready.filter(b => b.missingMotions.length || b.openSteps);
  const perAccount = [...group(builds, b => b.userId).values()].map(own => maxOverlap(own.flatMap(b => b.intervals)));
  return {
    builds: builds.length,
    byStatus: countBy(builds, b => b.status),
    failed: builds.filter(b => b.status === 'failed').map(b => ({ id: b.id, error: b.error })),
    duplicatePublishes: builds.filter(b => b.publishes > 1).map(b => b.id),
    retried: builds.filter(b => b.attempts > 1).length,
    firstSlotMs: summarise(builds.map(b => b.firstSlotMs)),
    queueWaitMs: summarise(builds.map(b => b.queueWaitMs)),
    slotMs: summarise(builds.map(b => b.slotMs)),
    wallMs: summarise(builds.map(b => b.wallMs)),
    maxConcurrentBuilds: maxOverlap(builds.flatMap(b => b.intervals)),
    maxConcurrentBuildsOneAccount: perAccount.length ? Math.max(...perAccount) : 0,
    stepsPerReadyBuild: summarise(ready.map(b => b.steps)),
    incompleteNarratives: incomplete.map(b => ({ id: b.id, missing: b.missingMotions, open: b.openSteps })),
    holdsLeft: holds,
    leasesLeft: leases,
  };
}

/** Which targets the report missed, in words. */
export function missedTargets(report, targets = TARGETS) {
  const b = report.builds, missed = [];
  const expected = Math.min(report.shape.draftsPerAccount, 3) * targets.concurrentBuildsPerAccount;
  const wantConcurrent = Math.min(b.builds, report.shape.accounts * expected);
  if (b.maxConcurrentBuilds < wantConcurrent) missed.push(`at most ${b.maxConcurrentBuilds} builds ran at once; ${wantConcurrent} were asked for together`);
  // A shortened scripted latency shortens the wait too, so a scaled run is judged on its projection.
  const scaled = report.projection && report.projection.factor > 1;
  const firstSlotMs = scaled ? (report.projection.firstSlotSeconds.p95 ?? Infinity) * 1000 : (b.firstSlotMs.p95 ?? Infinity);
  if (firstSlotMs > targets.firstSlotP95Seconds * 1000)
    missed.push(`time to first slot p95 ${seconds(firstSlotMs)}${scaled ? ` (projected at ${report.projection.assumedCallMs}ms per request)` : ''} > ${targets.firstSlotP95Seconds}s`);
  if (b.failed.length > targets.maxFailedBuilds) missed.push(`${b.failed.length} builds failed`);
  if ((b.byStatus.queued ?? 0) + (b.byStatus.generating ?? 0)) missed.push(`${(b.byStatus.queued ?? 0) + (b.byStatus.generating ?? 0)} builds never finished`);
  if (b.duplicatePublishes.length > targets.maxDuplicatePublishes) missed.push(`${b.duplicatePublishes.length} builds published twice`);
  if (b.holdsLeft.count > targets.maxHoldsLeft) missed.push(`${b.holdsLeft.count} budget holds left behind ($${b.holdsLeft.amountUsd})`);
  if (b.leasesLeft > targets.maxLeasesLeft) missed.push(`${b.leasesLeft} resource leases left behind`);
  if (b.incompleteNarratives.length > targets.maxIncompleteNarratives) missed.push(`${b.incompleteNarratives.length} published builds with an incomplete narrative`);
  if (report.requests.errors > targets.maxRequestErrors) missed.push(`${report.requests.errors} requests refused or failed`);
  if ((report.requests.ms.p95 ?? 0) > targets.requestP95Ms) missed.push(`request p95 ${report.requests.ms.p95}ms > ${targets.requestP95Ms}ms`);
  if (report.polls.errors > targets.maxPollErrors) missed.push(`${report.polls.errors} status polls failed`);
  if ((report.polls.ms.p95 ?? 0) > targets.pollP95Ms) missed.push(`status poll p95 ${report.polls.ms.p95}ms > ${targets.pollP95Ms}ms`);
  if (report.database.maxConnections > targets.maxDbConnections) missed.push(`${report.database.maxConnections} database connections > ${targets.maxDbConnections}`);
  if (report.timedOut) missed.push('the run hit CV_LOAD_MAX_SECONDS before every build settled');
  return missed;
}

/**
 * The scripted run's times rescaled to a production request time. A build's slot time and its
 * queue wait are both almost entirely model latency, so they scale with it; the rescaling is an
 * estimate, stated as one.
 */
export function projection(report, projectCallMs) {
  const scripted = (report.shape.latency.min + report.shape.latency.max) / 2;
  const factor = projectCallMs / scripted;
  // The queue's idle poll is real time on both clocks: it is taken off before rescaling and added back.
  const floor = report.shape.queuePollMs ?? 0;
  const scale = (s, fixed = 0) => Object.fromEntries(['p50', 'p95', 'max'].map(k =>
    [k, s[k] === null || s[k] === undefined ? null : Math.round((Math.max(0, s[k] - fixed) * factor + Math.min(s[k], fixed)) / 1000)]));
  return { assumedCallMs: projectCallMs, scriptedMeanCallMs: scripted, factor: +factor.toFixed(1),
    slotSeconds: scale(report.builds.slotMs), firstSlotSeconds: scale(report.builds.firstSlotMs, floor), wallSeconds: scale(report.builds.wallMs, floor) };
}

function group(rows, key) {
  const map = new Map();
  for (const row of rows) { const k = key(row); if (!map.has(k)) map.set(k, []); map.get(k).push(row); }
  return map;
}
function countBy(rows, key) {
  const out = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return out;
}
const seconds = ms => (ms === null || ms === undefined ? 'n/a' : `${(ms / 1000).toFixed(1)}s`);

// -- fixtures: synthetic, modelled on apps/web/app/actions/cv-e2e.test.ts ---------------------

const HEAD = [
  'Own the operational plan for eleven community clinics, reporting delivery, cost and quality to the executive team every month.',
  'Lead four operations managers and a shared scheduling team of eighteen, running a weekly performance review against a published set of measures.',
  'Rebuilt rostering and scheduling around a single demand model, replacing four spreadsheets and a shared inbox with one weekly plan, which cut agency spend by 22% in the first year while holding appointment availability flat across all eleven clinics and shortening the rota lead time from ten days to three.',
  'Partner with finance on the annual budget and on monthly variance across a £14m cost base.',
  'Introduced a supplier scorecard covering the eight largest contracts, with quarterly reviews against agreed service levels.',
];
const MANAGER = [
  'Ran day-to-day operations for four clinics, owning the rota, the patient flow and the site budget.',
  'Built the first operational reporting pack in SQL and Power BI, replacing a manual month-end spreadsheet that took three days to assemble.',
  'Cut the month-end close from nine working days to five by agreeing a single source for activity data with finance.',
  'Managed the transition of two acquired clinics onto the group\'s systems and ways of working.',
];
const CALDER = [
  'Led a service desk of nine covering two distribution centres and a national customer base.',
  'Owned the service level agreement with the group\'s three largest retail customers and chaired the monthly review.',
  'Introduced root-cause analysis on repeat incidents, which reduced escalations by a third over two years.',
];

/** A realistic three-job Library with education, skills and interests. `n` makes each account's own. */
export function libraryFixture(n = 1) {
  return {
    name: `Load Candidate ${n}`,
    contact: `Manchester, UK · candidate-${n}@load.invalid`,
    profile: 'Operations leader with twelve years across regulated healthcare and B2B software, accountable for multi-site service delivery, supplier performance and the annual operating budget. I build small teams that own their numbers and turn manual scheduling and reporting into measured processes.',
    employment: [
      { id: 'emp-head', company: 'Northwind Health', industryDescriptions: 'Healthcare, Regulated services', jobTitle: 'Head of Operations', startDate: '2021-04', endDate: '', current: true },
      { id: 'emp-manager', company: 'Northwind Health', industryDescriptions: 'Healthcare, Regulated services', jobTitle: 'Operations Manager', startDate: '2018-01', endDate: '2021-03', current: false },
      { id: 'emp-calder', company: 'Calder Logistics', industryDescriptions: 'Logistics, Supply chain', jobTitle: 'Service Delivery Lead', startDate: '2014-09', endDate: '2017-12', current: false },
    ],
    entries: [
      { id: 'ev-head', kind: 'experience', employmentId: 'emp-head', heading: 'Head of Operations · Northwind Health', details: HEAD.join('\n'), confirmedResponsibilities: HEAD },
      { id: 'ev-manager', kind: 'experience', employmentId: 'emp-manager', heading: 'Operations Manager · Northwind Health', details: MANAGER.join('\n'), confirmedResponsibilities: MANAGER },
      { id: 'ev-calder', kind: 'experience', employmentId: 'emp-calder', heading: 'Service Delivery Lead · Calder Logistics', details: CALDER.join('\n'), confirmedResponsibilities: CALDER },
      { id: 'ev-education', kind: 'education', heading: 'Education', details: 'BSc (Hons) Economics, University of Manchester, 2014\nPRINCE2 Practitioner, APMG International, 2019' },
      { id: 'ev-skills', kind: 'skill', heading: 'Systems and tools', details: 'Reporting, planning and finance systems used day to day.', skillItems: ['SQL', 'Power BI', 'NetSuite', 'Process mapping', 'Financial planning', 'Vendor management', 'Python'] },
      { id: 'ev-ways', kind: 'skill', heading: 'Ways of working', details: 'Stakeholder engagement, continuous improvement, supplier negotiation, change management' },
      { id: 'ev-interests', kind: 'interest', heading: 'Interests', details: 'Long-distance running and volunteering as a trustee for a local food bank.' },
    ],
  };
}

/** A realistic advert for a company in the shared catalogue. */
export function descriptionFor(company) {
  return [
    `Head of Operations — ${company}`, '', 'About the role',
    `${company} runs community health services across the North West of England.`,
    'We are hiring a Head of Operations to own service delivery for a portfolio of twelve sites and to lead a team of four operations managers.',
    '', 'What you will do',
    'You will own the operational plan for the portfolio and report performance to the executive team each month.',
    'You will lead continuous improvement work across scheduling, rostering and supplier performance.',
    'You will partner with finance to build the annual budget and to track monthly variance.',
    '', 'What we are looking for',
    'Candidates must have at least five years of experience leading operations in a regulated environment.',
    'You must be able to build and interpret reporting in SQL or a comparable analytics tool.',
    'Experience of supplier negotiation is preferred.',
    'A degree or equivalent professional qualification is required.',
    'Familiarity with NetSuite or a similar ERP is desirable.',
    'This role is hybrid, with two days a week in our Manchester office.',
    '', 'We offer a competitive salary, a pension and twenty-eight days of holiday.',
  ].join('\n');
}

// -- the run ---------------------------------------------------------------------------------

function child(label, args, env, onLine) {
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = chunk => { tail = (tail + chunk).slice(-8_000); };
  let buffer = '';
  proc.stdout.on('data', chunk => {
    keep(chunk);
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.startsWith('{') && onLine) { try { onLine(JSON.parse(line)); } catch {} }
  });
  proc.stderr.on('data', keep);
  const exited = new Promise(resolveExit => proc.on('exit', code => resolveExit(code)));
  return { proc, exited, tail: () => tail, label };
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function withAppName(url, name) {
  const copy = new URL(url.href);
  copy.searchParams.set('application_name', name);
  return copy.href;
}

async function main() {
  const url = assertScratchDatabase(process.env.DATABASE_URL ?? '');
  const shape = loadShape();
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: withAppName(url, 'cvload-harness'), max: 2 });
  const stamp = `${process.pid}-${Date.now()}`;
  const eventsPath = join(tmpdir(), `cv-load-events-${stamp}.jsonl`);
  const webResultPath = join(tmpdir(), `cv-load-web-${stamp}.json`);
  const reportPath = process.env.CV_LOAD_REPORT_PATH ?? '/tmp/ava-cv-load-report.json';
  let worker, web, sampler;
  const samples = [];
  try {
    const { rows: [state] } = await pool.query(`select (select count(*)::int from users) users, (select count(*)::int from tasks) tasks`);
    if (state.users || state.tasks) throw new Error('The scratch database must be freshly migrated: drop and recreate ava_cvload, then pnpm db:migrate');

    const common = { AVA_DISABLE_BROWSER: '1', NODE_ENV: 'development', LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' };
    worker = child('worker', ['--import', 'tsx', 'scripts/cv-load-worker.mts'], {
      ...common,
      DATABASE_URL: withAppName(url, 'cvload-worker'),
      WORKER_CONCURRENCY: String(shape.concurrency),
      CV_CONCURRENCY: String(shape.cvConcurrency),
      // No real key and nowhere real to send one: any call that escaped the scripted client fails locally.
      ANTHROPIC_API_KEY: 'cv-load-scripted-no-network',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      CV_LOAD_LATENCY_MS: `${shape.latency.min}-${shape.latency.max}`,
      CV_LOAD_TTFB_SHARE: String(shape.ttfbShare),
      CV_LOAD_529_RATE: String(shape.overloadRate),
      CV_LOAD_GAP_QUIZ: shape.gapQuiz,
      CV_LOAD_QUEUE_POLL_MS: String(shape.queuePollMs),
      CV_LOAD_EVENTS_PATH: eventsPath,
      HOSTNAME: 'cv-load-worker',
    });
    for (let i = 0; !readJsonLines(eventsPath).some(e => e.t === 'ready'); i++) {
      if (i > 120) throw new Error(`worker did not start:\n${worker.tail()}`);
      if (worker.proc.exitCode !== null) throw new Error(`worker exited:\n${worker.tail()}`);
      await new Promise(r => setTimeout(r, 500));
    }
    const transactions = async () => Number((await pool.query(`select xact_commit+xact_rollback n from pg_stat_database where datname=current_database()`)).rows[0].n);
    const xactBefore = await transactions();
    sampler = setInterval(async () => {
      try {
        const { rows } = await pool.query(`select coalesce(application_name,'') app, count(*)::int n, count(*) filter (where state='active')::int active
          from pg_stat_activity where datname=current_database() group by 1`);
        const { rows: [queue] } = await pool.query(`select count(*) filter (where status='queued')::int queued, count(*) filter (where status='running')::int running
          from tasks where type='generate_cv'`);
        samples.push({ at: Date.now(), apps: Object.fromEntries(rows.map(r => [r.app, { n: r.n, active: r.active }])), ...queue });
      } catch {}
    }, 1_000);

    const started = Date.now();
    web = child('web', ['--import', 'tsx', '--import', './scripts/cv-load-next-stubs.mjs', 'scripts/cv-load-web.mts'], {
      ...common,
      TSX_TSCONFIG_PATH: 'apps/web/tsconfig.json',
      DATABASE_URL: withAppName(url, 'cvload-web'),
      SESSION_SECRET: 'cv-load-harness-only-0123456789abcdef0123456789abcdef',
      CV_LOAD_WEB_RESULT: webResultPath,
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CV_LOAD_'))),
    }, line => console.error(`[web] ${JSON.stringify(line)}`));
    const webCode = await web.exited;
    if (webCode !== 0) throw new Error(`interface child failed (${webCode}):\n${web.tail()}`);
    const xactAfter = await transactions();
    worker.proc.kill('SIGTERM');
    const workerCode = await Promise.race([worker.exited, new Promise(r => setTimeout(() => r('timeout'), 40_000))]);
    clearInterval(sampler);
    const totalSeconds = (Date.now() - started) / 1000;

    const webResult = JSON.parse(readFileSync(webResultPath, 'utf8'));
    const events = readJsonLines(eventsPath);
    const ready = events.find(e => e.t === 'ready');
    const summary = events.find(e => e.t === 'summary') ?? {};
    const workerSamples = events.filter(e => e.t === 'sample');
    const { rows: drafts } = await pool.query(`select id, user_id "userId", status, error, (extract(epoch from created_at)*1000)::float8 "createdAt" from cv_drafts`);
    for (const d of drafts) d.createdAt = Number(d.createdAt);
    const { rows: steps } = await pool.query(`select draft_id "draftId", motion, status from cv_build_steps`);
    const { rows: [holds] } = await pool.query(`select count(*)::int count, round(coalesce(sum(amount),0)::numeric, 2)::float8 "amountUsd" from ai_reservations`);
    const { rows: [leases] } = await pool.query(`select count(*)::int n from resource_leases where key like 'cv:%'`);
    const { rows: [calls] } = await pool.query(`select count(*)::int n, count(*) filter (where not ok)::int failed, round(coalesce(sum(cost_usd::float8),0)::numeric,2)::float8 usd from ai_calls`);
    const builds = analyseBuilds({ drafts, steps, claims: events.filter(e => e.t === 'claim'), ends: events.filter(e => e.t === 'end'), holds, leases: leases.n });

    const pollMs = webResult.polls.map(p => p.ms);
    const appMax = app => Math.max(0, ...samples.map(s => s.apps[app]?.n ?? 0));
    const report = {
      at: new Date().toISOString(),
      shape: { ...shape, builds: shape.accounts * shape.draftsPerAccount, cvBuildCap: cvBuildCap(shape.concurrency, shape.cvConcurrency), workerPoolMax: workerPoolMax(shape.concurrency, shape.cvConcurrency) },
      environment: { node: process.version, cpu: cpus()[0]?.model, cpuCount: cpus().length, hostMemoryMiB: Math.round(totalmem() / 1048576), database: url.pathname.slice(1) },
      timedOut: webResult.timedOut, totalSeconds: +totalSeconds.toFixed(1),
      settleSeconds: +((webResult.settledAt - webResult.startedAt) / 1000).toFixed(1),
      requests: { n: webResult.requests.length, errors: webResult.requests.filter(r => !r.ok).length, ms: summarise(webResult.requests.map(r => r.ms)),
        refusals: webResult.requests.filter(r => !r.ok).slice(0, 10).map(r => r.message) },
      builds,
      model: { maxConcurrentStreams: summary.maxStreams ?? Math.max(0, ...workerSamples.map(s => s.streams)), requests: summary.requests, byKind: summary.byKind,
        overloadedAttempts: summary.overloadedAttempts, sdkRetries: summary.sdkRetries, overloadedCalls: summary.overloadedCalls, abortedStreams: summary.aborted,
        aiCallsRecorded: calls.n, aiCallsFailed: calls.failed, scriptedSpendUsd: calls.usd },
      worker: { cvBuildCap: ready?.cvCap, poolMax: ready?.poolMax, peakHeapMb: Math.max(0, ...workerSamples.map(s => s.heapMb)), peakRssMb: Math.max(0, ...workerSamples.map(s => s.rssMb)), exit: workerCode },
      database: {
        maxConnections: Math.max(0, ...samples.map(s => Object.values(s.apps).reduce((n, a) => n + a.n, 0))),
        maxWorker: appMax('cvload-worker'), maxWeb: appMax('cvload-web'), maxHarness: appMax('cvload-harness'),
        maxActive: Math.max(0, ...samples.map(s => Object.values(s.apps).reduce((n, a) => n + a.active, 0))),
        maxQueued: Math.max(0, ...samples.map(s => s.queued ?? 0)), maxRunning: Math.max(0, ...samples.map(s => s.running ?? 0)),
        transactionsPerSecond: +((xactAfter - xactBefore) / Math.max(1, (webResult.settledAt - webResult.startedAt) / 1000)).toFixed(1),
      },
      polls: { n: pollMs.length, errors: webResult.polls.filter(p => !p.ok).length, ms: summarise(pollMs), renders: webResult.renders,
        perSecond: +(pollMs.length / Math.max(1, (webResult.settledAt - webResult.startedAt) / 1000)).toFixed(2) },
      thresholds: TARGETS,
      limitations: [
        'Model answers and timings are scripted; the latency is uniform and shortened, so times are on a scaled clock (see projection).',
        'One interface process with the product pool of three connections stands in for the serverless fleet; the status poll calls the route handler directly, without HTTP or middleware, and the page re-render a changed version triggers is counted, not performed.',
        'Libraries are inserted directly (no evidence review is queued); the scheduler (ageing, reconciliation, the daily run) does not run beside the queue.',
        'A 529 is injected before a response begins and retried as the SDK does; mid-stream failures, 429 retry-after and real provider rate limits are not modelled.',
      ],
    };
    report.projection = projection(report, shape.projectCallMs);
    report.failures = missedTargets(report);
    report.passed = report.failures.length === 0;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    printTable(report);
    console.log(JSON.stringify({ passed: report.passed, report: reportPath, failures: report.failures }));
    if (!report.passed) process.exitCode = 1;
  } finally {
    if (sampler) clearInterval(sampler);
    for (const c of [web, worker]) if (c && c.proc.exitCode === null) { try { c.proc.kill('SIGKILL'); } catch {} }
    await pool.end();
  }
}

function printTable(r) {
  const s = v => (v === null || v === undefined ? 'n/a' : `${(v / 1000).toFixed(1)}s`);
  const rows = [
    ['shape', `${r.shape.accounts} accounts x ${r.shape.draftsPerAccount} CVs, concurrency ${r.shape.concurrency} (CV cap ${r.shape.cvBuildCap}), latency ${r.shape.latency.min}-${r.shape.latency.max}ms, 529 rate ${r.shape.overloadRate}`],
    ['total / settle', `${r.totalSeconds}s / ${r.settleSeconds}s${r.timedOut ? ' (timed out)' : ''}`],
    ['requests', `${r.requests.n} (${r.requests.errors} refused) p50 ${r.requests.ms.p50}ms p95 ${r.requests.ms.p95}ms`],
    ['builds', JSON.stringify(r.builds.byStatus) + `, retried ${r.builds.retried}`],
    ['time to first slot', `p50 ${s(r.builds.firstSlotMs.p50)} p95 ${s(r.builds.firstSlotMs.p95)} max ${s(r.builds.firstSlotMs.max)}`],
    ['queue wait', `p50 ${s(r.builds.queueWaitMs.p50)} p95 ${s(r.builds.queueWaitMs.p95)} max ${s(r.builds.queueWaitMs.max)}`],
    ['slot time per build', `p50 ${s(r.builds.slotMs.p50)} p95 ${s(r.builds.slotMs.p95)}`],
    ['build wall time', `p50 ${s(r.builds.wallMs.p50)} p95 ${s(r.builds.wallMs.p95)} max ${s(r.builds.wallMs.max)}`],
    ['concurrent builds', `max ${r.builds.maxConcurrentBuilds} overall, ${r.builds.maxConcurrentBuildsOneAccount} for one account`],
    ['model streams', `max ${r.model.maxConcurrentStreams} at once, ${r.model.requests} requests, ${r.model.overloadedCalls ?? 0} calls failed 529 after retries`],
    ['steps per ready build', `p50 ${r.builds.stepsPerReadyBuild.p50} p95 ${r.builds.stepsPerReadyBuild.p95}; incomplete ${r.builds.incompleteNarratives.length}`],
    ['published twice / holds / leases left', `${r.builds.duplicatePublishes.length} / ${r.builds.holdsLeft.count} / ${r.builds.leasesLeft}`],
    ['db connections', `max ${r.database.maxConnections} (worker ${r.database.maxWorker}/${r.shape.workerPoolMax}, web ${r.database.maxWeb}, harness ${r.database.maxHarness}), active max ${r.database.maxActive}, ${r.database.transactionsPerSecond} xact/s`],
    ['status polls', `${r.polls.n} (${r.polls.errors} errors) p50 ${r.polls.ms.p50}ms p95 ${r.polls.ms.p95}ms, ${r.polls.perSecond}/s, ${r.polls.renders} re-renders`],
    ['worker memory', `heap ${r.worker.peakHeapMb} MB, rss ${r.worker.peakRssMb} MB`],
    ['projection', `x${r.projection.factor} at ${r.projection.assumedCallMs}ms/request: slot p50 ${r.projection.slotSeconds.p50}s, first slot p95 ${r.projection.firstSlotSeconds.p95}s, wall p95 ${r.projection.wallSeconds.p95}s`],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);
  for (const f of r.failures) console.log(`MISSED  ${f}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
