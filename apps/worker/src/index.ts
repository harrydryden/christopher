/**
 * Worker entry point. One always-on process that runs the scheduler, the task queue and every
 * outbound fetch and model call. See docs/SPEC.md section 6.
 */
import {} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { startHealthServer } from "./health";
import { handlers } from "./handlers";
import { ensureSeedTags } from "./handlers/learning";
import { log } from "./log";
import { setInternal } from "./settings";
import { TaskQueue } from "./queue";
import { startScheduler } from "./scheduler";

async function main() {
  const env = readEnv();
  const deps = await createDeps(env);
  log.info("worker starting", { workerId: env.workerId, concurrency: env.concurrency, ai: deps.ai.enabled, browser: !!deps.browser });

  await runMigrations(deps.db);
  await ensureSeedTags(deps);

  const queue = new TaskQueue(deps, handlers, { concurrency: env.concurrency, workerId: env.workerId });
  queue.start();
  // Written only by the persistent worker, never the short-lived web cron runner.
  const reportHeartbeat = async () => {
    try {
      await setInternal(deps.db, "workerHeartbeat", {
        at: new Date().toISOString(), workerId: env.workerId,
        aiConfigured: deps.ai.enabled, browserAvailable: !!deps.browser,
      });
    } catch (err) { log.error("worker heartbeat failed", err); }
  };
  await reportHeartbeat();
  const heartbeatTimer = setInterval(() => void reportHeartbeat(), 30_000);
  const scheduler = startScheduler(deps);
  const server = startHealthServer(deps, env.port, () => ({ active: queue.activeCount }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
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
