import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  OPERATIONAL_THRESHOLDS,
  operationalFailures,
  operationalFailureDiagnostics,
  operationalAttentionMessage,
  operationalSuccessMessage,
  operationalWarnings,
  readMonitor,
  readOperationalSample,
  readReleaseHealth,
  requiredOperationalConfig,
  requiredReleaseConfig,
  sameWorkerInputs,
  slowQueryDelta,
  workerIdentity,
} from "./release-checks.mjs";

const healthy = (overrides = {}) => ({
  workerId: "worker-a",
  ready: 0, running: 0, oldestSeconds: 0, overdueCompanies: 0,
  overdueDiscovery: 0, heapFraction: 0.4, dbWaiting: 0, uptimeSeconds: 100,
  crashRecoveries1h: 0, crashRecoveries24h: 0,
  providerCalls1h: 0, providerSuccesses1h: 0, providerFailures1h: 0,
  providerOutageGroups1h: 0, spend24hUsd: 0, spendMonthUsd: 0,
  accountsAtOrOverBudget: 0,
  ...overrides,
});

test("release configuration fails visibly when identity or URL is missing", () => {
  assert.throws(() => requiredReleaseConfig({}, "WEB_HEALTH_URL"), /RELEASE_SHA/);
  assert.throws(() => requiredReleaseConfig({ RELEASE_SHA: "a".repeat(40) }, "WEB_HEALTH_URL"), /WEB_HEALTH_URL/);
  assert.throws(() => requiredReleaseConfig({ RELEASE_SHA: "a".repeat(40), WEB_HEALTH_URL: "file:\/\/tmp\/health" }, "WEB_HEALTH_URL"), /HTTP/);
});

test("operational configuration requires an explicit full commit and worker URL", () => {
  assert.throws(() => requiredOperationalConfig({ WORKER_HEALTH_URL: "https://worker.example/healthz" }), /OPERATIONAL_EXPECTED_SHA/);
  assert.throws(() => requiredOperationalConfig({ OPERATIONAL_EXPECTED_SHA: "short", WORKER_HEALTH_URL: "https://worker.example/healthz" }), /40-character/);
  assert.deepEqual(requiredOperationalConfig({
    OPERATIONAL_EXPECTED_SHA: "b".repeat(40),
    WORKER_HEALTH_URL: "https://worker.example/healthz",
  }), { expected: "b".repeat(40), url: "https://worker.example/healthz", headers: {} });
});

test("operational figures come from the status URL, with its bearer token, when one is configured", () => {
  assert.deepEqual(requiredOperationalConfig({
    OPERATIONAL_EXPECTED_SHA: "b".repeat(40),
    WORKER_HEALTH_URL: "https://worker.example/healthz",
    WORKER_STATUS_URL: "https://worker.example/status",
    WORKER_STATUS_TOKEN: " secret-token ",
  }), { expected: "b".repeat(40), url: "https://worker.example/status", headers: { authorization: "Bearer secret-token" } });
  // An unset repository variable arrives as an empty string and falls back to the health URL.
  assert.equal(requiredOperationalConfig({
    OPERATIONAL_EXPECTED_SHA: "b".repeat(40), WORKER_HEALTH_URL: "https://worker.example/healthz", WORKER_STATUS_URL: "", WORKER_STATUS_TOKEN: "",
  }).url, "https://worker.example/healthz");
  assert.throws(() => requiredOperationalConfig({ OPERATIONAL_EXPECTED_SHA: "b".repeat(40), WORKER_STATUS_URL: "ftp://worker.example/status" }), /WORKER_STATUS_URL/);
});

test("release health requires both an explicit healthy state and a full commit", () => {
  assert.deepEqual(readReleaseHealth({ ok: true, commit: "a".repeat(40) }), { healthy: true, commit: "a".repeat(40) });
  assert.deepEqual(readReleaseHealth({ ok: true, commit: null }), { healthy: true, commit: "not reported" });
  assert.equal(readReleaseHealth({ ok: false, commit: "a".repeat(40) }).healthy, false);
});

