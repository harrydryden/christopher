import { sql } from "drizzle-orm";
import { claimableTaskSql } from "@col/db";
import type { WorkerDeps } from "../context";
import { log } from "../log";
import { getInternal, setInternal } from "../settings";

/**
 * Every five minutes, the signals the operational gate cannot read from one process: how busy the
 * database is, how today's scans and the last hour's model calls went, the worker's slow queries
 * over a quarter of an hour, and the oldest task waiting. Written to `settings['internal:monitor']`,
 * which Operations renders and `/status` serves, so the fifteen-minute gate enforces it. Also where
 * the real-user vitals' ninety-day retention runs.
 *
 * Run from the scheduler tick under a five-minute claim, so one sample is taken per five minutes
 * whichever process ticks. The worker's own vitals come from its heartbeat, not from the process
 * taking the sample, which may be the interface's cron fallback. Every reading is a count or a
 * share; nothing here names an account, a company or a statement.
 */

/** The table in docs/PERFORMANCE-GUIDE.md 5.5; scripts/release-checks.mjs holds the gate's copy, and a test holds the two equal. */
export const MONITOR_THRESHOLDS = Object.freeze({
  heapFractionWarn: 0.75,
  heapFractionFail: 0.85,
  eventLoopLagWarnMs: 200,
  eventLoopLagFailMs: 1_000,
  backendsWarn: 0.6,
  backendsFail: 0.8,
  oldestReadyWarnSeconds: 5 * 60,
  oldestReadyFailSeconds: 15 * 60,
  scanFailuresWarn: 0.1,
  scanFailuresFail: 0.25,
  modelRateLimitedWarn: 0.05,
  modelRateLimitedFail: 0.2,
  slowQueriesWarnPer15m: 20,
  slowQueriesFailPer15m: 100,
  /** Below this many scans today, or model calls in the hour, a share can warn but never fail: one bad call in three is not an outage. */
  minimumForFailure: 10,
});

/** How long the real-user vitals histograms are kept. */
export const WEB_VITALS_RETENTION_DAYS = 90;

/** A heartbeat older than this is a worker that is not reporting; its vitals are not sampled. */
const HEARTBEAT_FRESH_MS = 2 * 60_000;
/** Slow-query readings kept for the fifteen-minute delta: a little over the window. */
const SLOW_HISTORY_MS = 20 * 60_000;
const WINDOW_MS = 15 * 60_000;

export type MonitorLevel = "ok" | "warn" | "fail";

export interface MonitorSample {
  at: string;
  worker: { at: string; workerId: string | null; heapFraction: number | null; eventLoopLagP99Ms: number | null; dbWaiting: number | null; slowQueries: number | null } | null;
  backends: { active: number; total: number; usable: number; fraction: number };
  oldestReadySeconds: number;
  scans: { since: string; total: number; failed: number; failedShare: number | null };
  models: { calls1h: number; rateLimited1h: number; rateLimitedShare: number | null };
  slowQueries: { per15m: number | null; history: Array<{ at: string; workerId: string; count: number }> };
  webVitalsPruned: number;
  levels: Record<"heap" | "eventLoop" | "poolWaiting" | "backends" | "oldestReady" | "scanFailures" | "modelRateLimited" | "slowQueries", MonitorLevel>;
}

const level = (value: number | null, warn: number, fail: number, canFail = true): MonitorLevel =>
  value === null ? "ok" : canFail && value >= fail ? "fail" : value >= warn ? "warn" : "ok";

/** The slow queries of one worker process across the last fifteen minutes, from its readings; null with fewer than two. */
export function slowQueriesPer15m(history: MonitorSample["slowQueries"]["history"], now: number): number | null {
  const latest = history.at(-1);
  if (!latest) return null;
  // One process only: a restart resets the counter, and an older process's total is not a burst.
  const same = history.filter((entry) => entry.workerId === latest.workerId && now - Date.parse(entry.at) <= WINDOW_MS + 60_000);
  const first = same.find((entry) => entry.count <= latest.count);
  if (!first || first === latest) return null;
  return latest.count - first.count;
}

