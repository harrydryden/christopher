/**
 * Everything an application needs at runtime. Migrations are deliberately NOT re-exported here:
 * they resolve the migrations folder relative to their own module, which bundlers treat as an
 * asset reference. Import them from "@christopher/db/migrate" instead.
 */
export * from "./schema";
export * as schema from "./schema";
export { createDb, getDb, type Db, type CreateDbOptions } from "./client";
export { enqueueTask, pendingTaskCounts, taskById, activeTaskFor, type EnqueueOptions } from "./tasks";

export { reevaluateGate, archiveNonMatches, type GateScope, type ArchiveScope } from "./gate";
export { appendProfile, latestProfileFor } from "./profiles";
export { workloadMetrics } from "./scaling";
export { addHttpHostDaily, listHttpHostDaily, pruneHttpHostDaily, emptyHttpCounters, latencyBucketIndex, LATENCY_BUCKET_UPPER_MS, type HttpHostCounters, type HttpHostDailyDelta } from "./http-rollup";
export { recordWorkerEvent, listWorkerEvents, countWorkerEvents, pruneWorkerEvents, type WorkerEventInput } from "./worker-events";
export { accountAiSpend, totalAiSpend, aiUsageByAccount, releaseAiHolds, type AiAccountUsage, type ReleasedHolds } from "./ai-budget";

export { roleStatusSql } from "./role-workflow";

export { scanRunSummary, scanRunSummaries, type ScanRunSummary } from "./scan-summary";

export { abandonCvDraft, actionCvs, completeCv, lockCvDraft, lockCvLifecycle, nextCvRevision } from "./cv-lifecycle";

export { cvRoleKey } from "./cv-role-key";

export { syncCompanyStatus, subscribeToCompany, setSubscriptionStatus, subscribedCompanyIds } from "./subscriptions";
export { BOOTSTRAP_USER_ID, BOOTSTRAP_EMAIL, DEFAULT_ADMIN_EMAILS, SEED_TAGS, adminEmailsFrom, completeAccountClaim, createUser, isEntitledEmail, isPlaceholderEmail, listUserIds, normaliseEmail, promoteIfEntitled, seedTagVocabulary, type CreateUserInput, type CreateUserResult } from "./users";