test("operational samples reject missing readings instead of treating them as zero", () => {
  assert.throws(() => readOperationalSample({ ok: true, metrics: {}, vitals: {} }), /missing required operational fields/);
  assert.deepEqual(readOperationalSample({
    ok: true, workerId: "worker-a",
    metrics: {
      ready: 1, running: 2, oldest_seconds: 3, overdueCompanies: 0, overdueDiscovery: 0,
      crashRecoveries1h: 0, crashRecoveries24h: 0,
      providerCalls1h: 0, providerSuccesses1h: 0, providerFailures1h: 0,
      providerOutageGroups1h: 0, spend24hUsd: 0, spendMonthUsd: 0,
      accountsAtOrOverBudget: 0,
    },
    vitals: { heapFraction: 0.5, uptimeSeconds: 100, db: { waiting: 0 } },
  }), healthy({ ready: 1, running: 2, oldestSeconds: 3, heapFraction: 0.5 }));
  assert.throws(() => readOperationalSample({
    ok: true, workerId: "worker-a",
    metrics: { ready: -1, running: 0, oldest_seconds: 0, overdueCompanies: 0, overdueDiscovery: 0 },
    vitals: { heapFraction: 1.1, uptimeSeconds: -2, db: { waiting: -1 } },
  }), /missing required operational fields/);
  assert.throws(() => readOperationalSample({
    ok: true, workerId: "worker-a",
    metrics: { ready: 0.5, running: 0, oldest_seconds: 0, overdueCompanies: 0, overdueDiscovery: 0 },
    vitals: { heapFraction: 0.5, uptimeSeconds: 10, db: { waiting: 0 } },
  }), /missing required operational fields/);
  assert.throws(() => readOperationalSample({
    ok: true, workerId: " ",
    metrics: { ready: 0, running: 0, oldest_seconds: 0, overdueCompanies: 0, overdueDiscovery: 0 },
    vitals: { heapFraction: 0.5, uptimeSeconds: 10, db: { waiting: 0 } },
  }), /workerId/);
});

test("healthy idle and working samples pass without making an uptime claim", () => {
  assert.deepEqual(operationalFailures([healthy(), healthy({ ready: 4, running: 2 }), healthy({ ready: 2, running: 1 })]), []);
});

test("a materially old queue fails", () => {
  const failures = operationalFailures([healthy(), healthy({ ready: 1, oldestSeconds: 901 })]);
  assert.ok(failures.some(value => value.includes("oldest task")));
});

test("a few overdue companies are reported as attention, and the gate fails only when many are", () => {
  const few = [healthy({ overdueCompanies: 3 }), healthy({ overdueCompanies: 3 })];
  assert.deepEqual(operationalFailures(few), []);
  assert.deepEqual(operationalWarnings(few), [`3 companies are overdue for a successful daily scan (the gate fails at ${OPERATIONAL_THRESHOLDS.overdueCompanies})`]);
  const many = [healthy({ overdueCompanies: 2 }), healthy({ overdueCompanies: OPERATIONAL_THRESHOLDS.overdueCompanies })];
  assert.deepEqual(operationalFailures(many), [`${OPERATIONAL_THRESHOLDS.overdueCompanies} companies are overdue for a successful daily scan`]);
  assert.deepEqual(operationalWarnings(many), []);
});

test("companies that cannot be scanned are attention when a worker reports them, and optional otherwise", () => {
  const body = {
    ok: true, workerId: "worker-a",
    metrics: {
      ready: 0, running: 0, oldest_seconds: 0, overdueCompanies: 0, overdueDiscovery: 0,
      crashRecoveries1h: 0, crashRecoveries24h: 0, providerCalls1h: 0, providerSuccesses1h: 0, providerFailures1h: 0,
      providerOutageGroups1h: 0, spend24hUsd: 0, spendMonthUsd: 0, accountsAtOrOverBudget: 0,
    },
    vitals: { heapFraction: 0.4, uptimeSeconds: 100, db: { waiting: 0 } },
  };
  assert.equal(readOperationalSample(body).unscannableCompanies, undefined);
  const sample = readOperationalSample({ ...body, metrics: { ...body.metrics, unscannableCompanies: 40 } });
  assert.equal(sample.unscannableCompanies, 40);
  assert.deepEqual(operationalFailures([sample, sample]), []);
  assert.match(operationalWarnings([sample])[0], /^40 companies have no source that can be scanned/);
  assert.throws(() => readOperationalSample({ ...body, metrics: { ...body.metrics, unscannableCompanies: -1 } }), /unscannableCompanies/);
});

