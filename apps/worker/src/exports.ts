/**
 * The worker's public surface, so the interface can run the same handlers on a Vercel cron
 * when no separate worker service is deployed. See docs/DEPLOY.md.
 *
 * Nothing here imports Playwright eagerly: the browser is loaded on first use and only when
 * `AVA_DISABLE_BROWSER` is unset, so a serverless deployment never pulls it in.
 */
export { createDeps, makeFetchContext, makeDiscoveryContext, aiSpendThisMonth, aiBudgetExceeded, aiBudgetStop } from "./context";
export type { WorkerDeps, DepsOverrides, AiBudgetStop } from "./context";
export { readEnv } from "./env";
export type { WorkerEnv } from "./env";
export { TaskQueue, abandonTask, claimTask, completeTask, deadlineMsFor, failTask, recoverFromCrash, requeueStale, backoffMs, TASK_DEADLINES_MS, TASK_STALE_AFTER_MS } from "./queue";
export type { AbandonHook, AbandonHookMap, CrashRecovery, CrashSuspect, HandlerMap, RequeueOutcome, TaskDeadlines, TaskHandler, QueueOptions } from "./queue";
export { schedulerTick, startScheduler, reconcileCvDrafts } from "./scheduler";
export { handlers, onAbandon, onInterrupted, CV_ABANDONED_MESSAGE } from "./handlers";
export { vitals } from "./vitals";
export type { Vitals } from "./vitals";
export { ensureSeedTags } from "./handlers/learning";
export { loadSettings, loadUserSettings } from "./settings";
export { log } from "./log";
