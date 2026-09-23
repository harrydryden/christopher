import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pendingTaskCounts, workloadMetrics } from "@ava/db";
import { sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { log } from "./log";
import { vitals } from "./vitals";

/**
 * Heap use at which the process is close enough to the ceiling that a restart is the likely next
 * event. Render reads only `ok`, so this is for whoever is watching a deploy or a hang.
 */
export const HEAP_PRESSURE_FRACTION = 0.85;

/** How long one reading of the queue and workload serves every `/status` caller. */
export const HEALTH_CACHE_MS = 30_000;

/** How long the liveness check waits for the database to answer `select 1`. */
export const LIVENESS_DB_TIMEOUT_MS = 2_000;

/**
 * How long the database may go unanswered before liveness fails. A blip or a slow minute is the
 * database's problem, and restarting a healthy worker over it only interrupts its work; a pool
 * that has not answered for this long is wedged, and a restart is what clears it.
 */
export const HEALTH_DB_STALE_FAIL_MS = 5 * 60_000;

export interface HealthServerOptions {
  /** Whether the queue is claiming work. Liveness fails once it is not. */
  isRunning?: () => boolean;
  /** The full workload reading behind `/status`; tests substitute a slow or failing one. */
  readMetrics?: () => Promise<{ queue: unknown; metrics: unknown }>;
  /** The liveness check's database round trip. */
  probeDatabase?: () => Promise<unknown>;
  now?: () => number;
}

/** The bearer `/status` asks for, when the deployment has set one. Read per request. */
function statusToken(): string | null {
  const token = process.env.WORKER_STATUS_TOKEN?.trim();
  return token ? token : null;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const supplied = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Resolves with `work`'s value, or rejects once `ms` has passed without one. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); timer.unref?.(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Two routes. `/healthz` (and `/`, `/health`) is the platform's liveness probe: the process is up,
 * the queue is claiming, and the database answers a `select 1`. It never reads the workload, and
 * says nothing about it: the full-table aggregates it used to run on every probe put the heaviest
 * query in the process on whatever polled hardest, and turned a slow database into a restart of a
 * worker that was fine. `/status` is the full reading — the queue, the workload, spend, vitals —
 * computed at most every thirty seconds, behind `WORKER_STATUS_TOKEN` when one is set, and reduced
 * to the liveness answer when none is, because the address is public.
 */
export function startHealthServer(
  deps: WorkerDeps,
  port: number,
  extra: () => Record<string, unknown> = () => ({}),
  options: HealthServerOptions = {},
): http.Server {
  const now = options.now ?? Date.now;
  const readMetrics = options.readMetrics ?? (async () => {
    const [queue, metrics] = await Promise.all([pendingTaskCounts(deps.db), workloadMetrics(deps.db)]);
    return { queue, metrics };
  });
  const probeDatabase = options.probeDatabase ?? (() => deps.db.execute(sql`select 1`));

  // In-process memory is the right place for the reading: each worker answers for itself.
  let cached: { at: number; value: { queue: unknown; metrics: unknown } } | null = null;
  let reading: Promise<{ queue: unknown; metrics: unknown }> | null = null;
  const readState = async () => {
    if (cached && now() - cached.at < HEALTH_CACHE_MS) return cached.value;
    reading ??= (async () => {
      try {
        const value = await readMetrics();
        cached = { at: now(), value };
        return value;
      } finally {
        reading = null;
      }
    })();
    return reading;
  };

  // One probe at a time: a probe that has not come back is the answer for every caller meanwhile.
  const startedAt = now();
  let lastDbOkAt: number | null = null;
  let probing: Promise<boolean> | null = null;
  const databaseAnswers = () => {
    probing ??= within(probeDatabase(), LIVENESS_DB_TIMEOUT_MS)
      .then(() => { lastDbOkAt = now(); return true; }, () => false)
      .finally(() => { probing = null; });
    return probing;
  };

  const liveness = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    const identity = { workerId: deps.env.workerId, commit: extra().commit ?? process.env.RENDER_GIT_COMMIT ?? null };
    if (options.isRunning && !options.isRunning()) return { status: 503, body: { ok: false, ...identity, reason: "queue stopped" } };
    if (await databaseAnswers()) return { status: 200, body: { ok: true, ...identity } };
    const silentFor = now() - (lastDbOkAt ?? startedAt);
    if (silentFor < HEALTH_DB_STALE_FAIL_MS) return { status: 200, body: { ok: true, ...identity, database: "not answering" } };
    return { status: 503, body: { ok: false, ...identity, reason: "database not answering" } };
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://worker").pathname;
    try {
      if (path === "/healthz" || path === "/" || path === "/health") {
        const { status, body } = await liveness();
        send(res, status, body);
        return;
      }
      if (path === "/status") {
        const token = statusToken();
        if (!token) {
          const { status, body } = await liveness();
          send(res, status, body);
          return;
        }
        if (!bearerMatches(req.headers.authorization, token)) {
          send(res, 401, { ok: false, error: "unauthorised" });
          return;
        }
        const { queue, metrics } = await readState();
        const current = vitals();
        // `vitals` is the reading that matters: heap against the ceiling V8 kills the process at.
        // `memory` is the raw `process.memoryUsage()` this route used to return, kept for one
        // release in case a dashboard or script outside this repository still reads it.
        send(res, 200, {
          ok: true, workerId: deps.env.workerId, queue, metrics,
          vitals: current, pressure: current.heapFraction >= HEAP_PRESSURE_FRACTION,
          memory: process.memoryUsage(), ...extra(),
        });
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      log.warn("health route failed", { path, error: (err as Error).message });
      send(res, 500, { ok: false, error: "status unavailable" });
    }
  });
  server.listen(port, () => log.info("health server listening", { port }));
  return server;
}
