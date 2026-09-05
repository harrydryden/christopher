/**
 * The worker's public surface, so the interface can run the same handlers on a Vercel cron
 * when no separate worker service is deployed. See docs/DEPLOY.md.
 *
 * Nothing here imports Playwright eagerly: the browser is loaded on first use and only when
 * `CHRISTOPHER_DISABLE_BROWSER` is unset, so a serverless deployment never pulls it in.
 */
export { createDeps, makeFetchContext, makeDiscoveryContext, aiSpendThisMonth, aiBudgetExceeded } from "./context";
export type { WorkerDeps, DepsOverrides } from "./context";
export { readEnv } from "./env";
export type { WorkerEnv } from "./env";
export { TaskQueue, claimTask, completeTask, failTask, requeueStale, backoffMs } from "./queue";
export type { HandlerMap, TaskHandler, QueueOptions } from "./queue";
export { schedulerTick, startScheduler } from "./scheduler";
export { handlers } from "./handlers";
export { ensureSeedTags } from "./handlers/learning";
export { loadSettings } from "./settings";
export { log } from "./log";
