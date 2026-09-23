/**
 * Worker entry point. One always-on process that runs the scheduler, the task queue and every
 * outbound fetch and model call. See docs/SPEC.md section 6.
 */
import { recordWorkerEvent, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { enqueueBootGateReevaluation, seedTagVocabularies } from "./boot";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { startHealthServer } from "./health";
import { handlers, onAbandon, onInterrupted } from "./handlers";
import { log } from "./log";
import { setInternal } from "./settings";
import { recoverFromCrash, settleWithin, TaskQueue } from "./queue";
import { startScheduler } from "./scheduler";
import { vitals } from "./vitals";

async function main() {
  const env = readEnv();
  const bootedAt = new Date();
  const deps = await createDeps(env);
  const commit = process.env.RENDER_GIT_COMMIT ?? null;
  // The heap ceiling on the first line: an out-of-memory is the one failure nothing catches, and
  // the limit the process was actually given is what says whether the ceiling or the workload moved.
  log.info("worker starting", { workerId: env.workerId, concurrency: env.concurrency, ai: deps.ai.enabled, browser: !!deps.browser, commit, vitals: vitals() });

  await runMigrations(deps.db);
  await recordWorkerEvent(deps.db, { workerId: env.workerId, kind: "boot", detail: { concurrency: env.concurrency, commit, vitals: vitals(), bootedAt: bootedAt.toISOString() } });
  // Before anything is claimed: whatever is still `running` belonged to the incarnation before
  // this one, and whatever this worker id is holding against an account's budget is a dead hold.
  // Doing it here rather than waiting for the scheduler is what stops the task that killed the
  // last process being the first thing this one claims.
  await recoverFromCrash(deps, { workerId: env.workerId, onAbandon });
  await reviveRateLimitedSources(deps.db);
  await seedTagVocabularies(deps.db);
  // Gate semantics can change between releases; when they have, every account's gate is re-run
  // once. A boot on the same semantics queues nothing.
  await enqueueBootGateReevaluation(deps.db);

  const queue = new TaskQueue(deps, handlers, { concurrency: env.concurrency, workerId: env.workerId, onAbandon, onInterrupted });
  queue.start();
  // Written only by the persistent worker, never the short-lived web cron runner.
  const reportHeartbeat = async () => {
    try {
      // The interface reads exactly this shape. A fresh `at` alone said the worker was healthy
      // all through a crash loop, because every restart wrote one within seconds; `bootedAt` and
      // the heap are what let Health say "restarted a minute ago" instead of "reported a minute ago".
      await setInternal(deps.db, "workerHeartbeat", {
        at: new Date().toISOString(), workerId: env.workerId,
        aiConfigured: deps.ai.enabled, browserAvailable: !!deps.browser,
        commit,
        bootedAt: bootedAt.toISOString(),
        vitals: vitals(),
        active: queue.activeCount,
      });
    } catch (err) { log.error("worker heartbeat failed", err); }
  };
  await reportHeartbeat();
  const heartbeatTimer = setInterval(() => void reportHeartbeat(), 30_000);
  const scheduler = startScheduler(deps);
  const server = startHealthServer(deps, env.port, () => ({ active: queue.activeCount, commit: process.env.RENDER_GIT_COMMIT ?? null }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Armed before anything waits on the database. The platform kills the process thirty seconds
    // after SIGTERM, and this timer used to start only after two unbounded writes, so a slow
    // database pushed the hand-back past the kill and left every task `running` for five minutes.
    const timeout = setTimeout(() => {
      log.warn("shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    const handedBack = queue.activeCount;
    log.info("shutting down", { signal, active: handedBack, vitals: vitals() });
    clearInterval(heartbeatTimer);
    // The queue first: every run is stopped and its task handed back at once. The scheduler's tick
    // returns at its next step, and the ledger entry and the traffic counters are written beside
    // the hand-back rather than ahead of it, each within a bound.
    const queueStopped = queue.stop();
    const schedulerStopped = scheduler.stop();
    server.close();
    await settleWithin(Promise.allSettled([
      recordWorkerEvent(deps.db, {
        workerId: env.workerId, kind: "shutdown",
        detail: { signal, handedBack, uptimeSeconds: vitals().uptimeSeconds, commit, vitals: vitals() },
      }),
      deps.traffic.flush(),
    ]), SHUTDOWN_WRITE_MS);
    await queueStopped;
    await settleWithin(schedulerStopped, SHUTDOWN_WRITE_MS);
    await settleWithin(deps.close(), SHUTDOWN_WRITE_MS);
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", reason));
  // An uncaught exception has already unwound whatever was running, so the process cannot be
  // trusted to carry on: record why it went, put back what it held, then let the platform restart
  // it. Without the ledger entry Health shows a gap nobody can explain; without the hand-back the
  // tasks wait out a stale lock and the holds refuse their accounts' work until they expire. Both
  // are bounded, and the tasks spend their attempt as after any crash.
  let crashing = false;
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception", { error: { name: error.name, message: error.message, stack: error.stack }, vitals: vitals() });
    if (crashing) return;
    crashing = true;
    setTimeout(() => process.exit(1), CRASH_HAND_BACK_MS);
    void Promise.allSettled([
      queue.releaseAfterCrash(CRASH_HAND_BACK_MS - 500),
      recordWorkerEvent(deps.db, {
        workerId: env.workerId, kind: "shutdown",
        detail: { signal: "uncaughtException", error: error.message, commit, vitals: vitals() },
      }),
    ]).finally(() => process.exit(1));
  });
}

/**
 * The whole shutdown, under the platform's thirty seconds: the queue's hand-back, grace and hold
 * release, then the pool.
 */
const SHUTDOWN_DEADLINE_MS = 28_000;
/** The most any one of the shutdown's other writes may take. */
const SHUTDOWN_WRITE_MS = 2_000;
/** How long an uncaught exception may spend putting back what the process held. */
const CRASH_HAND_BACK_MS = 5_000;

/**
 * One-off repair, idempotent and cheap. Until 429 and 503 became a back-off, a single burst of
 * either marked a source `blocked` — a state only a person clears — and the daily run never looked
 * at it again. Those sources are returned to `failing`, which the daily run does pick up; a source
 * blocked by a 403 or a challenge page is left alone, because that one really does need a person.
 */
async function reviveRateLimitedSources(db: Db): Promise<void> {
  const revived = await db.execute(sql`update career_sources cs set status='failing', next_scan_at=null
    where cs.status='blocked'
      and (select s.error from scans s where s.source_id=cs.id order by s.started_at desc, s.id desc limit 1) ~ '^blocked \((429|503)\)'
    returning cs.id`);
  if (revived.rows.length) log.info("returned rate-limited sources to the daily run", { sources: revived.rows.length });
}

main().catch((err) => {
  log.error("worker failed to start", err);
  process.exit(1);
});
