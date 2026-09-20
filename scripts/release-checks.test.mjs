import assert from "node:assert/strict";
import test from "node:test";
import {
  operationalFailures,
  operationalAttentionMessage,
  operationalSuccessMessage,
  operationalWarnings,
  readOperationalSample,
  readReleaseHealth,
  requiredOperationalConfig,
  requiredReleaseConfig,
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
  }), { expected: "b".repeat(40), url: "https://worker.example/healthz" });
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

test("overdue daily work and a materially old queue fail", () => {
  const failures = operationalFailures([
    healthy({ overdueCompanies: 1 }),
    healthy({ ready: 1, oldestSeconds: 901, overdueCompanies: 1 }),
  ]);
  assert.ok(failures.some(value => value.includes("overdue")));
  assert.ok(failures.some(value => value.includes("oldest task")));
});

test("transient pressure passes but sustained memory and database waits fail", () => {
  assert.deepEqual(operationalFailures([healthy({ heapFraction: 0.9, dbWaiting: 1 }), healthy()]), []);
  const failures = operationalFailures([healthy({ heapFraction: 0.9, dbWaiting: 1 }), healthy({ heapFraction: 0.86, dbWaiting: 2 })]);
  assert.ok(failures.some(value => value.includes("heap pressure")));
  assert.ok(failures.some(value => value.includes("connection waits")));
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