test("transient pressure passes but sustained memory and database waits fail", () => {
  assert.deepEqual(operationalFailures([healthy({ heapFraction: 0.9, dbWaiting: 1 }), healthy()]), []);
  const failures = operationalFailures([healthy({ heapFraction: 0.9, dbWaiting: 1 }), healthy({ heapFraction: 0.86, dbWaiting: 2 })]);
  assert.ok(failures.some(value => value.includes("heap pressure")));
  assert.ok(failures.some(value => value.includes("connection waits")));
});

test("the heap gate keeps its exact 85% boundary, including legacy rounded readings", () => {
  assert.deepEqual(operationalFailures([healthy({ heapFraction: 0.846 }), healthy({ heapFraction: 0.849 })]), []);
  assert.ok(operationalWarnings([healthy({ heapFraction: 0.846 }), healthy({ heapFraction: 0.849 })]).some(value => value.includes("worker heap")));
  assert.ok(operationalFailures([healthy({ heapFraction: 0.85 }), healthy({ heapFraction: 0.85 })]).some(value => value.includes("heap pressure")));
});

test("failed-gate diagnostics report only bounded memory samples and worker identity", () => {
  const sample = readOperationalSample(statusBody({ heapFraction: 0.851, heapUsedMb: 219, heapLimitMb: 258, rssMb: 403 }));
  const lines = operationalFailureDiagnostics([{ ...sample, sampledAt: "2026-10-02T08:00:00.000Z" }, { ...sample, workerId: "worker\nsecret", sampledAt: "2026-10-02T08:00:15.000Z" }]);
  assert.equal(lines, 'sample 1 at 2026-10-02T08:00:00.000Z from "worker-a": heapUsedMb=219, heapLimitMb=258, heapFraction=0.851, rssMb=403\n' +
    'sample 2 at 2026-10-02T08:00:15.000Z from "worker\\nsecret": heapUsedMb=219, heapLimitMb=258, heapFraction=0.851, rssMb=403');
  assert.ok(operationalFailures([sample, sample]).some(value => value.includes("heap pressure")));
  assert.throws(() => readOperationalSample(statusBody({ heapUsedMb: "219" })), /heapUsedMb/);
});

test("material queue growth fails once the queue is also large", () => {
  const failures = operationalFailures([healthy({ ready: 14 }), healthy({ ready: 20 }), healthy({ ready: 25 })]);
  assert.ok(failures.some(value => value.includes("grew by 11")));
});

test("one uptime regression permits a rollout but repeated regressions identify a restart loop", () => {
  assert.deepEqual(operationalFailures([healthy({ uptimeSeconds: 100 }), healthy({ uptimeSeconds: 2 }), healthy({ uptimeSeconds: 17 })]), []);
  const failures = operationalFailures([
    healthy({ uptimeSeconds: 100 }),
    healthy({ uptimeSeconds: 2 }),
    healthy({ uptimeSeconds: 1 }),
  ]);
  assert.ok(failures.some(value => value.includes("repeated restarts")));
});

test("worker identity changes detect replacements even when sampled uptime does not decrease", () => {
  assert.deepEqual(operationalFailures([
    healthy({ workerId: "worker-a", uptimeSeconds: 5 }),
    healthy({ workerId: "worker-b", uptimeSeconds: 5 }),
    healthy({ workerId: "worker-b", uptimeSeconds: 20 }),
  ]), []);
  const failures = operationalFailures([
    healthy({ workerId: "worker-a", uptimeSeconds: 5 }),
    healthy({ workerId: "worker-b", uptimeSeconds: 5 }),
    healthy({ workerId: "worker-c", uptimeSeconds: 5 }),
  ]);
  assert.ok(failures.some(value => value.includes("repeated restarts")));
});

test("uptime remains a fallback when a restarted process reuses its worker identity", () => {
  const failures = operationalFailures([
    healthy({ workerId: "stable", uptimeSeconds: 100 }),
    healthy({ workerId: "stable", uptimeSeconds: 2 }),
    healthy({ workerId: "stable", uptimeSeconds: 1 }),
  ]);
  assert.ok(failures.some(value => value.includes("repeated restarts")));
});

test("mixed identity replacement and reused-ID restart still fail", () => {
  const failures = operationalFailures([
    healthy({ workerId: "first", uptimeSeconds: 100 }),
    healthy({ workerId: "second", uptimeSeconds: 10 }),
    healthy({ workerId: "second", uptimeSeconds: 1 }),
  ]);
  assert.ok(failures.some(value => value.includes("repeated restarts")));
});

