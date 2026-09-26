export {
  ASSESSMENT_COVERAGE_ERROR, mergeCvAssessBatches, SERVER_FALLBACK_BETA, STREAM_IDLE_MS, stallMessage, streamIdleMsFromEnv,
  AiEngine, a3OutputCeiling, createAiEngine, createProviderClient, classifyAiFailure, decisionDigest, extractJsonBlock, filterSuggestionKey, CANCELLED_ERROR, DEADLINE_ERROR_PREFIX,
  INTERRUPTED_ERROR_PREFIX, MAX_PAUSE_CONTINUATIONS, NO_OUTPUT_ERROR, OUTPUT_LIMIT_ERROR, PAUSED_ERROR, REFUSAL_ERROR_PREFIX, SCHEMA_ERROR_PREFIX, SDK_MAX_RETRIES, STREAM_CEILING_MS,
} from "./engine";
export type { CvAssessBatchResult, CvAssessInput, CvAssessOptions, CvAssessPass, CvAssessResult } from "./engine";
export { cvClaimMemoFrom, cvClaimMemoKey, cvClaimMemoKeys, cvRubricHash } from "./claim-memo";
export type { CvClaimMemo, CvClaimMemoRoute, CvClaimVerdict } from "./claim-memo";
export { UNVERIFIED_CLAIM_REASON } from "./cv-review-batch";
export type { AiCallMeta, AiEngineOptions, AiFailure, AiFailureKind, AiUsageRecord, AiClientLike, AiStreamLike, CvAssessBatchEvent, CvAssessHooks, DecisionForDigest, LibraryReviewBatchEvent, LibraryReviewHooks, ParseResponse, Ref, ReserveHint } from "./engine";
export {
  CV_PROMPT_IDS, CV_REVIEW_BATCH_SIZE, EFFORT_OUTPUT_SCALE, EFFORTS, PROMPTS, PROMPT_IDS, assertCacheLayout, cvCallSiteTable, expectedOutputTokens, isPromptId, layoutFor, promptEntry,
  promptSetVersion, promptVersion, resolveRoute, routedModel,
} from "./prompt-registry";
export type {
  CacheLayout, CacheTtl, Effort, LayoutParts, PromptEntry, PromptId, PromptPriority, PromptRoute, RouteModel, StageRouteOverride, StageRoutes,
} from "./prompt-registry";
/**
 * The provider's own error classes, re-exported from the one module that talks to it. The engine
 * classifies a failed call by these, so anything that needs to recognise one — or raise one, as a
 * scripted client in a test does — goes through here rather than reaching past the boundary.
 */
export {
  APIConnectionError, APIConnectionTimeoutError, APIError, AuthenticationError, BadRequestError,
  InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError,
} from "@anthropic-ai/sdk";
export { cvStageModel, estimateStage, type StageModels, type StageSizes } from "./pricing";
export { CACHE_WRITE_1H_MULTIPLIER, CACHE_WRITE_5M_MULTIPLIER, PRICING, SERVER_TOOL_USD, estimateCostUsd, estimateCvBuildUsd, estimateLibraryImportUsd, estimateLibraryReviewUsd, priceFor, serverToolCostUsd, type LibraryReviewSize, type TokenUsage } from "./pricing";
export { canonicalEvidence, canonicalEvidenceBlock, canonicalEvidenceItems, evidenceBlockId } from "./evidence";
export type { CanonicalEvidence, CanonicalEvidenceEntry, CanonicalEvidenceRow } from "./evidence";
export { AiGovernor, BASE_PAUSE_MS, DEFAULT_MAX_STREAMS, MAX_PAUSE_MS, aiGovernorStats, defaultGovernor, maxStreamsFromEnv, retryAfterMs } from "./governor";
export type { GovernorOptions, GovernorStats } from "./governor";
export { modelSupportsEffort, modelSupportsServerFallback } from "./model-capabilities";
export * as schemas from "./schemas";
export * as prompts from "./prompts";
export { RecordingClient, ReplayClient, ReplayMissError, readRecording, recordedRequest, recordingKey, requestInputHash } from "./record-client";
export type { RecordedCall, RecordingClientOptions, RecordingKey } from "./record-client";
