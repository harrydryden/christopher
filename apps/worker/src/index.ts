/**
 * Worker entry point. One always-on process that runs the scheduler, the task queue and every
 * outbound fetch and model call. See docs/SPEC.md section 6.
 */
import { enqueueTask, listUserIds, recordWorkerEvent } from "@christopher/db";
import { dedupeKeyFor } from "@christopher/core";
import { runMigrations } from "@christopher/db/migrate";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { startHealthServer } from "./health";
import { handlers, onAbandon } from "./handlers";
import { ensureSeedTags } from "./handlers/learning";
import { log } from "./log";
import { setInternal } from "./settings";
import { recoverFromCrash, TaskQueue } from "./queue";
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
  await ensureSeedTags(deps);
  // Gate semantics can change between releases: re-run every account's gate once on boot. One task
  // per account, so each takes only its own lease and they run across the queue's slots instead of
  // queueing behind a single account-by-account task.
  for (const userId of await listUserIds(deps.db)) {
    const payload = { userId };
    await enqueueTask(deps.db, "reevaluate_gate", payload, { dedupeKey: dedupeKeyFor("reevaluate_gate", payload), priority: 6 });
  }

  const queue = new TaskQueue(deps, handlers, { concurrency: env.concurrency, workerId: env.workerId, onAbandon });
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
    log.info("shutting down", { signal, active: queue.activeCount, vitals: vitals() });
    await recordWorkerEvent(deps.db, {
      workerId: env.workerId, kind: "shutdown",
      detail: { signal, handedBack: queue.activeCount, uptimeSeconds: vitals().uptimeSeconds, commit, vitals: vitals() },
    });
    clearInterval(heartbeatTimer);
    scheduler.stop();
    server.close();
    const timeout = setTimeout(() => {
      log.warn("shutdown timed out; exiting");
      process.exit(1);
    }, 30_000);
    await queue.stop();
    await deps.close();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", reason));
}

main().catch((err) => {
  log.error("worker failed to start", err);
  process.exit(1);
});