test("persisted crash recovery evidence catches a loop outside the thirty-second sample", () => {
  const failures = operationalFailures([
    healthy({ uptimeSeconds: 120, crashRecoveries1h: 2, crashRecoveries24h: 3 }),
    healthy({ uptimeSeconds: 135, crashRecoveries1h: 2, crashRecoveries24h: 3 }),
  ]);
  assert.ok(failures.some(value => value.includes("2 worker crash recoveries")));
  assert.deepEqual(operationalFailures([
    healthy({ crashRecoveries1h: 1, crashRecoveries24h: 1 }),
    healthy({ crashRecoveries1h: 1, crashRecoveries24h: 1 }),
  ]), []);
});

test("one failing provider group fails and an observed recovery clears it", () => {
  const failed = operationalFailures([
    healthy({ providerCalls1h: 4, providerSuccesses1h: 1, providerFailures1h: 3, providerOutageGroups1h: 1 }),
    healthy({ providerCalls1h: 4, providerSuccesses1h: 1, providerFailures1h: 3, providerOutageGroups1h: 1 }),
  ]);
  assert.ok(failed.some(value => value.includes("call-site/model groups")));
  assert.deepEqual(operationalFailures([
    healthy({ providerCalls1h: 3, providerFailures1h: 3, providerOutageGroups1h: 1 }),
    healthy({ providerCalls1h: 4, providerSuccesses1h: 1, providerFailures1h: 3, providerOutageGroups1h: 0 }),
  ]), []);
});

test("configured account budget exhaustion warns without failing global operations or exposing identity", () => {
  const samples = [
    healthy({ accountsAtOrOverBudget: 2, spendMonthUsd: 50 }),
    healthy({ accountsAtOrOverBudget: 2, spendMonthUsd: 50 }),
  ];
  const failures = operationalFailures(samples);
  assert.deepEqual(failures, []);
  assert.deepEqual(operationalWarnings(samples), ["2 accounts are at or over their configured AI budget"]);
  assert.match(operationalSuccessMessage(samples.at(-1)), /^Operational gate passed:/);
  assert.equal(
    operationalAttentionMessage(operationalWarnings(samples)),
    "Operational attention (does not fail this gate):\n- 2 accounts are at or over their configured AI budget",
  );
});

test("new telemetry cannot disappear or become invalid and silently pass", () => {
  const response = {
    ok: true, workerId: "worker-a",
    metrics: {
      ready: 0, running: 0, oldest_seconds: 0, overdueCompanies: 0, overdueDiscovery: 0,
      crashRecoveries1h: 0, crashRecoveries24h: 0,
      providerCalls1h: 0, providerSuccesses1h: 0, providerFailures1h: 0,
      providerOutageGroups1h: 0, spend24hUsd: 0, spendMonthUsd: 0,
      accountsAtOrOverBudget: 0,
    },
    vitals: { heapFraction: 0.4, uptimeSeconds: 100, db: { waiting: 0 } },
  };
  delete response.metrics.providerOutageGroups1h;
  assert.throws(() => readOperationalSample(response), /providerOutageGroups1h/);
  response.metrics.providerOutageGroups1h = 0;
  response.metrics.spendMonthUsd = Number.NaN;
  assert.throws(() => readOperationalSample(response), /spendMonthUsd/);
});

const statusBody = (vitals = {}) => ({
  ok: true, workerId: "worker-a",
  metrics: {
    ready: 0, running: 0, oldest_seconds: 0, overdueCompanies: 0, overdueDiscovery: 0,
    crashRecoveries1h: 0, crashRecoveries24h: 0, providerCalls1h: 0, providerSuccesses1h: 0, providerFailures1h: 0,
    providerOutageGroups1h: 0, spend24hUsd: 0, spendMonthUsd: 0, accountsAtOrOverBudget: 0,
  },
  vitals: { heapFraction: 0.4, uptimeSeconds: 100, ...vitals, db: { waiting: 0, ...vitals.db } },
});

