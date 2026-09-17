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
export { accountAiSpend, sharedAiSpend, aiUsageByAccount, type AiAccountUsage } from "./ai-budget";

export { roleStatusSql } from "./role-workflow";

export { scanRunSummary } from "./scan-summary";

export { actionCvs, completeCv, lockCvDraft, lockCvLifecycle, nextCvRevision } from "./cv-lifecycle";

export { cvRoleKey } from "./cv-role-key";

export { syncCompanyStatus, subscribeToCompany, setSubscriptionStatus, subscribedCompanyIds } from "./subscriptions";
export { BOOTSTRAP_USER_ID, BOOTSTRAP_EMAIL, DEFAULT_ADMIN_EMAILS, SEED_TAGS, adminEmailsFrom, completeAccountClaim, createUser, isEntitledEmail, isPlaceholderEmail, listUserIds, normaliseEmail, promoteIfEntitled, seedTagVocabulary, type CreateUserInput, type CreateUserResult } from "./users";
