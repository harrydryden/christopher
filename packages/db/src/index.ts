/**
 * Everything an application needs at runtime. Migrations are deliberately NOT re-exported here:
 * they resolve the migrations folder relative to their own module, which bundlers treat as an
 * asset reference. Import them from "@ava/db/migrate" instead.
 */
export * from "./schema";
export * as schema from "./schema";
export { createDb, getDb, poolErrorCount, poolStats, slowQueryCount, type Db, type CreateDbOptions, type SlowQuery } from "./client";
export { enqueueTask, pendingTaskCounts, taskById, activeTaskFor, type EnqueueOptions } from "./tasks";

export { reevaluateGate, archiveNonMatches, isGateArchive, restoreGateArchive, GATE_RESTORE_EVENT, REEVALUATE_CLOSED_DAYS, type GateScope, type ArchiveScope, type ReevaluateOptions } from "./gate";
export { appendProfile, latestProfileFor } from "./profiles";
export { workloadMetrics } from "./scaling";
export { addHttpHostDaily, listHttpHostDaily, pruneHttpHostDaily, emptyHttpCounters, latencyBucketIndex, LATENCY_BUCKET_UPPER_MS, type HttpHostCounters, type HttpHostDailyDelta, type HttpHostDailyRow } from "./http-rollup";
export { recordWorkerEvent, listWorkerEvents, countWorkerEvents, pruneWorkerEvents, type WorkerEventInput } from "./worker-events";
export { accountAiSpend, totalAiSpend, aiUsageByAccount, recordAiCall, resetAiCallColumnsProbe, releaseAiHolds, releaseOrphanedCvHolds, aiOutcome, aiOutcomeSql, AI_OUTCOMES, costPerCvBuild, costPerScoredRole, type AiAccountUsage, type AiCallRecord, type AiOutcome, type CvBuildCost, type CvBuildCosts, type ReleasedHolds, type ScoredRoleCost } from "./ai-budget";

export { roleStatusSql, roleStageSql, latestApplicationFor, hasCvSql, type LatestApplication } from "./role-workflow";

export { scanRunSummary, scanRunSummaries, type ScanRunSummary } from "./scan-summary";

export { abandonCvDraft, actionCvs, completeCv, CvBuildInFlightError, lockCvDraft, lockCvLifecycle, nextCvRevision, noteCvBuildFailure } from "./cv-lifecycle";

export { startCvBuildStep, finishCvBuildStep, failOpenCvBuildSteps, listCvBuildSteps, cvBuildStepsSignature, cvBuildMotionStats, type StartCvBuildStep, type FinishCvBuildStep, type CvBuildMotionStat } from "./cv-build-steps";

export { cvRoleKey } from "./cv-role-key";

export { upsertLibraryReviews, latestLibraryReviews, libraryReviewsSignature, pruneLibraryReviews, type LibraryReviewUpsert } from "./library-reviews";

export { syncCompanyStatus, subscribeToCompany, setSubscriptionStatus, subscribedCompanyIds, retireSourceRoles, SOURCE_RETIRED_REASON } from "./subscriptions";
export { storeCompanyLogo, noteLogoFailure, readCompanyLogo, companiesDueLogoCapture, LOGO_REFRESH_AFTER_MS, type StoredLogo } from "./company-logos";
export { BOOTSTRAP_USER_ID, BOOTSTRAP_EMAIL, DEFAULT_ADMIN_EMAILS, SEED_TAGS, adminEmailsFrom, completeAccountClaim, createUser, isEntitledEmail, isPlaceholderEmail, listUserIds, normaliseEmail, promoteIfEntitled, seedTagVocabulary, type CreateUserInput, type CreateUserResult } from "./users";

export { createLibraryImport, getLibraryImport, getLibraryImportForWorker, listOpenLibraryImports, completeLibraryImport, resolveLibraryImport, pruneLibraryImports, type CreateLibraryImportInput, type LibraryImportOutcome, type LibraryImportRow, type LibraryImportSummary } from "./library-imports";
export { createCvShare, findLiveCvShareByHash, recordCvShareView, listCvShares, revokeCvShare, addCvShareComment, listCvShareComments, resolveCvShareComment, countOpenCvShareComments, CvShareClosedError, type AddCvShareCommentInput, type CreateCvShareInput, type CvShareRefusal, type LiveCvShare } from "./cv-shares";