test("a worker that does not report event-loop lag, slow queries or pool totals still passes", () => {
  const sample = readOperationalSample(statusBody());
  for (const key of ["eventLoopLagP99Ms", "slowQueries", "dbTotal", "dbIdle"]) assert.equal(key in sample, false, key);
  assert.deepEqual(operationalFailures([sample, sample, sample]), []);
  assert.deepEqual(operationalWarnings([sample, sample, sample]), []);
  assert.equal(slowQueryDelta([sample, sample]), null);
});

test("event-loop lag, slow queries and pool totals are read when reported, and refused when malformed", () => {
  const sample = readOperationalSample(statusBody({ eventLoopLagP99Ms: 12, slowQueries: 3, db: { total: 4, idle: 3, waiting: 0 } }));
  assert.deepEqual({ lag: sample.eventLoopLagP99Ms, slow: sample.slowQueries, total: sample.dbTotal, idle: sample.dbIdle }, { lag: 12, slow: 3, total: 4, idle: 3 });
  assert.throws(() => readOperationalSample(statusBody({ eventLoopLagP99Ms: -1 })), /eventLoopLagP99Ms/);
  assert.throws(() => readOperationalSample(statusBody({ slowQueries: 1.5 })), /slowQueries/);
  assert.throws(() => readOperationalSample(statusBody({ db: { total: "4" } })), /dbTotal/);
});

test("event-loop lag is attention at 200 ms and fails at a second in two samples", () => {
  const lag = ms => healthy({ eventLoopLagP99Ms: ms });
  assert.deepEqual(operationalFailures([lag(20), lag(30), lag(40)]), []);
  assert.deepEqual(operationalWarnings([lag(20), lag(30), lag(40)]), []);
  assert.deepEqual(operationalFailures([lag(20), lag(250), lag(250)]), []);
  assert.match(operationalWarnings([lag(20), lag(250), lag(250)])[0], /event-loop delay p99 since boot is 250 ms/);
  assert.deepEqual(operationalFailures([lag(1_200), lag(300), lag(300)]), [], "one stalled sample is not sustained");
  assert.match(operationalFailures([lag(1_200), lag(1_000), lag(300)])[0], /event-loop delay p99 is 1200 ms, at or above 1000 ms in 2 samples/);
});

test("slow queries are compared within one process: attention at 20, a failure at 100, a restart resets the count", () => {
  const at = (slowQueries, extra = {}) => healthy({ slowQueries, ...extra });
  assert.equal(slowQueryDelta([at(5), at(9), at(12)]), 7);
  assert.deepEqual(operationalWarnings([at(5), at(9), at(12)]), []);
  assert.match(operationalWarnings([at(5), at(15), at(25)])[0], /^20 queries took 250 ms or longer during the check/);
  assert.deepEqual(operationalFailures([at(5), at(15), at(25)]), [], "attention never fails the run");
  assert.match(operationalFailures([at(0), at(60), at(100)])[0], /^100 queries took 250 ms or longer/);
  assert.deepEqual(operationalWarnings([at(0), at(60), at(100)]).filter(w => /queries took/.test(w)), [], "a failure is not also attention");
  // A replacement process starts its counter from nought: the old one's total is not a burst.
  assert.equal(slowQueryDelta([at(500, { workerId: "old", uptimeSeconds: 900 }), at(3, { workerId: "new", uptimeSeconds: 5 }), at(4, { workerId: "new", uptimeSeconds: 20 })]), 1);
  assert.equal(slowQueryDelta([at(500, { uptimeSeconds: 900 }), at(3, { uptimeSeconds: 5 })]), null, "the same id with a younger uptime restarted");
});

test("heap, a single pool wait and a five-minute-old task are attention below their failures", () => {
  assert.deepEqual(operationalWarnings([healthy({ heapFraction: 0.76 }), healthy({ heapFraction: 0.5 }), healthy({ heapFraction: 0.74 })]), [], "one warm sample is not sustained");
  const warm = [healthy({ heapFraction: 0.76 }), healthy({ heapFraction: 0.8 }), healthy({ heapFraction: 0.5 })];
  assert.deepEqual(operationalFailures(warm), []);
  assert.match(operationalWarnings(warm)[0], /^worker heap is at or above 75% in 2 samples/);
  assert.deepEqual(operationalWarnings([healthy({ heapFraction: 0.9 }), healthy({ heapFraction: 0.9 })]).filter(w => /heap/.test(w)), [], "a failure is not also attention");
  const oneWait = [healthy(), healthy({ dbWaiting: 1 }), healthy()];
  assert.deepEqual(operationalFailures(oneWait), []);
  assert.match(operationalWarnings(oneWait)[0], /waited for a database connection in 1 sample/);
  const stale = [healthy(), healthy({ ready: 2, oldestSeconds: 6 * 60 })];
  assert.deepEqual(operationalFailures(stale), []);
  assert.match(operationalWarnings(stale)[0], /oldest ready task has waited 6 minutes/);
});