/** Levels from a sample's figures, by the thresholds above. Pure. */
export function monitorLevels(sample: Omit<MonitorSample, "levels">, t = MONITOR_THRESHOLDS): MonitorSample["levels"] {
  const worker = sample.worker;
  return {
    heap: level(worker?.heapFraction ?? null, t.heapFractionWarn, t.heapFractionFail),
    eventLoop: level(worker?.eventLoopLagP99Ms ?? null, t.eventLoopLagWarnMs, t.eventLoopLagFailMs),
    // One sample of waiting is attention; the gate fails on two of its own.
    poolWaiting: (worker?.dbWaiting ?? 0) > 0 ? "warn" : "ok",
    backends: level(sample.backends.fraction, t.backendsWarn, t.backendsFail),
    oldestReady: level(sample.oldestReadySeconds, t.oldestReadyWarnSeconds, t.oldestReadyFailSeconds),
    scanFailures: level(sample.scans.failedShare, t.scanFailuresWarn, t.scanFailuresFail, sample.scans.total >= t.minimumForFailure),
    modelRateLimited: level(sample.models.rateLimitedShare, t.modelRateLimitedWarn, t.modelRateLimitedFail, sample.models.calls1h >= t.minimumForFailure),
    slowQueries: level(sample.slowQueries.per15m, t.slowQueriesWarnPer15m, t.slowQueriesFailPer15m),
  };
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Take one sample and store it. Never throws: a failed sample is logged and the tick carries on. */
export async function runMonitorSample(deps: Pick<WorkerDeps, "db" | "now">): Promise<MonitorSample | null> {
  try {
    const now = deps.now();
    const nowMs = now.getTime();
    const [heartbeat, previous] = await Promise.all([
      getInternal<Record<string, unknown>>(deps.db, "workerHeartbeat"),
      getInternal<MonitorSample>(deps.db, "monitor"),
    ]);
    // One statement for every database figure, so the sample costs one round trip.
    const result = await deps.db.execute<{
      active: number; total: number; max_connections: number; reserved: number; oldest_seconds: number;
      scans_total: number; scans_failed: number; calls_1h: number; rate_limited_1h: number; since: string;
    }>(sql`select
      (select count(*)::int from pg_stat_activity where backend_type = 'client backend' and state is distinct from 'idle') as active,
      (select count(*)::int from pg_stat_activity where backend_type = 'client backend') as total,
      current_setting('max_connections')::int as max_connections,
      current_setting('superuser_reserved_connections')::int as reserved,
      (select coalesce(max(extract(epoch from now() - run_after)), 0)::float from tasks where status = 'queued' and run_after <= now() and ${claimableTaskSql}) as oldest_seconds,
      (select count(*)::int from scans s join scan_runs r on r.id = s.scan_run_id where r.started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc' and s.finished_at is not null) as scans_total,
      (select count(*)::int from scans s join scan_runs r on r.id = s.scan_run_id where r.started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc' and s.finished_at is not null and s.status <> 'ok') as scans_failed,
      (select count(*)::int from ai_calls where at >= now() - interval '1 hour') as calls_1h,
      (select count(*)::int from ai_calls where at >= now() - interval '1 hour' and not ok
        and error ~* '(^|[^0-9])(429|529)([^0-9]|$)|rate[_ ]?limit|overloaded') as rate_limited_1h,
      to_char(date_trunc('day', now() at time zone 'utc'), 'YYYY-MM-DD') as since`);
    const row = result.rows[0]!;
    const pruned = await deps.db.execute(sql`delete from web_vitals where day < (now() at time zone 'utc')::date - ${WEB_VITALS_RETENTION_DAYS}::int`);

    const beat = heartbeat && typeof heartbeat === "object" ? heartbeat : null;
    const beatAt = typeof beat?.at === "string" ? Date.parse(beat.at) : NaN;
    const vitals = beat?.vitals && typeof beat.vitals === "object" ? (beat.vitals as Record<string, unknown>) : null;
    const pool = vitals?.db && typeof vitals.db === "object" ? (vitals.db as Record<string, unknown>) : null;
    const fresh = Number.isFinite(beatAt) && nowMs - beatAt <= HEARTBEAT_FRESH_MS;
    const worker = fresh && beat ? {
      at: new Date(beatAt).toISOString(),
      workerId: typeof beat.workerId === "string" ? beat.workerId : null,
      heapFraction: num(vitals?.heapFraction),
      eventLoopLagP99Ms: num(vitals?.eventLoopLagP99Ms),
      dbWaiting: num(pool?.waiting),
      slowQueries: num(vitals?.slowQueries),
    } : null;

    const history = (previous?.slowQueries?.history ?? []).filter((entry) => nowMs - Date.parse(entry.at) <= SLOW_HISTORY_MS);
    if (worker?.workerId && worker.slowQueries !== null) history.push({ at: now.toISOString(), workerId: worker.workerId, count: worker.slowQueries });

    const usable = Math.max(1, Number(row.max_connections) - Number(row.reserved));
    const scansTotal = Number(row.scans_total), scansFailed = Number(row.scans_failed);
    const calls = Number(row.calls_1h), limited = Number(row.rate_limited_1h);
    const figures: Omit<MonitorSample, "levels"> = {
      at: now.toISOString(),
      worker,
      backends: { active: Number(row.active), total: Number(row.total), usable, fraction: Math.round((Number(row.active) / usable) * 1000) / 1000 },
      oldestReadySeconds: Math.round(Number(row.oldest_seconds)),
      scans: { since: row.since, total: scansTotal, failed: scansFailed, failedShare: scansTotal ? Math.round((scansFailed / scansTotal) * 1000) / 1000 : null },
      models: { calls1h: calls, rateLimited1h: limited, rateLimitedShare: calls ? Math.round((limited / calls) * 1000) / 1000 : null },
      slowQueries: { per15m: slowQueriesPer15m(history, nowMs), history },
      webVitalsPruned: pruned.rowCount ?? 0,
    };
    const sample: MonitorSample = { ...figures, levels: monitorLevels(figures) };
    await setInternal(deps.db, "monitor", sample);
    const raised = Object.entries(sample.levels).filter(([, value]) => value !== "ok");
    if (raised.length) log.warn("monitor sample needs attention", { levels: Object.fromEntries(raised) });
    return sample;
  } catch (error) {
    log.error("monitor sample failed", { error: (error as Error)?.message });
    return null;
  }
}
