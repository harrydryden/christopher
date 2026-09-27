/**
 * The five-minute monitor sample: the database-wide signals the operational gate reads from
 * `/status`, and the real-user vitals' retention.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { MONITOR_THRESHOLDS, monitorLevels, runMonitorSample, slowQueriesPer15m, type MonitorSample } from "./handlers/monitor-sample";
import { getInternal, setInternal } from "./settings";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
let now = new Date();
const deps = () => ({ db, now: () => now });

beforeAll(async () => {
  const client = createDb(DATABASE_URL, { max: 2 });
  db = client.db;
  pool = client.pool;
  await runMigrations(db);
}, 60_000);
afterAll(() => pool.end());
beforeEach(async () => {
  await db.execute(sql`truncate tasks, settings, ai_calls, scan_runs, scans, web_vitals, companies restart identity cascade`);
  now = new Date();
});

async function heartbeat(vitals: Record<string, unknown>, at = now, workerId = "worker-a") {
  await setInternal(db, "workerHeartbeat", { at: at.toISOString(), workerId, vitals });
}

describe("runMonitorSample", () => {
  it("stores the worker's vitals from its heartbeat, the backends, the oldest ready task and the vitals retention", async () => {
    await heartbeat({ heapFraction: 0.42, eventLoopLagP99Ms: 35, slowQueries: 4, db: { total: 6, idle: 5, waiting: 0 } });
    await db.insert(schema.tasks).values({ type: "run_daily", payload: { trigger: "schedule", runDate: "2026-09-27" }, runAfter: new Date(now.getTime() - 7 * 60_000) });
    await db.execute(sql`insert into web_vitals (day, route, metric, bucket, count) values
      ((now() at time zone 'utc')::date - 91, '/', 'LCP', 90, 3),
      ((now() at time zone 'utc')::date - 89, '/', 'LCP', 90, 4)`);

    const sample = await runMonitorSample(deps());
    expect(sample).not.toBeNull();
    expect(sample!.worker).toMatchObject({ workerId: "worker-a", heapFraction: 0.42, eventLoopLagP99Ms: 35, dbWaiting: 0, slowQueries: 4 });
    expect(sample!.backends.active).toBeGreaterThanOrEqual(1);
    expect(sample!.backends.usable).toBeGreaterThan(sample!.backends.active);
    expect(sample!.oldestReadySeconds).toBeGreaterThanOrEqual(7 * 60 - 5);
    expect(sample!.levels.oldestReady).toBe("warn");
    expect(sample!.webVitalsPruned).toBe(1);
    const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from web_vitals`);
    expect(left.rows[0]!.n).toBe(1);
    // Stored where /status and Operations read it.
    expect(await getInternal<MonitorSample>(db, "monitor")).toEqual(JSON.parse(JSON.stringify(sample)));
  });

  it("leaves the worker's vitals out when its heartbeat is stale", async () => {
    await heartbeat({ heapFraction: 0.9 }, new Date(now.getTime() - 10 * 60_000));
    const sample = await runMonitorSample(deps());
    expect(sample!.worker).toBeNull();
    expect(sample!.levels.heap).toBe("ok");
  });

  it("shares today's failed scans and the last hour's rate-limited model calls", async () => {
    const [company] = await db.insert(schema.companies).values({ name: "Monitor Co", homepageUrl: "https://monitor.invalid", domain: "monitor.invalid" }).returning();
    const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "greenhouse", url: "https://monitor.invalid/careers" }).returning();
    const [today] = await db.insert(schema.scanRuns).values({ runDate: now.toISOString().slice(0, 10), trigger: "schedule", startedAt: now }).returning();
    const [old] = await db.insert(schema.scanRuns).values({ runDate: "2026-01-01", trigger: "schedule", startedAt: new Date("2026-01-01T06:00:00Z") }).returning();
    const scan = (runId: string, status: "ok" | "failed" | "partial") => ({ scanRunId: runId, sourceId: source!.id, startedAt: now, finishedAt: now, status, fetchMethod: "api" as const });
    await db.insert(schema.scans).values([scan(today!.id, "ok"), scan(today!.id, "ok"), scan(today!.id, "failed"), scan(today!.id, "partial"), scan(old!.id, "failed")]);
    const call = (error: string | null, minutesAgo = 5) => ({ callSite: "A5", model: "model-a", ok: error === null, error, at: new Date(now.getTime() - minutesAgo * 60_000) });
    await db.insert(schema.aiCalls).values([
      call(null), call(null), call(null),
      call('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'),
      call('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      call("schema: output did not match"),
      call("429 rate limited", 90),
    ]);

    const sample = await runMonitorSample(deps());
    expect(sample!.scans).toMatchObject({ total: 4, failed: 2, failedShare: 0.5 });
    // Two of four is a share over too few scans to fail on.
    expect(sample!.levels.scanFailures).toBe("warn");
    expect(sample!.models).toEqual({ calls1h: 6, rateLimited1h: 2, rateLimitedShare: 0.333 });
    expect(sample!.levels.modelRateLimited).toBe("warn");
  });

  it("counts the worker's slow queries over fifteen minutes, one process at a time", async () => {
    await heartbeat({ heapFraction: 0.3, slowQueries: 10 });
    expect((await runMonitorSample(deps()))!.slowQueries.per15m).toBeNull();
    now = new Date(now.getTime() + 5 * 60_000);
    await heartbeat({ heapFraction: 0.3, slowQueries: 25 });
    expect((await runMonitorSample(deps()))!.slowQueries.per15m).toBe(15);
    now = new Date(now.getTime() + 5 * 60_000);
    await heartbeat({ heapFraction: 0.3, slowQueries: 140 });
    const busy = await runMonitorSample(deps());
    expect(busy!.slowQueries.per15m).toBe(130);
    expect(busy!.levels.slowQueries).toBe("fail");
    // A new process starts from nought: its first reading is no delta.
    now = new Date(now.getTime() + 5 * 60_000);
    await heartbeat({ heapFraction: 0.3, slowQueries: 1 }, now, "worker-b");
    expect((await runMonitorSample(deps()))!.slowQueries.per15m).toBeNull();
  });

  it("logs and returns null rather than throwing when the database refuses", async () => {
    const broken = { db: { execute: async () => { throw new Error("gone"); }, select: () => { throw new Error("gone"); } } as unknown as Db, now: () => now };
    await expect(runMonitorSample(broken)).resolves.toBeNull();
  });
});

describe("the monitor's thresholds", () => {
  it("are the operational gate's, line for line", async () => {
    // Loaded by URL: the gate is a plain script with no type declarations.
    const gateModule = new URL("../../../scripts/release-checks.mjs", import.meta.url).href;
    const gate = ((await import(gateModule)) as { OPERATIONAL_THRESHOLDS: Record<string, number> }).OPERATIONAL_THRESHOLDS;
    expect(MONITOR_THRESHOLDS).toEqual({
      heapFractionWarn: gate.heapFractionWarn,
      heapFractionFail: gate.heapFraction,
      eventLoopLagWarnMs: gate.eventLoopLagWarnMs,
      eventLoopLagFailMs: gate.eventLoopLagFailMs,
      backendsWarn: gate.backendsWarn,
      backendsFail: gate.backendsFail,
      oldestReadyWarnSeconds: gate.queueOldestWarnSeconds,
      oldestReadyFailSeconds: gate.queueOldestSeconds,
      scanFailuresWarn: gate.scanFailuresWarn,
      scanFailuresFail: gate.scanFailuresFail,
      modelRateLimitedWarn: gate.modelRateLimitedWarn,
      modelRateLimitedFail: gate.modelRateLimitedFail,
      slowQueriesWarnPer15m: gate.slowQueriesWarnPer15m,
      slowQueriesFailPer15m: gate.slowQueriesFailPer15m,
      minimumForFailure: gate.minimumForFailure,
    });
  });

  it("grade each signal warn or fail, and a share over too few events never fails", () => {
    const base: Omit<MonitorSample, "levels"> = {
      at: now.toISOString(),
      worker: { at: now.toISOString(), workerId: "w", heapFraction: 0.86, eventLoopLagP99Ms: 250, dbWaiting: 1, slowQueries: 0 },
      backends: { active: 70, total: 80, usable: 97, fraction: 0.72 },
      oldestReadySeconds: 20 * 60,
      scans: { since: "2026-09-27", total: 20, failed: 6, failedShare: 0.3 },
      models: { calls1h: 5, rateLimited1h: 5, rateLimitedShare: 1 },
      slowQueries: { per15m: null, history: [] },
      webVitalsPruned: 0,
    };
    expect(monitorLevels(base)).toEqual({
      heap: "fail", eventLoop: "warn", poolWaiting: "warn", backends: "warn", oldestReady: "fail",
      scanFailures: "fail", modelRateLimited: "warn", slowQueries: "ok",
    });
    expect(slowQueriesPer15m([], Date.now())).toBeNull();
  });
});