const monitorBody = (overrides = {}) => ({
  at: "2026-09-27T12:00:00.000Z",
  worker: null,
  backends: { active: 12, total: 30, usable: 97, fraction: 0.124 },
  oldestReadySeconds: 0,
  scans: { since: "2026-09-27", total: 40, failed: 1, failedShare: 0.025 },
  models: { calls1h: 50, rateLimited1h: 0, rateLimitedShare: 0 },
  slowQueries: { per15m: 2, history: [] },
  webVitalsPruned: 0,
  levels: {},
  ...overrides,
});
const NOW = Date.parse("2026-09-27T12:02:00.000Z");
const withMonitor = overrides => readOperationalSample({ ...statusBody(), monitor: monitorBody(overrides) });

test("the monitor's sample is optional, and read when a worker serves it", () => {
  assert.equal("monitor" in readOperationalSample(statusBody()), false);
  assert.equal("monitor" in readOperationalSample({ ...statusBody(), monitor: null }), false);
  assert.equal("monitor" in readOperationalSample({ ...statusBody(), monitor: { at: "not a date" } }), false, "an unreadable sample is no sample, never a failure");
  const sample = withMonitor();
  assert.deepEqual(sample.monitor, readMonitor(monitorBody()));
  assert.deepEqual(operationalFailures([sample, sample]), []);
  assert.deepEqual(operationalWarnings([sample, sample], OPERATIONAL_THRESHOLDS, NOW), []);
});

