/**
 * The worker's public surface, so the interface can run the same handlers on a Vercel cron
 * when no separate worker service is deployed. See docs/DEPLOY.md.
 *
 * Nothing here imports Playwright eagerly: the browser is loaded on first use and only when
 * `AVA_DISABLE_BROWSER` is unset, so a serverless deployment never pulls it in.
 */
export { createDeps } from "./context";
export { readEnv } from "./env";
export { TaskQueue, claimTask } from "./queue";
export type { HandlerMap, QueueOptions } from "./queue";
export { schedulerTick } from "./scheduler";
export { handlers, onAbandon, onInterrupted } from "./handlers";