test("active backends, scan failures, model rate limits and slow queries warn and fail at the guide's lines", () => {
  const judge = overrides => {
    const sample = withMonitor(overrides);
    return { failures: operationalFailures([sample, sample]), warnings: operationalWarnings([sample, sample], OPERATIONAL_THRESHOLDS, NOW) };
  };
  let result = judge({ backends: { active: 60, total: 70, usable: 97, fraction: 0.619 } });
  assert.deepEqual(result.failures, []);
  assert.match(result.warnings[0], /^60 of 97 usable Postgres connections are active \(62%; attention at 60%\)/);
  result = judge({ backends: { active: 80, total: 90, usable: 97, fraction: 0.825 } });
  assert.match(result.failures[0], /the gate fails at 80%/);
  assert.deepEqual(result.warnings, []);

  result = judge({ scans: { since: "2026-09-27", total: 40, failed: 5, failedShare: 0.125 } });
  assert.deepEqual(result.failures, []);
  assert.match(result.warnings[0], /^13% of today's 40 scans did not succeed \(attention at 10%\)/);
  assert.match(judge({ scans: { since: "2026-09-27", total: 40, failed: 12, failedShare: 0.3 } }).failures[0], /30% of today's 40 scans/);
  result = judge({ scans: { since: "2026-09-27", total: 4, failed: 2, failedShare: 0.5 } });
  assert.deepEqual(result.failures, [], "two failures in four scans is attention, not an outage");
  assert.match(result.warnings[0], /50% of today's 4 scans/);

  result = judge({ models: { calls1h: 100, rateLimited1h: 6, rateLimitedShare: 0.06 } });
  assert.deepEqual(result.failures, []);
  assert.match(result.warnings[0], /6% of the last hour's 100 model calls were refused as rate-limited or overloaded/);
  assert.match(judge({ models: { calls1h: 100, rateLimited1h: 25, rateLimitedShare: 0.25 } }).failures[0], /25% of the last hour's 100 model calls/);
  assert.deepEqual(judge({ models: { calls1h: 3, rateLimited1h: 3, rateLimitedShare: 1 } }).failures, []);

  result = judge({ slowQueries: { per15m: 20, history: [] } });
  assert.deepEqual(result.failures, []);
  assert.match(result.warnings[0], /counted 20 queries of 250 ms or longer in fifteen minutes \(attention at 20\)/);
  assert.match(judge({ slowQueries: { per15m: 150, history: [] } }).failures[0], /counted 150 queries/);
});

test("a monitor sample twenty minutes old is attention: the task that takes it has stopped", () => {
  const sample = withMonitor({ at: "2026-09-27T11:40:00.000Z" });
  assert.deepEqual(operationalFailures([sample, sample]), []);
  assert.match(operationalWarnings([sample, sample], OPERATIONAL_THRESHOLDS, NOW)[0], /monitor sample is 22 minutes old/);
});

/** A throwaway repository whose history is main, then a branch merged with a merge commit. */
function history() {
  const dir = mkdtempSync(join(tmpdir(), "ava-release-checks-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commit = (message, files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@ava.dev", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  return { dir, git, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a merge that changes no worker input leaves the running worker current", () => {
  const repo = history();
  try {
    const worker = repo.commit("worker", { "apps/worker/src/index.ts": "1", "apps/web/page.tsx": "1", "packages/core/a.ts": "1" });
    const web = repo.commit("web only", { "apps/web/page.tsx": "2", "apps/web/package.json": "{}" });
    const docs = repo.commit("docs only", { "docs/DEPLOY.md": "notes", "README.md": "readme" });
    assert.equal(sameWorkerInputs(worker, worker, { cwd: repo.dir }), true);
    assert.equal(sameWorkerInputs(worker, web, { cwd: repo.dir }), true);
    assert.equal(sameWorkerInputs(worker, docs, { cwd: repo.dir }), true);

    for (const [path, content] of [["packages/core/a.ts", "2"], ["pnpm-lock.yaml", "lock"], ["Dockerfile", "FROM x"], ["package.json", "{}"]]) {
      const changed = repo.commit(`touches ${path}`, { [path]: content });
      assert.equal(sameWorkerInputs(docs, changed, { cwd: repo.dir }), false, path);
      assert.equal(sameWorkerInputs(changed, changed, { cwd: repo.dir }), true, path);
    }
  } finally { repo.cleanup(); }
});

test("a worker on a commit that is not in the merged history, or unknown, is not current", () => {
  const repo = history();
  try {
    const base = repo.commit("base", { "apps/worker/a.ts": "1" });
    repo.git("checkout", "-q", "-b", "elsewhere");
    const elsewhere = repo.commit("unmerged branch", { "docs/x.md": "x" });
    repo.git("checkout", "-q", "main");
    const main = repo.commit("main", { "docs/y.md": "y" });
    assert.equal(sameWorkerInputs(base, main, { cwd: repo.dir }), true);
    assert.equal(sameWorkerInputs(elsewhere, main, { cwd: repo.dir }), false);
    assert.equal(sameWorkerInputs("f".repeat(40), main, { cwd: repo.dir }), false);
    assert.equal(sameWorkerInputs("not reported", main, { cwd: repo.dir }), false);
  } finally { repo.cleanup(); }
});

test("a merge commit that brings worker changes needs the worker to redeploy", () => {
  const repo = history();
  try {
    const before = repo.commit("base", { "apps/worker/a.ts": "1" });
    repo.git("checkout", "-q", "-b", "feature");
    repo.commit("feature", { "apps/worker/a.ts": "2" });
    repo.git("checkout", "-q", "main");
    repo.git("-c", "user.name=test", "-c", "user.email=test@ava.dev", "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge", "feature");
    const merge = repo.git("rev-parse", "HEAD");
    assert.equal(sameWorkerInputs(before, merge, { cwd: repo.dir }), false);
    const docs = repo.commit("docs after the merge", { "docs/z.md": "z" });
    assert.equal(sameWorkerInputs(merge, docs, { cwd: repo.dir }), true);
  } finally { repo.cleanup(); }
});

test("a worker behind a fresh merge is deploying, and behind an old one is stale", () => {
  const git = () => { throw new Error("differs"); };
  const expected = "a".repeat(40), running = "b".repeat(40), now = Date.parse("2026-09-23T12:00:00Z");
  assert.equal(workerIdentity(running, expected, { git, now, committedAt: now - 5 * 60_000 }), "deploying");
  assert.equal(workerIdentity(running, expected, { git, now, committedAt: now - 25 * 60_000 }), "stale");
  assert.equal(workerIdentity("not reported", expected, { git, now, committedAt: now }), "stale");
  assert.equal(workerIdentity(expected, expected, { git, now, committedAt: now - 60 * 60_000 }), "current");
});
