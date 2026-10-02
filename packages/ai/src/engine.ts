import { CvReviewPlanSchema, type CvRubric, type CvReviewPlan, type CvTextItem, type CvClaimItem } from "@ava/core/cv-assessment";
import { CvBuildStop } from "@ava/core/cv-build-failure";
import { mentionsDemographicAttribute, validateCvRubric } from "@ava/core/cv-review";
import { cvReviewBatches, libraryVerdictLines, mergeRetry, reviewBatchIssues, markUnverifiedFindings, retryScope, withFixedLibrarySide, type CvReviewBatch, type CvReviewBatchAnswer } from "./cv-review-batch";
import {
  CV_PAGE_LIMITS,
  LIBRARY_REVIEW_BATCH,
  employmentHeading,
  responsibilityRows,
  cvTailoringEvidence,
  cvTailoringPlanForWriter,
  validateCvTailoringPlan,
  libraryPlanCovers,
  reviewableRows,
  rowFacets,
  rowNumbers,
  validateLibraryReview,
  type CvWritingBudget,
  type CvPlan,
  type CvLibrary,
  type CvTailoringPlan,
  type LibraryEntryReview,
  type LibraryProposalPlan,
  type LibraryReviewPlan,
  type LibraryReviewPlanEntry,
  type LibraryRowReview,
} from "@ava/core";
import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { z } from "zod";
import { BATCH_PRICE_MULTIPLIER, estimateBatchCostUsd, estimateCostUsd, estimateStage, SERVER_TOOL_USD, serverToolCostUsd } from "./pricing";
import { modelSupportsEffort } from "./model-capabilities";
import * as P from "./prompts";
import type * as S from "./schemas";
import { CV_REVIEW_BATCH_SIZE, PROMPTS, layoutFor, outputFormat, resolveRoute, type Effort, type LayoutParts, type PromptEntry, type StageRoutes } from "./prompt-registry";
import { canonicalEvidence, evidenceBlockId } from "./evidence";
import { cvClaimMemoKeys, type CvClaimMemo, type CvClaimMemoRoute } from "./claim-memo";
import { AiGovernor, abortableSleep, defaultGovernor, retryAfterMs, type GovernorStats } from "./governor";
import { modelSupportsServerFallback } from "./model-capabilities";
import { scoreLocationEvidence } from "./score-location-evidence";
import { MODEL_ACCESS_BREAKER_MS, ModelAccessBreaker, defaultBreaker, isModelAccessFailure, type BreakerStats } from "./breaker";

export type { Effort } from "./prompt-registry";

/**
 * Why a call failed, named rather than described.
 *
 * The message a provider error carries is prose that changes without notice, so the class it was
 * thrown as is what the caller is told: a caller deciding whether to try again must not have to
 * read English to find out that a 429 is a 429. Every name here is also a `CvFailureKind` in core,
 * so a CV build can adopt the kind of the call that ended it without translating anything.
 */
export type AiFailureKind =
  | "rate_limited"
  | "overloaded"
  | "connection"
  | "model_access"
  | "stalled"
  | "refused"
  | "output_limit"
  | "output_invalid"
  | "unknown";

export interface AiFailure {
  kind: AiFailureKind;
  /** The HTTP status, when the provider gave one; a dropped connection has none. */
  status?: number;
  /**
   * For a stalled stream, what cut it off: `idle` when no event arrived for `afterMs`, `ceiling`
   * when the stream was still open after `afterMs` however much was arriving.
   */
  stall?: { reason: "idle" | "ceiling"; afterMs: number };
}

export interface AiUsageRecord {
  callSite: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The part of `cacheWriteTokens` written to an hour-long entry, which is billed at twice input. */
  cacheWrite1hTokens?: number;
  costUsd: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  /**
   * The failure named, when there was one. `error` stays the text — it is what `ai_calls` stores
   * and what Operations reads — and this is the same event classified, so a caller can act on it.
   * A call cancelled because a sibling failed carries none: it is not a failure of its own.
   */
  failure?: AiFailure;
  refType?: string;
  refId?: string;
  /** Which step of a multi-call feature this was; a single-call feature leaves it unset. */
  stage?: string;
  /** The account the call was made for; shared work such as extraction carries none. */
  userId?: string;
  /** The registry entry that produced the call, and the version of its prompt. */
  promptId?: string;
  promptVersion?: string;
  /** Milliseconds from sending the request that was answered to its first stream event. */
  ttftMs?: number;
  /** The longest silence between two stream events of that request. */
  maxEventGapMs?: number;
  /** The provider's `stop_reason`, for a call it answered. */
  stopReason?: string;
  /** The provider's id for the request, for a support ticket about one call. */
  requestId?: string;
  /** How many times the request was sent: more than one when the engine retried a throttle or a dropped connection. */
  attempt?: number;
  /** The caller's step this call belongs to, from `Ref.stepId`. */
  stepId?: string;
}

export interface Ref {
  refType?: string;
  refId?: string;
  /**
   * Which step of a multi-call feature this call is, so a CV build's cost can be explained rather
   * than only summed. The caller names its own steps; the engine appends `_retry` when it re-runs
   * a step itself.
   */
  stage?: string;
  userId?: string;
  /** The caller's own step (a CV build step's id), recorded so a step's calls can be listed with it. */
  stepId?: string;
  /** Overrides the entry's priority at the stream governor. */
  priority?: "interactive" | "background";
  /**
   * Stops this one call: the request, the SDK's retries, and the wait for either. A handler passes
   * its run's signal, so a task that outran its deadline or lost its lease stops paying for an
   * answer nobody will read. It is never recorded; the rest of the ref is.
   */
  signal?: AbortSignal;
  /**
   * Told why the call produced nothing, when it failed as a call (not recorded). A method returns
   * null for every failure, and some callers must act differently on some: scoring leaves a role
   * unscored and retries after a `model_access` failure instead of marking it scored.
   */
  onFailure?: (failure: AiFailure) => void;
}

/**
 * The slice of the Anthropic client this engine uses, so tests can inject a fake.
 *
 * Deliberately create, not parse. The SDK parse helper is create().then(parseMessage), and
 * parseMessage throws an AnthropicError carrying only a string when the response fails the
 * schema. That discards the usage figures for a call the model did answer and the account was
 * billed for, so the spend never reaches the monthly budget. Validating here instead keeps the
 * response, and its usage, in hand whatever the outcome.
 *
 * The stream parses too: at `message_stop` it runs the output format's `parse` over the answer
 * and rejects `finalMessage()` when that throws, which a truncated answer or a prose refusal
 * always does. So the format is sent without its parser on both paths (see `run`), and the answer
 * reaches the engine's own refusal, truncation and schema checks whatever it says.
 */
export interface AiClientLike {
  messages: {
    create(params: Record<string, unknown>, options?: Record<string, unknown>, call?: AiCallMeta): Promise<ParseResponse>;
    /**
     * The SDK's streaming helper. When present every call streams: the connection stays busy while
     * the answer is written, so the request timeout bounds only the wait for it to begin and a long
     * answer can no longer time out part-way through. A fake without it is called with create.
     */
    stream?(params: Record<string, unknown>, options?: Record<string, unknown>, call?: AiCallMeta): AiStreamLike;
    /** The Message Batches resource, for background scoring in batch mode. A fake without it cannot batch. */
    batches?: AiBatchesLike;
  };
  /**
   * The SDK's beta namespace, used for a call routed through the server-side refusal fallback
   * (`useServerFallback`). A client without it — a fake, say — is called without the fallback.
   */
  beta?: { messages: Omit<AiClientLike["messages"], "batches"> };
  /** The SDK's models resource, for proving at boot that this key can reach a model. Free: no tokens. */
  models?: { retrieve(modelId: string, params?: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
}

/** What asking the provider about one model found: reachable, or why not. */
export type ModelProbe = { ok: true } | { ok: false; message: string; status?: number; failure: AiFailure | null };

/**
 * The slice of the SDK's Message Batches resource the engine uses (`client.messages.batches`).
 * `create` takes a third argument the SDK ignores, as `messages.create` does: which registry entry
 * each request is, by `custom_id`, so a recording can file each result under its prompt.
 */
export interface AiBatchesLike {
  create(params: { requests: Array<{ custom_id: string; params: Record<string, unknown> }> }, options?: Record<string, unknown>, meta?: AiBatchMeta): Promise<AiBatchLike>;
  retrieve(batchId: string, params?: Record<string, unknown> | null, options?: Record<string, unknown>): Promise<AiBatchLike>;
  results(batchId: string, params?: Record<string, unknown>, options?: Record<string, unknown>): Promise<AsyncIterable<AiBatchResultLike>>;
}

/** Which registry entry each request of a batch is, by `custom_id`. Never sent to the provider. */
export interface AiBatchMeta {
  requests: Record<string, AiCallMeta>;
}

/** A Message Batch as the provider describes it. Results can be read once it has `ended`. */
export interface AiBatchLike {
  id: string;
  processing_status: "in_progress" | "canceling" | "ended";
  request_counts?: { processing?: number; succeeded?: number; errored?: number; canceled?: number; expired?: number };
  created_at?: string;
  ended_at?: string | null;
  expires_at?: string;
}

/** The body of an errored batch request, as the provider reports it. */
export interface BatchErrorBody {
  type?: string;
  message?: string;
  error?: { type?: string; message?: string };
}

/**
 * One request's result. Only `succeeded` carries a message, and is billed; an errored, canceled
 * or expired request created no message and is not billed.
 */
export interface AiBatchResultLike {
  custom_id: string;
  result:
    | { type: "succeeded"; message: ParseResponse }
    | { type: "errored"; error?: BatchErrorBody }
    | { type: "canceled" }
    | { type: "expired" };
}

/**
 * Which registry entry a request is, handed to the client beside the request and never sent to
 * the provider: the SDK takes two arguments and ignores a third. A scripted client dispatches on
 * `promptId` rather than on the wording of a prompt, so a prompt can be edited without breaking
 * every fake that recognised it by its first sentence.
 */
export interface AiCallMeta {
  promptId: string;
  promptVersion: string;
  stage?: string;
}

export interface AiStreamLike {
  on(event: "streamEvent", listener: () => void): unknown;
  finalMessage(): Promise<ParseResponse>;
  abort(): void;
  /** What had arrived when the stream was cut off, so the prompt it was billed for is still recorded. */
  readonly currentMessage?: ParseResponse;
  /** The provider's id for the request, once its response has begun. */
  readonly request_id?: string | null;
}

export interface ParseResponse {
  parsed_output?: unknown;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
    /** The cache writes split by lifetime: an hour-long entry is billed at twice input, a five-minute one at 1.25 times. */
    cache_creation?: { ephemeral_1h_input_tokens?: number | null; ephemeral_5m_input_tokens?: number | null } | null;
    /** Per-request charges for server-side tools, such as `web_search_requests`. */
    server_tool_use?: Record<string, unknown> };
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string } | null;
  model?: string;
}

export interface AiEngineOptions {
  /**
   * Hold capacity for one call, or refuse it. The returned function releases the hold, which the
   * engine calls once the call's real cost has been written through `onUsage`; an engine given a
   * `reserve` without an `onUsage` that records cost would never charge the budget at all. When
   * `onUsage` throws, the cost was not written, so the hold is not released: it goes on counting
   * the spend until it expires, rather than the spend vanishing from the budget.
   *
   * The call's `ref` comes with it, because budgets are per account as well as deployment-wide and
   * `ref.userId` names the account this call is for (shared work such as extraction has none).
   * Returning null refuses the call; throwing refuses it too, and is how a caller says which of
   * its budgets ran out.
   */
  reserve?: (callSite: string, estimateUsd: number, ref: Ref, hint?: ReserveHint) => Promise<(() => Promise<void>) | null>;
  apiKey?: string;
  /**
   * The model for a call site. May read through a settings cache that has gone cold: it is
   * awaited, so an administrator's choice is never replaced by a fallback for want of a warm cache.
   */
  getModel: (callSite: string) => string | Promise<string>;
  /**
   * The administrator's per-stage routes (the `stageRoutes` system setting), read for every call so
   * a change reaches the next call without a restart. A stage routed to a model runs on it whatever
   * the account's CV model or the call site's model is; a stage routed to an effort runs at it.
   */
  getStageRoutes?: () => StageRoutes | null | undefined | Promise<StageRoutes | null | undefined>;
  /** Record one finished call. Throw when the record did not land, so its hold is kept. */
  onUsage?: (record: AiUsageRecord) => void | Promise<void>;
  client?: AiClientLike;
  /**
   * The run this engine belongs to, for an engine built for one task.
   *
   * When it aborts — the task outran its deadline, or the worker lost its place — every call in
   * flight is cut off and nothing new is sent. Without it a killed CV build kept streaming
   * answers nobody would read, and kept spending the account's budget to do it.
   */
  signal?: AbortSignal;
  /**
   * Route calls through the server-side refusal fallback: a request the model declines on safety
   * grounds is re-run on the provider's recommended fallback model inside the same call, and billed
   * at the model that answered (`response.model`, which is what the record is priced at). On by
   * default, for the models that support it (`modelSupportsServerFallback`); `false` turns it off.
   */
  useServerFallback?: boolean;
  /**
   * The stream governor. Engines that build their own client share the process's
   * (`defaultGovernor`); an engine given a client shares one per client unless given this.
   */
  governor?: AiGovernor;
  /**
   * The model-access breaker. Engines that build their own client share the process's
   * (`defaultBreaker`); an engine given a client shares one per client unless given this.
   */
  breaker?: ModelAccessBreaker;
  /**
   * How many times the engine itself re-sends a request that failed before its response began
   * (a throttle, an overload, a dropped connection), waiting out the governor's shared pause.
   * Default: `SDK_MAX_RETRIES` for an engine that built its own client — whose SDK retries are then
   * off, so the waiting is shared rather than per call — and 0 for a given client, which keeps
   * whatever retrying that client does.
   */
  retries?: number;
  /** Cut off a stream that has sent no event for this long. Default `AI_STREAM_IDLE_MS`, else five minutes. */
  streamIdleMs?: number;
  logger?: (msg: string, data?: unknown) => void;
}

/** What a hold is told about the call it covers, so it can outlive it. */
export interface ReserveHint {
  /**
   * The longest this call may run: every SDK attempt's wait for a response to begin, the stream's
   * ceiling, and each continuation of a paused turn. A hold that expires sooner is swept while its
   * call is still spending.
   */
  maxDurationMs: number;
}

/** The SDK's own retries of a request that failed before its response began. */
export const SDK_MAX_RETRIES = 2;

/** What one call adds to its registry entry. */
interface CallInput {
  /** A plain user turn, or the stable blocks and volatile tail the entry's layout declares. */
  user: string | LayoutParts;
  /**
   * The model for this one call, when the caller has already chosen it. Used where the choice
   * belongs to the account rather than to the deployment — a library review runs on the same
   * `cvModel` the CV builder does — so the engine does not have to be rebuilt to say so.
   */
  model?: string;
  /** A route pinned with a score's fresh settings, immune to a stale engine settings cache. */
  pinnedRoute?: { model: string; effort: Effort };
  /** A ceiling sized to this call's input, below the entry's own (A3 sizes it to the page). */
  maxTokens?: number;
  /** Fires once the response has begun, which is when a prefix this call caches becomes readable by others. */
  onStart?: () => void;
  /**
   * Cancels the call; whatever it had consumed by then is recorded, labelled by what it was
   * aborted with: a sibling's failure (CANCELLED_ERROR), the task deadline, or anything else the
   * worker stopped it for.
   */
  signal?: AbortSignal;
  /**
   * This call's own usage record, after it has been recorded. `onUsage` sees every call the engine
   * makes, so a method running several at once cannot tell from it which record belongs to which;
   * this hands each call its own, which is how an assessment batch reports its cost as its own.
   */
  onRecord?: (record: AiUsageRecord) => void;
}

/** One request as `complete` sends it: the entry's timeout, the call's hooks, and which entry it is. */
interface Sending {
  timeoutMs: number;
  onStart?: () => void;
  signal?: AbortSignal;
  meta: AiCallMeta;
  /** Through the server-side refusal fallback: the beta namespace, with its header and parameter. */
  fallback: boolean;
  /** What the request that was last sent measured, filled in as it streams. */
  stats: StreamStats;
}

interface StreamStats {
  attempts: number;
  ttftMs?: number;
  maxEventGapMs?: number;
  requestId?: string;
}

/** An engine given a client shares one breaker with every engine given the same client. */
const clientBreakers = new WeakMap<object, ModelAccessBreaker>();
function breakerFor(client: AiClientLike): ModelAccessBreaker {
  let breaker = clientBreakers.get(client);
  if (!breaker) clientBreakers.set(client, breaker = new ModelAccessBreaker());
  return breaker;
}

/** The error a call refused by an open model-access breaker records, ahead of the provider's message. */
export const MODEL_ACCESS_BREAKER_ERROR_PREFIX = "Model unreachable with this key; not sent:";

/** An engine given a client shares one governor with every engine given the same client. */
const clientGovernors = new WeakMap<object, AiGovernor>();
function governorFor(client: AiClientLike): AiGovernor {
  let governor = clientGovernors.get(client);
  if (!governor) clientGovernors.set(client, governor = new AiGovernor());
  return governor;
}

/** A provider throttle: a rate limit or an overload, which every caller should back off from together. */
function isThrottle(error: unknown): error is APIError {
  return error instanceof RateLimitError || (error instanceof APIError && error.status === 529);
}

/**
 * Whether a request that failed before its response began may be sent again: a throttle, a server
 * error, a lock or request timeout, a dropped connection. The provider's `x-should-retry` decides
 * when it says.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true;
  if (!(error instanceof APIError)) return false;
  const header = (error.headers as Headers | undefined)?.get?.("x-should-retry");
  if (header === "true") return true;
  if (header === "false") return false;
  const status = error.status ?? 0;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export const OUTPUT_LIMIT_ERROR = "Model output limit reached before the response was complete.";
export const CANCELLED_ERROR = "Cancelled because another call in the same task failed.";
/**
 * A call stopped because its task ran out of time. Never CANCELLED_ERROR: no other call failed,
 * and a call site that keeps outrunning its task has to be visible as that.
 */
export const DEADLINE_ERROR_PREFIX = "Stopped at the task deadline:";
/** A call stopped for anything else the run was told: its lease went, its build was stopped. */
export const INTERRUPTED_ERROR_PREFIX = "Stopped by the worker:";
/** The label of an answer the model declined to give, followed by the refusal's category. */
export const REFUSAL_ERROR_PREFIX = "refusal:";
/** The label of an answer with no JSON in it at all. */
export const NO_OUTPUT_ERROR = "no parseable output";
/** The label of an answer the call site's schema rejected, followed by the offending fields. */
export const SCHEMA_ERROR_PREFIX = "schema rejected:";
/** No answer legitimately takes this long, so a stream still open at the ceiling has stalled. */
export const STREAM_CEILING_MS = 15 * 60_000;
/**
 * A stream that has sent nothing for this long has stalled, however long it has been open. Five
 * minutes, because adaptive thinking can stream nothing visible for a while before it writes.
 */
export const STREAM_IDLE_MS = 5 * 60_000;

/** `AI_STREAM_IDLE_MS` as a timeout, or the default when it is unset or not a positive number. */
export function streamIdleMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.AI_STREAM_IDLE_MS);
  return Number.isFinite(value) && value > 0 ? value : STREAM_IDLE_MS;
}

/** The most one call waits between its attempts, in all: the slack its hold allows for back-off. */
export const RETRY_WAIT_BUDGET_MS = 60_000;

/** The beta the server-side refusal fallback is requested under, in its `"default"` form. */
export const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01";
/**
 * How many times a turn a server tool paused (`stop_reason: "pause_turn"`, the server's own
 * iteration limit) is resumed before the call is given up as unfinished.
 */
export const MAX_PAUSE_CONTINUATIONS = 2;
/** The label of a server-tool turn still paused after every continuation it was allowed. */
export const PAUSED_ERROR = `Server tool turn still paused after ${MAX_PAUSE_CONTINUATIONS} continuations.`;

type ContentBlock = { type?: string; cache_control?: unknown } & Record<string, unknown>;

/**
 * A paused turn as it is sent back: its blocks unchanged, except that the last one a cache marker
 * may sit on carries one, so the continuation reads the searches already run from the cache (a
 * tenth of the input price) instead of paying for the whole transcript again. Only the newest
 * paused turn is marked: the markers an earlier continuation put on turns already in `messages`
 * are taken off, so a call never holds more cache breakpoints than the request allows.
 */
export function pausedTurnForResume(content: unknown[], messages: unknown): unknown[] {
  for (const message of (Array.isArray(messages) ? messages : []) as Array<{ role?: string; content?: unknown }>) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    message.content = (message.content as ContentBlock[]).map(block => {
      if (!block || typeof block !== "object" || !("cache_control" in block)) return block;
      const { cache_control: _dropped, ...rest } = block;
      return rest;
    });
  }
  const blocks = (content as ContentBlock[]).map(block => ({ ...block }));
  // Thinking blocks cannot carry a marker; the last block that can is the end of the prefix.
  for (let at = blocks.length - 1; at >= 0; at--) {
    const type = blocks[at]!.type;
    if (type === "thinking" || type === "redacted_thinking") continue;
    blocks[at] = { ...blocks[at]!, cache_control: { type: "ephemeral" } };
    break;
  }
  return blocks;
}

type Usage = NonNullable<ParseResponse["usage"]>;

/** Two requests' usage as one: every token count added, and every server-tool count by its name. */
function addUsage(a: Usage, b: Usage): Usage {
  const tools: Record<string, unknown> = { ...(a.server_tool_use ?? {}) };
  for (const [field, value] of Object.entries(b.server_tool_use ?? {}))
    tools[field] = typeof value === "number" ? (typeof tools[field] === "number" ? (tools[field] as number) : 0) + value : value;
  const hour = (a.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (b.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    ...(hour ? { cache_creation: { ephemeral_1h_input_tokens: hour } } : {}),
    ...(Object.keys(tools).length ? { server_tool_use: tools } : {}),
  };
}

/** What the request that was last sent measured, as the record carries it. */
function streamFigures(stats: StreamStats) {
  return {
    ...(stats.attempts ? { attempt: stats.attempts } : {}),
    ...(stats.ttftMs !== undefined ? { ttftMs: stats.ttftMs } : {}),
    ...(stats.maxEventGapMs !== undefined ? { maxEventGapMs: stats.maxEventGapMs } : {}),
    ...(stats.requestId ? { requestId: stats.requestId } : {}),
  };
}

/** A request's usage as the four token counts a record carries, with the hour-long writes named. */
function tokensOf(usage: Usage) {
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    ...(hour ? { cacheWrite1hTokens: hour } : {}),
  };
}

/**
 * Why a call was cut off by this process rather than by the provider: the stall ceiling, a sibling
 * batch failing, the task's deadline, or any other stop the run was told of.
 */
type CallCut = "stalled" | "cancelled" | "deadline" | "interrupted";

/**
 * A streamed call cut off before it completed, carrying whatever the stream had received.
 *
 * It also carries the error the stream threw. Wrapping used to keep the message alone, which threw
 * away the class the provider raised: a 429 and a dropped socket arrived at the caller as two
 * strings, and the only way left to tell them apart was to match English that the provider is free
 * to reword. `reason` keeps the original in hand so `classifyAiFailure` can ask what it is.
 */
class CallCutOff extends Error {
  constructor(
    message: string,
    readonly snapshot: ParseResponse | undefined,
    /** The error the stream rejected with, when the cut-off was not one we decided on ourselves. */
    readonly reason?: unknown,
    /** Set when this process cut the call off: the ceiling, or a signal. */
    readonly cut?: CallCut,
    /** Whether any of the response had arrived: a request cut off before it began was never billed and may be sent again. */
    readonly began = false,
    /** For a stall, what cut it off. */
    readonly stall?: AiFailure["stall"],
  ) {
    super(message);
  }
}

/**
 * The reason a batch controller aborts its siblings with when one of them failed. It is the only
 * abort recorded as CANCELLED_ERROR; an outer stop is passed on with its own reason.
 */
class SiblingFailed extends Error {
  constructor() {
    super(CANCELLED_ERROR);
    this.name = "SiblingFailed";
  }
}

/**
 * What a signal was aborted with, as a cut. The queue aborts a run with an error named
 * `TimeoutError` at its deadline (as `AbortSignal.timeout` does); anything else — a lost lease, a
 * build told to stop, a caller's bare `abort()` — is an interruption. This package cannot import
 * the worker's classes, so the name is the contract.
 */
function cutFor(reason: unknown): Exclude<CallCut, "stalled"> {
  if (reason instanceof SiblingFailed) return "cancelled";
  if (reason instanceof Error && reason.name === "TimeoutError") return "deadline";
  return "interrupted";
}

/** A duration as the sentence reads it: whole minutes when it is whole minutes, seconds otherwise. */
function span(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  const seconds = Math.round(ms / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/**
 * What a stall was, said as it happened. Both begin "Stream timed out:", which is what the ledger's
 * outcome taxonomy matches a stall by.
 */
export function stallMessage(stall: NonNullable<AiFailure["stall"]>): string {
  return stall.reason === "idle"
    ? `Stream timed out: no events for ${span(stall.afterMs)}.`
    : `Stream timed out: still open after ${span(stall.afterMs)}.`;
}

function cutMessage(cut: CallCut, reason: unknown, stall?: AiFailure["stall"]): string {
  if (cut === "stalled") return stallMessage(stall ?? { reason: "ceiling", afterMs: STREAM_CEILING_MS });
  if (cut === "cancelled") return CANCELLED_ERROR;
  const why = reason instanceof Error && reason.message ? reason.message
    : typeof reason === "string" && reason ? reason : "the run was stopped.";
  return `${cut === "deadline" ? DEADLINE_ERROR_PREFIX : INTERRUPTED_ERROR_PREFIX} ${why}`;
}

/** One signal for several, or none: a call stops when any of the runs it belongs to does. */
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => !!signal);
  return present.length <= 1 ? present[0] : AbortSignal.any(present);
}

/**
 * What a thrown call was, by the class it was thrown as.
 *
 * Returns null for a call this process stopped, which is not a failure of its own: a batch
 * cancelled because a sibling failed (the sibling is the failure, and reporting both would name
 * the wrong one), and a call stopped by its run's deadline or a lost lease (the task records that,
 * and the model never had the chance to fail). A fake client in a test throws plain errors, and an
 * SDK class we do not know yet is equally unnamed, so anything unrecognised is honestly `unknown`
 * rather than guessed at from its message.
 */
export function classifyAiFailure(error: unknown): AiFailure | null {
  if (error instanceof CallCutOff) {
    if (error.cut === "stalled") return { kind: "stalled", ...(error.stall ? { stall: error.stall } : {}) };
    if (error.cut) return null;
    return classifyAiFailure(error.reason);
  }
  // Order matters: the timeout is a subclass of the connection error, and every one of these is a
  // subclass of APIError, which is the catch-all for a status we have no specific name for.
  if (error instanceof RateLimitError) return { kind: "rate_limited", status: error.status };
  if (error instanceof InternalServerError) return { kind: "overloaded", status: error.status };
  if (error instanceof APIConnectionError) return { kind: "connection" };
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError ||
      error instanceof NotFoundError || error instanceof BadRequestError)
    return { kind: "model_access", status: error.status };
  if (error instanceof APIError) return { kind: "unknown", status: error.status };
  return { kind: "unknown" };
}

/**
 * One controller for a batched pass: aborted with the outer signal's own reason when any outer
 * signal aborts (so a deadline stays a deadline on every batch), and with `SiblingFailed` by the
 * pass itself when one batch fails.
 */
function batchController(outer: Array<AbortSignal | undefined>) {
  const own = new AbortController();
  return {
    signal: anySignal(...outer, own.signal)!,
    siblingFailed: () => own.abort(new SiblingFailed()),
  };
}
type BatchController = ReturnType<typeof batchController>;

/**
 * A batched pass. The shared cache entry is readable only once the first response has begun, so the
 * first batch goes alone until then (or until it settles) and the rest go together. A batch that is
 * not `ok`, or throws, cancels its siblings; if the first fails before its response began nothing
 * else is sent, and those indices are absent from the result. A throw is rethrown once all settle.
 */
async function runBatchedPass<R>(
  indices: number[],
  controller: BatchController,
  run: (index: number, onStart?: () => void) => Promise<R>,
  ok: (result: R) => boolean,
): Promise<Map<number, R>> {
  const results = new Map<number, R>();
  if (!indices.length) return results;
  const settle = (index: number, onStart?: () => void) => run(index, onStart).then(result => {
    results.set(index, result);
    if (!ok(result)) controller.siblingFailed();
  });
  let begun!: () => void;
  const firstBegun = new Promise<void>(resolve => { begun = resolve; });
  const [head, ...rest] = indices;
  const pending = [settle(head!, () => begun())];
  try {
    const firstSettled = await Promise.race([firstBegun.then(() => false), pending[0]!.then(() => true)]);
    if (firstSettled && !ok(results.get(head!)!)) return results;
    pending.push(...rest.map(index => settle(index)));
    await Promise.all(pending);
  } catch (err) {
    controller.siblingFailed();
    await Promise.allSettled(pending);
    throw err;
  }
  return results;
}

/**
 * One assessment batch reporting on itself, so a caller can narrate an audit that runs its batches
 * together instead of only saying it began and ended.
 *
 * `start` opens a batch. `retry` says the batch's first call is finished and paid for — its
 * `usage` is that call's — and that a second is going out to correct its attribution. `done` and
 * `failed` close it, carrying the usage of whichever call was the last one made.
 */
export interface CvAssessBatchEvent {
  /** Zero-based, in the order `cvReviewBatches` sliced them. */
  index: number;
  total: number;
  /**
   * `cancelled` closes a batch this engine stopped because a sibling failed, or because the run
   * was stopped: not a failure of its own.
   */
  phase: "start" | "done" | "retry" | "failed" | "cancelled";
  /** Which audit this is: of the written draft, or of the revised candidate. */
  pass: CvAssessPass;
  requirements: number;
  claims: number;
  /** How many attribution corrections the re-run was asked to make; absent when there was none. */
  corrections?: number;
  /** The call's own cost and tokens, once it has been recorded. */
  usage?: AiUsageRecord;
}

/**
 * Which audit of a build this is. The first audits the written draft; the second audits the
 * revised candidate, and is recorded under the stage `review_candidate` so the two audits' costs
 * and failures stay apart.
 */
export type CvAssessPass = "draft" | "revision";

export interface CvAssessHooks {
  /** Never throws into the audit: a hook that fails is logged and the batch carries on. */
  onBatch?: (event: CvAssessBatchEvent) => void | Promise<void>;
  /** Default `draft`. */
  pass?: CvAssessPass;
}

/** What an audit reads. */
export interface CvAssessInput {
  rubric: CvRubric;
  cv: CvTextItem[];
  claims: CvClaimItem[];
  /** The sources the answer is validated against: `cvEvidenceItems` of the grouped library. */
  evidence: CvTextItem[];
  /**
   * The grouped library itself. Given, the model reads the canonical evidence — the serialisation
   * the planner and the writer read — instead of `evidence`; citations are still validated
   * against `evidence`, with a row cited under its own id counted as its block's.
   */
  library?: CvLibrary;
  /**
   * The library-side verdict of each requirement, fixed by the build's evidence plan
   * (`cvLibraryVerdicts`). Given, each batch is handed its requirements' verdicts as settled
   * context, is not asked for its own, and has these written onto its matches whatever it returns.
   * Absent (a build with no plan), the audit judges the library side itself.
   */
  libraryVerdicts?: ReadonlyMap<string, Pick<CvReviewPlan["matches"][number], "libraryStatus" | "libraryEvidence">>;
}

export interface CvAssessOptions extends CvAssessHooks {
  /**
   * Run only these batches, by index, for a caller re-running the batches a checkpointed audit
   * lost. The batches are sliced from the input exactly as a full audit slices them, so an index
   * names the same requirements and claims as long as the input is the same.
   */
  only?: readonly number[];
  /**
   * The claim verdicts of an earlier audit of the same build (`cvClaimMemoFrom`), for the re-audit
   * of a revision (`pass: "revision"` only, and never with `only`). A claim whose memo key is
   * filed is not sent: its verdict is merged back into the review under the claim's id. Every
   * requirement is still assessed, and the batches are sliced from the claims that are sent.
   */
  claimMemo?: CvClaimMemo;
}

/** One batch of an audit, as it ended. */
export interface CvAssessBatchResult {
  index: number;
  /**
   * `done` carries its result. `failed` is the batch's own failure, named. `cancelled` is a batch
   * stopped because a sibling failed — no error of its own — or because the run was stopped, whose
   * `error` then says so; one never sent because the first batch failed first is cancelled too.
   */
  status: "done" | "failed" | "cancelled";
  result?: CvReviewPlan;
  error?: string;
  failure?: AiFailure;
  /** Every call the batch made — its first and any correction — each as recorded. */
  usage: AiUsageRecord[];
}

export interface CvAssessResult {
  pass: CvAssessPass;
  /** How many batches the whole audit has, whichever of them this run ran. */
  total: number;
  /** The batches this run ran, by index. */
  batches: CvAssessBatchResult[];
  /** The whole audit, when this run ran every batch and every one is done; otherwise null. */
  review: CvReviewPlan | null;
  /** How many claims were answered from `claimMemo` rather than sent; the engine always says, a stand-in may not. */
  reusedClaims?: number;
}

/** The error a batch fails with when its answer did not cover its requirements and claims once each. */
export const ASSESSMENT_COVERAGE_ERROR = "The assessment did not cover every requested requirement and claim exactly once. The fitted CV is saved; retry its assessment.";

/**
 * The finished batches of one audit as its review, or null when they do not make a valid one.
 * Given the audit's claims and the verdicts it reused, the claims are put back in the order of
 * the CV, each reused verdict in its claim's place.
 */
export function mergeCvAssessBatches(results: readonly CvReviewPlan[], reused?: { claims: readonly CvClaimItem[]; verdicts: ReadonlyMap<string, CvReviewPlan["claims"][number]> }): CvReviewPlan | null {
  const fresh = results.flatMap(result => result.claims);
  const byId = new Map(fresh.map(claim => [claim.claimId, claim]));
  const claims = reused?.verdicts.size
    ? reused.claims.map(claim => reused.verdicts.get(claim.id) ?? byId.get(claim.id)).filter((claim): claim is CvReviewPlan["claims"][number] => !!claim)
    : fresh;
  if (reused?.verdicts.size && claims.length !== reused.claims.length) return null;
  const review = { matches: results.flatMap(result => result.matches), claims };
  const parsed = CvReviewPlanSchema.safeParse(review);
  return parsed.success ? parsed.data : null;
}

/**
 * One batch of an evidence review reporting on itself, so a caller can say which part of a pass
 * cost what. `retry` says the batch's first answer left entries uncovered and a second call is
 * going out to ask for them; `done` and `failed` carry the usage of whichever call was last.
 */
export interface LibraryReviewBatchEvent {
  /** Zero-based, in the order the entries were given. */
  index: number;
  total: number;
  phase: "start" | "done" | "retry" | "failed";
  /** Entries in this batch. */
  entries: number;
  /** Entries the first answer left out, which is what the re-run was asked for; absent when none. */
  uncovered?: number;
  /** The call's own cost and tokens, once it has been recorded. */
  usage?: AiUsageRecord;
}

export interface LibraryReviewHooks {
  /** Never throws into the pass: a hook that fails is logged and the batch carries on. */
  onBatch?: (event: LibraryReviewBatchEvent) => void | Promise<void>;
  /** Stops the pass: every call in flight is cut off and nothing new is sent. */
  signal?: AbortSignal;
}

export class AiEngine {
  readonly enabled: boolean;
  private readonly client: AiClientLike | null;

  private readonly governor: AiGovernor;
  private readonly breaker: ModelAccessBreaker;
  private readonly retries: number;
  private readonly idleMs: number;

  constructor(private readonly options: AiEngineOptions) {
    if (options.client) {
      this.client = options.client;
    } else if (options.apiKey) {
      // The engine retries instead of the SDK, and only before a response begins (rate limits,
      // overload, connection errors), so a retried call is never billed twice and a streamed answer
      // is never re-requested part-way; its waiting goes through the governor's shared pause.
      this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0 }) as unknown as AiClientLike;
    } else {
      this.client = null;
    }
    this.enabled = this.client !== null;
    this.retries = Math.max(0, Math.floor(options.retries ?? (options.client ? 0 : SDK_MAX_RETRIES)));
    this.governor = options.governor ?? (options.client ? governorFor(options.client) : defaultGovernor());
    this.breaker = options.breaker ?? (options.client ? breakerFor(options.client) : defaultBreaker());
    this.idleMs = options.streamIdleMs ?? streamIdleMsFromEnv();
  }

  /** The stream cap this engine runs under and what is open under it, for Health. */
  governorStats(): GovernorStats {
    return this.governor.stats();
  }

  /** The models this engine is refusing after a model-access failure, and its last trip, for Health. */
  breakerStats(): BreakerStats {
    return this.breaker.stats();
  }

  /**
   * Ask the provider whether this key can use `model`, without a message and so without a token.
   * Null when there is no client, or the client cannot ask (a fake). It reports and nothing more:
   * the breaker opens only on a real call's failure.
   */
  async probeModel(model: string, signal?: AbortSignal): Promise<ModelProbe | null> {
    if (!this.client?.models?.retrieve) return null;
    try {
      await this.client.models.retrieve(model, {}, { timeout: 15_000, ...(signal ? { signal } : {}) });
      return { ok: true };
    } catch (err) {
      const status = err instanceof APIError ? err.status : undefined;
      const message = (err as Error).message ?? String(err);
      return { ok: false, message: message.slice(0, 500), ...(status !== undefined ? { status } : {}), failure: classifyAiFailure(err) };
    }
  }

  /**
   * This engine for one run: every call it makes also stops when `signal` aborts. The client, and
   * its connection pool, is shared rather than built again from the key, and so are the budget
   * and the ledger, so a run's engine spends and records exactly as the shared one does.
   */
  withSignal(signal: AbortSignal): AiEngine {
    return new AiEngine({ ...this.options, client: this.client ?? undefined, governor: this.governor, breaker: this.breaker, retries: this.retries,
      streamIdleMs: this.idleMs, signal: anySignal(this.options.signal, signal) });
  }

  private log(msg: string, data?: unknown) {
    this.options.logger?.(msg, data);
  }

  /** Tell a caller's progress hook, which may fail without failing the pass it reports on. */
  private async notify<E>(hook: ((event: E) => void | Promise<void>) | undefined, event: E, failed: string) {
    try {
      await hook?.(event);
    } catch (err) {
      this.log(failed, err);
    }
  }

  /** The stage routes, or none when they cannot be read: a settings fault must not stop the call. */
  private async stageRoutes(): Promise<StageRoutes | null | undefined> {
    try {
      return await this.options.getStageRoutes?.();
    } catch (err) {
      this.log("stage routes unreadable; using each entry's own route", err);
      return undefined;
    }
  }

  /** Hand one call's record to `onUsage`. False when it threw: the cost did not reach the ledger. */
  private async record(record: AiUsageRecord): Promise<boolean> {
    try {
      await this.options.onUsage?.(record);
      return true;
    } catch (err) {
      this.log("usage callback failed", err);
      return false;
    }
  }

  /**
   * One request. A streaming client keeps the connection busy while the answer is written, so the
   * request timeout bounds only the wait for it to begin; the ceiling cuts off a stalled stream.
   */
  private async complete(request: Record<string, unknown>, params: Sending): Promise<ParseResponse> {
    // All the waiting one call does between its attempts stays within the minute its hold allows
    // for back-off (`ReserveHint`): a pause that would run past it ends the call instead.
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      params.stats.attempts = attempt;
      try {
        const response = await this.send(request, params);
        this.governor.noteSuccess();
        return response;
      } catch (err) {
        const reason = err instanceof CallCutOff ? err.reason : err;
        // Only a request that never began may go again: nothing of it was billed, and nothing of
        // it can be lost by asking once more. One this process cut off is never retried here.
        const fresh = !(err instanceof CallCutOff) || (!err.cut && !err.began);
        if (reason instanceof APIError && reason.requestID) params.stats.requestId = reason.requestID;
        // Every engine in the process backs off from a throttle together, not one call at a time.
        const asked = fresh && isThrottle(reason) ? retryAfterMs(reason.headers) : undefined;
        if (fresh && isThrottle(reason)) this.governor.noteThrottled(asked);
        if (!fresh || attempt > this.retries || !isRetryable(reason) || params.signal?.aborted) throw err;
        // A server error or a dropped connection: the SDK's own back-off, half a second doubling, jittered.
        const backOff = isThrottle(reason) ? 0 : Math.min(8_000, 500 * 2 ** (attempt - 1)) * (1 - Math.random() * 0.25);
        // A provider asking for longer than the budget is not waited out on a shortened pause: the
        // call ends as rate limited, and its task goes back on the queue.
        if (waited + Math.max(backOff, this.governor.pauseLeftMs(), asked ?? 0) > RETRY_WAIT_BUDGET_MS) throw err;
        const began = Date.now();
        try {
          if (isThrottle(reason)) await this.governor.waitForPause(params.signal);
          else await abortableSleep(backOff, params.signal);
          waited += Date.now() - began;
        } catch {
          const cut = cutFor(params.signal?.reason);
          throw new CallCutOff(cutMessage(cut, params.signal?.reason), undefined, reason, cut);
        }
      }
    }
  }

  /**
   * One request. A streaming client keeps the connection busy while the answer is written, so the
   * request timeout bounds only the wait for it to begin. Two clocks cut off a stream that has
   * stalled: the idle timeout, reset by every event, and the ceiling, from the moment it opened.
   */
  private async send(request: Record<string, unknown>, params: Sending): Promise<ParseResponse> {
    const { messages } = params.fallback && this.client!.beta ? this.client!.beta : this.client!;
    const signal = params.signal;
    // The signal goes to the SDK, which stops the request and sends no retry once it sees it.
    const options = { timeout: params.timeoutMs, ...(signal ? { signal } : {}) };
    // The SDK notices an abort only between attempts, after sleeping out the back-off it is in,
    // and a provider's retry-after can ask for a minute. The caller stops waiting at once instead.
    let stopWaiting: (() => void) | undefined;
    const aborted = signal ? new Promise<never>((_, reject) => {
      stopWaiting = () => reject(signal.reason);
      if (signal.aborted) stopWaiting();
      else signal.addEventListener("abort", stopWaiting, { once: true });
    }) : undefined;
    aborted?.catch(() => {});
    const settled = <R>(work: Promise<R>): Promise<R> => aborted ? Promise.race([work, aborted]) : work;
    let stream: AiStreamLike | undefined;
    let stall: AiFailure["stall"];
    let started = false;
    let clock: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!messages.stream) {
        const response = await settled(messages.create(request, options, params.meta));
        params.onStart?.();
        const id = (response as { _request_id?: string | null })._request_id;
        if (id) params.stats.requestId = id;
        return response;
      }
      const open = messages.stream(request, options, params.meta);
      stream = open;
      const opened = Date.now();
      let last = opened;
      open.on("streamEvent", () => {
        const now = Date.now();
        if (!started) {
          started = true;
          params.stats.ttftMs = now - opened;
          params.onStart?.();
        } else {
          params.stats.maxEventGapMs = Math.max(params.stats.maxEventGapMs ?? 0, now - last);
        }
        last = now;
      });
      // One timer, re-armed for whichever clock runs out first, rather than one per event.
      const check = () => {
        const now = Date.now();
        if (now - opened >= STREAM_CEILING_MS) stall = { reason: "ceiling", afterMs: STREAM_CEILING_MS };
        else if (now - last >= this.idleMs) stall = { reason: "idle", afterMs: this.idleMs };
        if (stall) return open.abort();
        clock = setTimeout(check, Math.max(1, Math.min(this.idleMs - (now - last), STREAM_CEILING_MS - (now - opened))));
      };
      clock = setTimeout(check, Math.min(this.idleMs, STREAM_CEILING_MS));
      const response = await settled(open.finalMessage());
      const id = open.request_id ?? (response as { _request_id?: string | null })._request_id;
      if (id) params.stats.requestId = id;
      return response;
    } catch (err) {
      const cut: CallCut | undefined = stall ? "stalled" : signal?.aborted ? cutFor(signal.reason) : undefined;
      // A create call that failed on its own is thrown as it came, so its class still names it.
      if (!stream && !cut) throw err;
      if (stream?.request_id) params.stats.requestId = stream.request_id;
      throw new CallCutOff(cut ? cutMessage(cut, signal?.reason, stall) : (err as Error).message, stream?.currentMessage, err, cut, started, stall);
    } finally {
      clearTimeout(clock);
      if (stopWaiting) signal!.removeEventListener("abort", stopWaiting);
    }
  }

  /**
   * The route and model an entry runs at: a route naming a model is the administrator's choice for
   * the stage, otherwise the account's (handed in by the caller) or the call site's. The claim memo
   * resolves through here as well, so its keys cannot drift from the route a call actually takes.
   */
  private async routeFor(entry: PromptEntry, callModel?: string) {
    const route = resolveRoute(entry, await this.stageRoutes());
    const model = route.model !== "cvModel" && route.model !== "callSite" ? route.model
      : callModel ?? await this.options.getModel(entry.callSite);
    return { route, model };
  }

  /**
   * The request one call of `entry` sends, as the provider reads it: the model its route names,
   * the entry's layout of the prompt, the output format without its parser, and the effort. The
   * live path adds the refusal fallback; a batched request goes without it, as the Batches API
   * refuses that parameter.
   */
  private async buildRequest(entry: PromptEntry, call: Pick<CallInput, "user" | "model" | "maxTokens" | "pinnedRoute">, recorded: Omit<Ref, "signal" | "priority">) {
    const callSite = entry.callSite;
    const { route, model } = call.pinnedRoute
      ? { route: { model: call.pinnedRoute.model, effort: call.pinnedRoute.effort }, model: call.pinnedRoute.model }
      : await this.routeFor(entry, call.model);
    const { system, content } = layoutFor(entry, typeof call.user === "string" ? { tail: call.user } : call.user);
    const texts = [...system.map(block => block.text), ...(typeof content === "string" ? [content] : content.map(block => block.text))];
    const maxTokens = call.maxTokens ?? entry.maxTokens;
    // The format goes without its parser. Given one, the SDK parses inside the stream and rejects
    // the whole answer when the text is not valid JSON — which a truncated answer and a prose
    // refusal always are — so it arrived here as an unnamed error instead of as a refusal, an
    // output limit or a schema failure. Validation is `validate` below, on both paths.
    const format = outputFormat(entry.schema);
    const request: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system,
      // The cache is a prefix match, so a cached block sits before everything that varies.
      messages: [{ role: "user", content }],
      output_config: { format, ...(modelSupportsEffort(model) ? { effort: route.effort } : {}) },
    };
    const tools = entry.tools?.map(tool => ({ ...tool }));
    if (tools) request.tools = tools;
    // The caller names the step when it knows better (a re-run, a revision); otherwise the entry does.
    const stage = recorded.stage ?? entry.stage;
    const identity = { ...recorded, ...(stage ? { stage } : {}), promptId: entry.id, promptVersion: entry.version };
    const meta: AiCallMeta = { promptId: entry.id, promptVersion: entry.version, ...(stage ? { stage } : {}) };
    return { callSite, model, request, texts, maxTokens, tools, identity, meta, system, content };
  }

  /**
   * What an answer amounts to: the validated result, or why there is none. A refusal, an answer
   * cut off at its ceiling, a server-tool turn still paused and an answer the schema rejects are
   * each the model's answer failing, never the transport, and each is named so the caller can
   * decide differently about it. Shared by the live path and batch results.
   */
  private judge<T>(entry: PromptEntry, response: ParseResponse) {
    const refused = response.stop_reason === "refusal";
    const truncated = response.stop_reason === "max_tokens";
    const paused = response.stop_reason === "pause_turn";
    const parsed = refused || truncated || paused ? null : (response.parsed_output ?? extractJsonBlock(textOf(response)));
    const outcome = refused
      ? { error: `${REFUSAL_ERROR_PREFIX}${response.stop_details?.category ?? "unknown"}` }
      : truncated
        ? { error: OUTPUT_LIMIT_ERROR }
      : paused
        ? { error: PAUSED_ERROR }
      : parsed === null || parsed === undefined
        ? { error: NO_OUTPUT_ERROR }
        : validate<T>(entry.schema, parsed);
    const validated = "data" in outcome ? outcome.data : null;
    const failure: AiFailure | undefined = validated !== null ? undefined
      : refused ? { kind: "refused" }
      : truncated ? { kind: "output_limit" }
      : { kind: "output_invalid" };
    return { validated, error: "error" in outcome ? outcome.error : undefined, failure, refused };
  }

  private async run<T>(entry: PromptEntry, call: CallInput, ref: Ref = {}): Promise<T | null> {
    // The signal stops the call, and is not part of what is recorded about it.
    const { signal: callerSignal, priority, onFailure, ...recorded } = ref;
    // A call's own signal when it has one (an assessment batch's, which already listens to the
    // run's and the caller's), otherwise the caller's and the run's together.
    const signal = call.signal ?? anySignal(callerSignal, this.options.signal);
    if (!this.client || signal?.aborted) return null;
    const started = Date.now();
    const { callSite, model, request, texts, maxTokens, tools, identity, meta } = await this.buildRequest(entry, call, recorded);
    // A model this key could not reach a moment ago is refused here, before the governor and the
    // budget: the call would fail the same way, instantly, and hold both for nothing. The row it
    // leaves costs nothing and names the failure, so a caller can tell it from a model that answered badly.
    const open = this.breaker.refuse(model);
    if (open) {
      const failure: AiFailure = { kind: "model_access", ...(open.status !== undefined ? { status: open.status } : {}) };
      const record: AiUsageRecord = {
        callSite, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 0,
        ok: false, error: `${MODEL_ACCESS_BREAKER_ERROR_PREFIX} ${open.message}`.slice(0, 500), failure, ...identity,
      };
      await this.record(record);
      call.onRecord?.(record);
      onFailure?.(failure);
      return null;
    }
    // A refusal is re-run server-side on the provider's recommended fallback, inside this call.
    const fallback = this.options.useServerFallback !== false && modelSupportsServerFallback(model) && !!this.client.beta?.messages;
    if (fallback) {
      request.betas = [SERVER_FALLBACK_BETA];
      request.fallbacks = "default";
    }

    // One stream per call at the governor, held until the call has been recorded. A call stopped
    // while it waited for one was never sent, and has nothing to record.
    const releaseSlot = await this.governor.acquire(model, priority ?? entry.priority, signal).catch(() => null);
    if (!releaseSlot) return null;
    const stats: StreamStats = { attempts: 0 };

    // Estimated only for an engine that holds capacity per call. The CV engine holds one
    // reservation for the whole build instead, so measuring every prompt for it was work thrown
    // away — and a second, unused figure beside the one the build was actually admitted at.
    let settle: (() => Promise<void>) | null | undefined;
    let landed = true;
    if (this.options.reserve) {
      // A generous reading of the prompt: English runs about four bytes per token, so a third of
      // the byte count leaves roughly 30% of headroom. Output is reserved at the cap it may reach.
      const promptBytes = Buffer.byteLength(texts.join(""));
      // A call with a server tool may be resumed after a pause, each time sending its growing turn
      // again and searching again, so it holds for every request it may make and every search each
      // may run, rather than a flat dollar that three long rounds could pass.
      const requests = tools?.length ? 1 + MAX_PAUSE_CONTINUATIONS : 1;
      const searches = (tools ?? []).reduce((sum, tool) => sum + (typeof tool.max_uses === "number" ? tool.max_uses : 10), 0);
      const estimate = requests * estimateCostUsd(model, { inputTokens: promptBytes / 3,
        outputTokens: maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 })
        + requests * searches * (SERVER_TOOL_USD.web_search_requests ?? 0);
      // Held for as long as the call can possibly run, with a minute's slack for the SDK's back-off.
      // A minute's slack covers the waiting between attempts, which `complete` keeps within it.
      const maxDurationMs = requests * ((SDK_MAX_RETRIES + 1) * entry.timeoutMs + STREAM_CEILING_MS + RETRY_WAIT_BUDGET_MS);
      try {
        settle = await this.options.reserve(callSite, estimate, recorded, { maxDurationMs });
      } catch (err) {
        releaseSlot();
        throw err;
      }
      if (settle === null) {
        releaseSlot();
        throw new Error("AI budget reserved or exhausted; retry later");
      }
    }
    // The one ledger row this call leaves, whether it answered or failed.
    const usageRecord = (served: string, usage: Usage, outcome: Pick<AiUsageRecord, "ok" | "error" | "failure" | "stopReason">): AiUsageRecord => {
      const tokens = tokensOf(usage);
      const { ok, error, failure, stopReason } = outcome;
      return {
        callSite,
        model: served,
        ...tokens,
        // A web search is billed per request as well as by the tokens its results add to the turn.
        costUsd: estimateCostUsd(served, tokens) + serverToolCostUsd(usage.server_tool_use),
        durationMs: Date.now() - started,
        ok,
        error,
        ...(failure ? { failure } : {}),
        ...streamFigures(stats),
        ...(stopReason ? { stopReason } : {}),
        ...identity,
      };
    };
    // What the requests before the last one used: a paused turn is resumed as a new request, and
    // every one of them is billed, so the one record this call leaves carries them all.
    let prior: Usage = {};
    try {
      let record: AiUsageRecord;
      let result: T | null = null;
      let note: [string, unknown] | undefined;
      try {
        const sending: Sending = { timeoutMs: entry.timeoutMs, meta, fallback, stats, ...(call.onStart ? { onStart: call.onStart } : {}), ...(signal ? { signal } : {}) };
        let response = await this.complete(request, sending);
        // A server tool that reached its iteration limit pauses the turn; sending the turn back, as
        // it stands, lets it carry on from there. No extra user turn: the assistant's is resumed.
        for (let resumed = 0; response.stop_reason === "pause_turn" && resumed < MAX_PAUSE_CONTINUATIONS && !signal?.aborted; resumed++) {
          prior = addUsage(prior, response.usage ?? {});
          request.messages = [...(request.messages as unknown[]), { role: "assistant", content: pausedTurnForResume(response.content ?? [], request.messages) }];
          response = await this.complete(request, sending);
        }
        const { validated, error, failure, refused } = this.judge<T>(entry, response);
        record = usageRecord(response.model ?? model, addUsage(prior, response.usage ?? {}),
          { ok: validated !== null, error, failure, stopReason: response.stop_reason ?? undefined });
        result = validated;
        if (refused) note = [`${callSite} refused`, response.stop_details];
      } catch (err) {
        // A call that failed before it began spent nothing. One cut off part-way was billed for the
        // prompt it had processed, which is in the snapshot the cut-off carries. It is priced at the
        // model that served it when the snapshot names one, as the success path is: a server-side
        // fallback bills at the model that answered, not the one that was asked.
        const snapshot = err instanceof CallCutOff ? err.snapshot : undefined;
        record = usageRecord(snapshot?.model ?? model, addUsage(prior, snapshot?.usage ?? {}),
          { ok: false, error: (err as Error).message.slice(0, 500), failure: classifyAiFailure(err) ?? undefined });
        note = [`${callSite} failed`, err];
        const cause = err instanceof CallCutOff ? err.reason : err;
        if (record.failure?.kind === "model_access" && cause instanceof APIError && isModelAccessFailure(cause.status, cause.message)
          && this.breaker.trip(model, cause.message, cause.status))
          this.log(`model access breaker open for ${model} for ${MODEL_ACCESS_BREAKER_MS / 60_000} minutes`, { status: cause.status, message: cause.message });
      }
      landed = await this.record(record);
      call.onRecord?.(record);
      if (record.failure) onFailure?.(record.failure);
      if (note) this.log(...note);
      return result;
    } finally {
      releaseSlot();
      // A call whose cost never reached the ledger keeps its hold until the hold expires.
      if (landed) await settle?.();
    }
  }

  async analyseCvJob(
    description: string,
    ref: Ref = {},
  ): Promise<CvRubric | null> {
    let failedOutput = false;
    let outputError: string | undefined;
    const first = await this.run<CvRubric>(PROMPTS["cv.rubric"], { user: JSON.stringify({ description }),
      onRecord: record => { if (record.failure?.kind === "output_invalid") outputError = record.error; },
    }, {
      ...ref, onFailure: failure => { if (failure.kind === "output_invalid") failedOutput = true; ref.onFailure?.(failure); },
    });
    let feedback: string | undefined;
    if (first) {
      try { return validateCvRubric(description, first); }
      catch (error) { feedback = (error as Error).message; }
    } else if (failedOutput) {
      feedback = outputError ?? "The previous answer was missing or did not fit the required rubric JSON schema.";
    }
    if (!feedback) return null;
    const repaired = await this.run<CvRubric>(PROMPTS["cv.rubric"], {
      user: JSON.stringify({ description, repair: { validationError: feedback,
        instruction: "Return a complete new rubric in the required JSON schema. Quote only exact contiguous text from the description and use distinct requirements.",
        ...(first ? { previousAnswer: first } : {}) } }),
    }, { ...ref, stage: `${ref.stage ?? "rubric"}_retry` });
    if (!repaired) return null;
    try { return validateCvRubric(description, repaired); }
    catch (error) { throw new CvBuildStop("output_invalid", (error as Error).message, { motion: "rubric" }); }
  }

  /** One bounded pre-writing call. The returned index is validated against exact trusted rows. */
  async planCvTailoring(
    input: { rubric: CvRubric; library: CvLibrary },
    ref: Ref = {},
  ): Promise<CvTailoringPlan | null> {
    const evidence = cvTailoringEvidence(input.library);
    // The planner reads the canonical evidence, the same serialisation the writer and the auditor
    // read; the flat rows remain what its answer is validated against, and carry the same ids.
    const destinations = {
      employment: (input.library.employment ?? []).map(job => ({ employmentId: job.id, label: employmentHeading(job) })),
      evidence: input.library.entries.map(entry => ({ entryId: entry.id, label: entry.heading, kind: entry.kind })),
    };
    const payload = { rubric: input.rubric, evidence: canonicalEvidence(input.library), destinations };
    let failedOutput = false;
    let outputError: string | undefined;
    const result = await this.run<CvTailoringPlan>(PROMPTS["cv.planning"], {
      user: JSON.stringify(payload),
      onRecord: record => { if (record.failure?.kind === "output_invalid") outputError = record.error; },
    }, { ...ref, onFailure: failure => { if (failure.kind === "output_invalid") failedOutput = true; ref.onFailure?.(failure); } });
    let feedback: string | undefined;
    try {
      if (result) return validateCvTailoringPlan(result, input.rubric, evidence, input.library);
      if (!failedOutput) return null;
      feedback = outputError ?? "The previous answer was missing or did not fit the required evidence-plan JSON schema.";
    } catch (error) {
      feedback = (error as Error).message;
    }
    const repaired = await this.run<CvTailoringPlan>(PROMPTS["cv.planning"], {
      user: JSON.stringify({ ...payload, repair: { validationError: feedback,
        instruction: "Return a complete corrected plan. Cite only row or skill IDs shown in evidence and exact quotes from those rows. Preserve every fixed requirement exactly once; never add unsupported matches.",
        ...(result ? { previousAnswer: result } : {}) } }),
    }, { ...ref, stage: `${ref.stage ?? "planning"}_retry` });
    if (!repaired) return null;
    try {
      return validateCvTailoringPlan(repaired, input.rubric, evidence, input.library);
    } catch (error) {
      throw new CvBuildStop("output_invalid", `The evidence plan could not be verified: ${(error as Error).message}`);
    }
  }

  /**
   * The audit of a CV, returning the whole review or null. A batch that fails discards the audit
   * here; `assessCvBatches` keeps the batches that finished, for a caller that checkpoints them.
   */
  async assessCv(
    input: CvAssessInput,
    ref: Ref = {},
    hooks: CvAssessHooks = {},
  ): Promise<CvReviewPlan | null> {
    const audit = await this.assessCvBatches(input, ref, hooks);
    if (audit.review) return audit.review;
    if (audit.batches.some(batch => batch.error === ASSESSMENT_COVERAGE_ERROR)) throw new Error(ASSESSMENT_COVERAGE_ERROR);
    return null;
  }

  /**
   * The audit of a CV, batch by batch.
   *
   * A full CV audit can exceed what one call may produce, so it is split into batches that each
   * see the complete CV and evidence. The batches are independent: they run together, and they
   * share that context through the cache rather than each paying for it again. A batch that fails
   * stops the batches still in flight — the audit cannot be completed by this run, so paying for
   * the rest would buy nothing now — but every batch that had already finished is returned with
   * its result, so a caller that checkpoints them re-runs only what was lost (`only`).
   */
  async assessCvBatches(
    input: CvAssessInput,
    ref: Ref = {},
    options: CvAssessOptions = {},
  ): Promise<CvAssessResult> {
    const pass: CvAssessPass = options.pass ?? "draft";
    const entry = pass === "revision" ? PROMPTS["cv.review_candidate"] : PROMPTS["cv.review"];
    if (options.claimMemo && (pass !== "revision" || options.only))
      throw new Error("A claim memo is for the re-audit of a revision, which runs every batch.");
    // The claims whose verdicts the memo already holds, under this audit's own prompt and route.
    const reused = new Map<string, CvReviewPlan["claims"][number]>();
    if (options.claimMemo) {
      const keys = cvClaimMemoKeys(input, await this.claimMemoRoute(pass));
      for (const claim of input.claims) {
        const verdict = options.claimMemo[keys.get(claim.id)!];
        if (verdict) reused.set(claim.id, { claimId: claim.id, ...structuredClone(verdict) });
      }
    }
    const assessed: CvAssessInput = reused.size ? { ...input, claims: input.claims.filter(claim => !reused.has(claim.id)) } : input;
    // The re-audit of a revised candidate is its own stage, so its cost never merges with the first audit's.
    const stage = pass === "revision" ? "review_candidate" : ref.stage ?? "review";
    const { requirements: _requirements, ...rubricContext } = input.rubric;
    // The shared context is two cached blocks in the order it changes, least often first: the
    // evidence and rubric outlive a revision, so the re-audit of an edited CV reads them from
    // cache and writes only the CV; within one audit the batches after the first read both. The
    // cache is a prefix match, so nothing that varies may come before either.
    const stable = JSON.stringify({ evidence: input.library ? canonicalEvidence(input.library) : input.evidence, rubric: rubricContext });
    const entryIds = input.library ? new Set(input.library.entries.map(item => item.id)) : undefined;
    const printed = JSON.stringify({ cv: input.cv });
    const batches = cvReviewBatches(assessed, CV_REVIEW_BATCH_SIZE);
    const indices = options.only ? [...new Set(options.only)].filter(index => index >= 0 && index < batches.length).sort((a, b) => a - b)
      : batches.map((_, index) => index);
    // One controller for the audit: a batch that fails cancels its siblings, and so does the run's
    // own signal, so a build whose task has been given up on stops paying for the rest of its audit.
    const controller = batchController([this.options.signal, ref.signal]);
    const verdicts = input.libraryVerdicts;
    // The fixed library verdicts ride beside the batch's requirements; a build without a plan sends the batch as it was.
    const tailOf = (batch: CvReviewBatch) => verdicts
      ? { requirements: batch.requirements, libraryVerdicts: libraryVerdictLines(batch.requirements, verdicts), claims: batch.claims, claimSources: batch.claimSources }
      : batch;
    /** An answer with its library side fixed by the plan, when there is one, before anything reads it. */
    const settled = (answer: CvReviewBatchAnswer | null): CvReviewBatchAnswer | null =>
      answer && verdicts ? withFixedLibrarySide(answer, verdicts) : answer;
    const runBatch = (batch: CvReviewBatch, corrections?: string[], onStart?: () => void, onRecord?: (record: AiUsageRecord) => void) => this.run<CvReviewBatchAnswer>(entry, {
      user: { stable: [stable, printed], tail: JSON.stringify({ ...tailOf(batch), ...(corrections ? { corrections } : {}) }) },
      signal: controller.signal,
      onStart,
      onRecord,
      // The corrections re-run is a second charge for one batch, and the difference between an
      // audit that cost twice over and one that simply had many batches. Name it separately.
    }, { ...ref, stage: corrections ? `${stage}_retry` : stage });
    const assess = async (index: number, onStart?: () => void): Promise<CvAssessBatchResult> => {
      const batch = batches[index]!;
      const context = { cv: input.cv, claims: batch.claims, evidence: input.evidence };
      const usage: AiUsageRecord[] = [];
      const onRecord = (record: AiUsageRecord) => { usage.push(record); };
      // The batches run together, so a watcher that only saw the audit begin and end could not say
      // which of five was slow or which paid twice. Each says so for itself, carrying the usage of
      // its own call rather than leaving the caller to guess from the engine-wide record.
      const say = (phase: CvAssessBatchEvent["phase"], extra: Partial<CvAssessBatchEvent> = {}) => this.notify(options.onBatch, {
        index, total: batches.length, phase, pass,
        requirements: batch.requirements.length, claims: batch.claims.length, usage: usage.at(-1), ...extra,
      }, "assessment batch hook failed");
      // A batch that produced nothing: stopped by this engine, or failed on its own.
      const ended = async (corrections?: number): Promise<CvAssessBatchResult> => {
        const last = usage.at(-1);
        const stopped = !last || last.error === CANCELLED_ERROR || last.error?.startsWith(DEADLINE_ERROR_PREFIX) || last.error?.startsWith(INTERRUPTED_ERROR_PREFIX);
        const extra = corrections ? { corrections } : {};
        if (stopped) {
          await say("cancelled", extra);
          return { index, status: "cancelled", usage, ...(last?.error && last.error !== CANCELLED_ERROR ? { error: last.error } : {}) };
        }
        await say("failed", extra);
        return { index, status: "failed", usage, ...(last!.error ? { error: last!.error } : {}), ...(last!.failure ? { failure: last!.failure } : {}) };
      };
      await say("start");
      const first = settled(sourcedByBlock(await runBatch(batch, undefined, onStart, onRecord), entryIds));
      if (!first) return ended();
      const issues = reviewBatchIssues(first, context);
      const corrections = issues.map(issue => issue.correction);
      // With no issues every match carries its library side: fixed by the plan, or returned and checked.
      let result = markUnverifiedFindings(first, []);
      if (corrections.length) {
        // The first call is finished and paid for; what follows is a second charge for this batch,
        // so it asks again only about what was wrong: the flagged requirements and claims, and any
        // the first answer left out, with the same corrections and the same cached context.
        const flagged = retryScope(first, issues, batch);
        await say("retry", { corrections: corrections.length });
        const second = settled(sourcedByBlock(await runBatch(flagged, corrections, undefined, onRecord), entryIds));
        if (!second) return ended(corrections.length);
        // The second answer replaces the first only for what it was asked about, by id. What is
        // still wrong earns no credit and remains visible for review; the final strict source
        // validator still checks all accepted evidence quotes.
        const merged = mergeRetry(first, second, flagged);
        result = markUnverifiedFindings(merged, reviewBatchIssues(merged, context));
      }
      const extra = corrections.length ? { corrections: corrections.length } : {};
      const complete = (expected: string[], actual: string[]) =>
        expected.length === actual.length && new Set(actual).size === actual.length &&
        expected.every(id => actual.includes(id));
      if (!complete(batch.requirements.map(item => item.id), result.matches.map(item => item.requirementId)) ||
          !complete(batch.claims.map(item => item.id), result.claims.map(item => item.claimId))) {
        await say("failed", extra);
        return { index, status: "failed", usage, error: ASSESSMENT_COVERAGE_ERROR, failure: { kind: "output_invalid" } };
      }
      await say("done", extra);
      return { index, status: "done", result, usage };
    };
    const outcomes = await runBatchedPass(indices, controller, assess, batch => batch.status === "done");
    // A batch never sent, because the first ended before its response began, is cancelled.
    const ran = indices.map(index => outcomes.get(index) ?? { index, status: "cancelled" as const, usage: [] });
    const whole = !options.only || indices.length === batches.length;
    const review = whole && ran.every(batch => batch.status === "done")
      ? mergeCvAssessBatches(ran.map(batch => batch.result!), { claims: input.claims, verdicts: reused }) : null;
    return { pass, total: batches.length, batches: ran, review, reusedClaims: reused.size };
  }

  /**
   * The prompt version, model and effort an audit pass runs at, which its claim verdicts' memo keys
   * name (`cvClaimMemoKeys`). Resolved as the pass's calls resolve them: the administrator's route
   * for the entry, else the call site's model, which a CV build's engine answers with its CV model.
   */
  async claimMemoRoute(pass: CvAssessPass): Promise<CvClaimMemoRoute> {
    const entry = pass === "revision" ? PROMPTS["cv.review_candidate"] : PROMPTS["cv.review"];
    const { route, model } = await this.routeFor(entry);
    return { promptVersion: entry.version, model, effort: route.effort };
  }

  async buildCv(
    input: {
      library: CvLibrary;
      jobTitle: string;
      company: string;
      description: string;
      writingBudget?: CvWritingBudget;
      maxPages?: number;
      rubric?: CvRubric;
      tailoringPlan?: CvTailoringPlan;
      improvements?: string[];
      layoutFeedback?: {
        pageCount: number;
        maxPages: number;
        previousPlan: CvPlan;
        corrections?: string[];
      };
    },
    ref: Ref = {},
  ): Promise<CvPlan | null> {
    // Appearance is an application concern, never an instruction for the model.
    const {
      theme: _theme,
      name: _name,
      contact: _contact,
      email: _email,
      phone: _phone,
      location: _location,
      linkedinUrl: _linkedin,
      websiteUrl: _website,
      ...evidenceLibrary
    } = input.library;
    // The optional improvement is the same prompt asked a second time with the audit's findings;
    // it is its own entry so its cost and its prompt version are recorded as its own.
    const entry = ref.stage === "improvement" || input.improvements?.length ? PROMPTS["cv.improvement"] : PROMPTS["cv.author"];
    // Three parts in the order they change, least often first. The library — the canonical
    // evidence, every row once and citable by its id, with the person's writing preferences — is
    // the same for every build from this library. The role is the same for every call of one
    // build: the fitter's rewrites and the improvement. Both are cached for an hour, because a
    // rewrite or the improvement comes more than five minutes after the call before it. Only the
    // allocation, the layout feedback and the improvements vary, and they come last.
    const { stylePreferences, preferredWording } = evidenceLibrary;
    const library = JSON.stringify({ library: { ...canonicalEvidence(input.library),
      ...(stylePreferences ? { stylePreferences } : {}), ...(preferredWording ? { preferredWording } : {}) } });
    const role = JSON.stringify({ jobTitle: input.jobTitle, company: input.company, description: input.description,
      maxPages: input.maxPages ?? CV_PAGE_LIMITS.default,
      ...(input.rubric ? { rubric: input.rubric } : {}), ...(input.tailoringPlan ? { tailoringPlan: cvTailoringPlanForWriter(input.tailoringPlan) } : {}) });
    const volatile = {
      ...(input.writingBudget ? { writingBudget: input.writingBudget } : {}),
      ...(input.improvements?.length ? { improvements: input.improvements } : {}),
      ...(input.layoutFeedback ? { layoutFeedback: input.layoutFeedback } : {}),
    };
    const plan = await this.run<CvPlan>(entry, {
      user: { stable: [library, role], ...(Object.keys(volatile).length ? { tail: JSON.stringify(volatile) } : {}) },
    }, ref);
    // Provenance is checked by the caller, not here: the fitter corrects an answer citing a source
    // the Library does not hold inside the build, which it cannot do with an error thrown from the call.
    return plan;
  }

  // A1 ---------------------------------------------------------------------
  async chooseCareersLinks(
    input: { companyName: string; homepageUrl: string; links: Array<{ href: string; text: string; context?: string }> },
    ref: Ref = {},
  ): Promise<Array<{ url: string; confidence: number; reason: string }> | null> {
    const links = input.links.slice(0, 300);
    const known = new Set(links.map((l) => l.href));
    const listing = links.map((l, i) => `[${i}] ${l.text || "(no text)"} | ${l.href}${l.context ? ` | ${l.context}` : ""}`).join("\n");
    const result = await this.run<S.CareersLinksOutput>(PROMPTS.A1, {
      user: `Company: ${input.companyName}\nHomepage: ${input.homepageUrl}\n\n${P.wrap("page_content", P.truncate(listing, 40_000))}`,
    }, ref);
    if (!result) return null;
    return result.candidates
      .filter((c) => known.has(c.url))
      .map((c) => ({ url: c.url, confidence: clamp01(c.confidence), reason: c.reason.slice(0, 200) }))
      .slice(0, 5);
  }

  // A2 ---------------------------------------------------------------------
  async classifyPage(
    input: { url: string; text: string; links: Array<{ href: string; text: string }> },
    ref: Ref = {},
  ): Promise<{ kind: "listing" | "landing" | "other"; nextHopUrl?: string; confidence: number } | null> {
    const links = input.links.slice(0, 120);
    const known = new Set(links.map((l) => l.href));
    const body = `${P.wrap("page_content", P.truncate(input.text, 24_000))}\n\nLinks on the page:\n${P.wrap("page_links", links.map((l) => `${l.text || "(no text)"} | ${l.href}`).join("\n"))}`;
    const result = await this.run<S.PageClassificationOutput>(PROMPTS.A2, { user: `URL: ${input.url}\n\n${body}` }, ref);
    if (!result) return null;
    const nextHopUrl = result.nextHopUrl && known.has(result.nextHopUrl) ? result.nextHopUrl : undefined;
    return { kind: result.kind, nextHopUrl, confidence: clamp01(result.confidence) };
  }

  // A3 ---------------------------------------------------------------------
  async extractPostings(
    input: { pageUrl: string; compactDom: string; knownUrls: string[] },
    ref: Ref = {},
  ): Promise<{
    postings: Array<{ title: string; url: string; location?: string; department?: string }>;
    recipe: { version: 1; listItem: string; title: string; link: string; location?: string; department?: string } | null;
    confidence: number;
    dropped: number;
  } | null> {
    const result = await this.run<S.ExtractPostingsOutput>(PROMPTS.A3, {
      user: `Page URL: ${input.pageUrl}\n\n${P.wrap("page_content", P.truncate(input.compactDom, 80_000))}`,
      // Sized to the page: a flat 8,000 cut off every board past about 150 postings, and the
      // hold is taken at this ceiling, so a small page now holds less than it did.
      maxTokens: a3OutputCeiling((input.compactDom.match(/^\[\d+\] /gm) ?? []).length),
    }, ref);
    if (!result) return null;
    const allowed = new Map(input.knownUrls.map((u) => [canonical(u), u]));
    const postings: Array<{ title: string; url: string; location?: string; department?: string }> = [];
    let dropped = 0;
    for (const p of result.postings) {
      const real = allowed.get(canonical(p.url));
      if (!real) {
        dropped++;
        continue;
      }
      postings.push({
        title: p.title.trim(),
        url: real,
        location: p.location?.trim() || undefined,
        department: p.department?.trim() || undefined,
      });
    }
    const recipe = result.recipe
      ? {
          version: 1 as const,
          listItem: result.recipe.listItem,
          title: result.recipe.title,
          link: result.recipe.link,
          location: result.recipe.location ?? undefined,
          department: result.recipe.department ?? undefined,
        }
      : null;
    return { postings, recipe, confidence: clamp01(result.confidence), dropped };
  }

  // A4 ---------------------------------------------------------------------
  async cleanDescription(
    input: { title: string; rawText: string },
    ref: Ref = {},
  ): Promise<{ startsWith: string; endsWith: string; salaryText?: string; employmentType?: string; remote?: boolean } | null> {
    const result = await this.run<S.DescriptionOutput>(PROMPTS.A4, {
      user: `Role: ${input.title}\n\n${P.wrap("page_content", P.truncate(input.rawText, 40_000))}`,
    }, ref);
    if (!result) return null;
    // Anchors, not text: the caller slices the page between them (and keeps nothing it cannot find).
    return {
      startsWith: result.startsWith.trim(),
      endsWith: result.endsWith.trim(),
      salaryText: result.salaryText?.trim() || undefined,
      employmentType: result.employmentType?.trim() || undefined,
      remote: result.remote ?? undefined,
    };
  }

  // A5 ---------------------------------------------------------------------
  async scoreJob(input: ScoreJobInput, ref: Ref = {}): Promise<ScoreJobResult | null> {
    const result = await this.run<S.FitScoreOutput>(PROMPTS.A5, { user: scoreJobUser(input), pinnedRoute: input.route }, ref);
    return result ? finishScore(result) : null;
  }

  /*
   * Background scoring through the Message Batches API.
   *
   * The same A5 request the live call sends — same model, prompt, layout, schema and effort — goes
   * into a batch instead of a stream, at half the token price. Only the transport differs: a batch
   * cannot carry the refusal-fallback parameter, and it is not streamed. Submitting a batch is one
   * request and takes one stream at the governor; retrieving one and reading its results are
   * cheap reads and go outside it. Each result is judged and priced here, so a batched score is
   * validated, clamped and recorded exactly as a live one is, at the batch price.
   */

  /** Whether this engine's client can send Message Batches. A fake without `batches` cannot. */
  get supportsBatches(): boolean {
    return !!this.client?.messages.batches;
  }

  /**
   * One role's A5 request for a batch, and what to hold for it: the request priced at the batch
   * price by the entry's cache layout — the account's context written to the cache at 1.25 times
   * input, since a hit inside a batch is best-effort — with the output at its ceiling, as the live
   * hold is.
   */
  async scoreJobBatchRequest(input: ScoreJobInput): Promise<BatchScoreRequest> {
    const entry = PROMPTS.A5;
    const user = scoreJobUser(input);
    const { model, request, meta, maxTokens } = await this.buildRequest(entry, { user, pinnedRoute: input.route }, {});
    const estimate = estimateStage(entry, {
      stableBytes: user.stable.map(block => Buffer.byteLength(block)),
      tailBytes: Buffer.byteLength(user.tail),
      outputTokens: maxTokens,
    }, { callSiteModel: model, ...(input.route ? { routes: { A5: input.route } } : {}) });
    return { params: request, meta, model, estimateUsd: Number((estimate * BATCH_PRICE_MULTIPLIER).toFixed(6)) };
  }

  /** The Message Batches resource, and the request options every call to it is made with. */
  private batchApi(verb: "send" | "read", signal?: AbortSignal) {
    const batches = this.client?.messages.batches;
    if (!batches) throw new Error(`This model client cannot ${verb} Message Batches.`);
    const stop = anySignal(signal, this.options.signal);
    return { batches, signal: stop, options: { timeout: BATCH_REQUEST_TIMEOUT_MS, ...(stop ? { signal: stop } : {}) } };
  }

  /**
   * Send one batch. The submission is one request, so it takes one stream at the governor for as
   * long as it is being sent, at background priority; a throttle it meets pauses every engine in
   * the process, as a live call's does. `meta` names each request's registry entry, beside the
   * request and never to the provider, so a recording can file each result under its prompt.
   */
  async submitBatch(requests: ReadonlyArray<{ customId: string; params: Record<string, unknown>; meta: AiCallMeta }>, opts: { signal?: AbortSignal } = {}): Promise<AiBatchLike> {
    const { batches, signal, options } = this.batchApi("send", opts.signal);
    if (!requests.length) throw new Error("A batch needs at least one request.");
    const model = String(requests[0]!.params.model);
    const release = await this.governor.acquire(model, "background", signal);
    try {
      const batch = await batches.create(
        { requests: requests.map(item => ({ custom_id: item.customId, params: item.params })) },
        options,
        { requests: Object.fromEntries(requests.map(item => [item.customId, item.meta])) },
      );
      this.governor.noteSuccess();
      return batch;
    } catch (err) {
      if (isThrottle(err)) this.governor.noteThrottled(retryAfterMs(err.headers));
      throw err;
    } finally {
      release();
    }
  }

  /** A batch's status. A cheap read, outside the governor. */
  async retrieveBatch(batchId: string, opts: { signal?: AbortSignal } = {}): Promise<AiBatchLike> {
    const { batches, options } = this.batchApi("read", opts.signal);
    return batches.retrieve(batchId, undefined, options);
  }

  /** An ended batch's results, streamed one at a time and in any order: key them by `custom_id`. */
  async *batchResults(batchId: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<AiBatchResultLike> {
    const { batches, options } = this.batchApi("read", opts.signal);
    for await (const result of await batches.results(batchId, undefined, options))
      yield result;
  }

  /**
   * One succeeded batch result read as a score, and the ledger row it leaves: judged, clamped and
   * named exactly as a live answer is — a refusal, a truncated answer and a schema failure are
   * each a failed call that was billed — and priced at the batch price. The record names the
   * prompt and version the request was sent with, and the batch as its request id.
   */
  readBatchScore(message: ParseResponse, item: BatchResultContext): { score: ScoreJobResult | null; record: AiUsageRecord } {
    const usage = message.usage ?? {};
    const tokens = tokensOf(usage);
    const { validated, error, failure } = this.judge<S.FitScoreOutput>(PROMPTS.A5, message);
    const served = message.model ?? item.model;
    const record: AiUsageRecord = {
      callSite: PROMPTS.A5.callSite,
      model: served,
      ...tokens,
      costUsd: Number((estimateBatchCostUsd(served, tokens) + serverToolCostUsd(usage.server_tool_use)).toFixed(6)),
      durationMs: Math.max(0, (item.now ?? new Date()).getTime() - item.submittedAt.getTime()),
      ok: validated !== null,
      error,
      ...(failure ? { failure } : {}),
      ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
      requestId: item.batchId,
      attempt: 1,
      ...batchIdentity(item),
    };
    return { score: validated ? finishScore(validated) : null, record };
  }

  /**
   * The ledger row of a batch request that errored. The provider bills none — a message was never
   * created — so it records nothing spent, as a live call that never reached the model does, and
   * names what went wrong so the call log stays diagnosable.
   */
  batchErrorRecord(error: BatchErrorBody | undefined, item: BatchResultContext): AiUsageRecord {
    const inner = error?.error ?? error;
    const type = inner?.type ?? "unknown_error";
    return {
      callSite: PROMPTS.A5.callSite,
      model: item.model,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0,
      durationMs: Math.max(0, (item.now ?? new Date()).getTime() - item.submittedAt.getTime()),
      ok: false,
      error: `${BATCH_ERROR_PREFIX} ${type}${inner?.message ? `: ${inner.message}` : ""}`.slice(0, 500),
      failure: { kind: type === "rate_limit_error" ? "rate_limited" : type === "overloaded_error" || type === "api_error" ? "overloaded" : "unknown" },
      requestId: item.batchId,
      attempt: 1,
      ...batchIdentity(item),
    };
  }

  // A6 ---------------------------------------------------------------------
  async tagReason(
    input: { reason: string; decision: "apply" | "skip"; job: { title: string; company: string; location?: string; department?: string }; vocabulary: string[] },
    ref: Ref = {},
  ): Promise<{ tags: string[]; proposedNewTags: Array<{ tag: string; description: string }> } | null> {
    const result = await this.run<S.ReasonTagsOutput>(
      PROMPTS.A6,
      {
        user: [
          `Decision: ${input.decision}`,
          `Role: ${input.job.title} at ${input.job.company}${input.job.location ? ` (${input.job.location})` : ""}`,
          input.job.department ? `Department: ${input.job.department}` : "",
          `\nVocabulary:\n${input.vocabulary.join("\n")}`,
          `\n${P.wrap("reason", input.reason.slice(0, 2000))}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      ref,
    );
    if (!result) return null;
    const vocabulary = new Set(input.vocabulary.map((t) => t.toLowerCase()));
    const tags: string[] = [];
    const proposed: Array<{ tag: string; description: string }> = [...(result.proposedNewTags ?? [])];
    for (const raw of result.tags) {
      const tag = raw.trim().toLowerCase();
      if (vocabulary.has(tag)) tags.push(tag);
      else if (/^[a-z_]+:[a-z0-9_]+$/.test(tag)) proposed.push({ tag, description: "" });
    }
    const seen = new Set<string>();
    return {
      tags: tags.filter((t) => !seen.has(t) && seen.add(t)),
      proposedNewTags: proposed
        .map((p) => ({ tag: p.tag.trim().toLowerCase(), description: (p.description ?? "").slice(0, 200) }))
        .filter((p) => /^[a-z_]+:[a-z0-9_]+$/.test(p.tag) && !vocabulary.has(p.tag))
        .slice(0, 4),
    };
  }

  // A7 ---------------------------------------------------------------------
  async synthesizeProfile(
    input: {
      seedProfile: string;
      pinnedStatements: string[];
      currentProfile?: string;
      decisions: DecisionForDigest[];
      disagreements?: Array<{ title: string; company: string; decision: string; fitScore: number; reason: string }>;
      rejectedCompanySuggestions?: Array<{ name: string; reason: string }>;
      /**
       * Where this account's applications actually ended up. Distinct from a decision on purpose:
       * a shortlist is what someone hoped for, an acceptance is what they chose, and a rejection
       * is evidence about fit rather than about their preferences.
       */
      outcomes?: Array<{ title: string; company: string; status: string; appliedOn: string | null }>;
    },
    ref: Ref = {},
  ): Promise<{ markdown: string; openQuestions: Array<{ id: string; question: string }> } | null> {
    const digest = decisionDigest(input.decisions, { maxItems: 400, maxChars: 40_000 });
    const user = [
      P.wrap("seed_profile", input.seedProfile || "(none written yet)"),
      P.wrap("pinned_statements", input.pinnedStatements.length ? input.pinnedStatements.map((s) => `- ${s}`).join("\n") : "(none)"),
      input.currentProfile ? P.wrap("current_profile", P.truncate(input.currentProfile, 8000)) : "",
      P.wrap("decisions", digest),
      input.outcomes?.length
        ? "Outcomes the person reached, which weigh more than a decision: an accepted offer is what they want, a rejection is a signal about fit.\n" +
          P.wrap("outcomes", input.outcomes.slice(0, 50)
            .map(outcome => `- [${outcome.status}] ${outcome.title} @ ${outcome.company}${outcome.appliedOn ? ` (applied ${outcome.appliedOn})` : ""}`).join("\n"))
        : "",
      input.disagreements?.length
        ? P.wrap(
            "score_disagreements",
            input.disagreements.map((d) => `- scored ${d.fitScore} but they chose ${d.decision}: ${d.title} at ${d.company} — ${d.reason}`).join("\n"),
          )
        : "",
      input.rejectedCompanySuggestions?.length
        ? P.wrap("rejected_companies", input.rejectedCompanySuggestions.map((r) => `- ${r.name}: ${r.reason}`).join("\n"))
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await this.run<S.ProfileOutput>(PROMPTS.A7, { user }, ref);
    if (!result) return null;
    let markdown = result.markdown.trim();
    const missing = input.pinnedStatements.filter((s) => s.trim() && !markdown.includes(s.trim()));
    if (missing.length > 0) {
      markdown += `\n\n## Pinned\n${missing.map((s) => `- ${s} [pinned]`).join("\n")}`;
    }
    return { markdown, openQuestions: (result.openQuestions ?? []).slice(0, 3) };
  }

  // A8 ---------------------------------------------------------------------
  async suggestFilters(
    input: {
      includeKeywords: string[];
      excludeKeywords: string[];
      locationTerms: string[];
      decisions: DecisionForDigest[];
      previouslyRejected: Array<{ type: string; value: unknown }>;
      /** The companies this account follows and has not paused: the only ones a pause may name. */
      companies?: Array<{ id: string; name: string }>;
    },
    ref: Ref = {},
  ): Promise<S.FilterSuggestionsOutput["suggestions"] | null> {
    const companies = (input.companies ?? []).slice(0, 300);
    const user = [
      `Current include keywords: ${input.includeKeywords.join(", ") || "(none)"}`,
      `Current exclude keywords: ${input.excludeKeywords.join(", ") || "(none)"}`,
      `Current location terms: ${input.locationTerms.join(", ") || "(none)"}`,
      P.wrap("followed_companies", companies.map(company => `- ${company.id}: ${company.name}`).join("\n") || "(none)"),
      P.wrap("decisions", decisionDigest(input.decisions, { maxItems: 200, maxChars: 20_000 })),
      `Previously rejected suggestions: ${JSON.stringify(input.previouslyRejected).slice(0, 4000)}`,
    ].join("\n\n");
    const result = await this.run<S.FilterSuggestionsOutput>(PROMPTS.A8, { user }, ref);
    if (!result) return null;
    const existing = new Set(
      [...input.includeKeywords, ...input.excludeKeywords, ...input.locationTerms].map((t) => t.trim().toLowerCase()),
    );
    // Compared by what a suggestion names, not by its whole value: a rejected term filed by the
    // scans carries a `source` beside it, and a model's own casing is not a different term.
    const rejected = new Set(input.previouslyRejected.map((r) => filterSuggestionKey(r.type, r.value)));
    const followed = new Map(companies.map(company => [company.id, company]));
    const out: S.FilterSuggestionsOutput["suggestions"] = [];
    for (const s of result.suggestions) {
      let value: Record<string, unknown>;
      if (s.type === "pause_company") {
        // Only a company this account follows, named by its id from the list it was given.
        const company = followed.get(typeof s.value.companyId === "string" ? s.value.companyId.trim() : "");
        if (!company) continue;
        value = { companyId: company.id, companyName: company.name };
      } else {
        const term = typeof s.value.term === "string" ? s.value.term.trim() : "";
        if (!term || term.length > 80 || existing.has(term.toLowerCase())) continue;
        value = { term };
      }
      const key = filterSuggestionKey(s.type, value);
      if (rejected.has(key) || out.some(kept => filterSuggestionKey(kept.type, kept.value) === key)) continue;
      out.push({ ...s, value });
    }
    return out;
  }

  // A9 ---------------------------------------------------------------------
  async profileCompany(
    input: { name: string; domain: string; homepageText: string; aboutText?: string },
    ref: Ref = {},
  ): Promise<S.CompanyProfileOutput | null> {
    const body = [input.homepageText, input.aboutText].filter(Boolean).join("\n\n---\n\n");
    const result = await this.run<S.CompanyProfileOutput>(PROMPTS.A9, {
      user: `Company: ${input.name}\nDomain: ${input.domain}\n\n${P.wrap("page_content", P.truncate(body, 24_000))}`,
    }, ref);
    if (!result) return null;
    return {
      ...result,
      geographies: [...new Set(result.geographies ?? [])].slice(0, 12),
      tags: [...new Set((result.tags ?? []).map((t) => t.toLowerCase()))].slice(0, 12),
    };
  }

  async extractSourceCompanies(input: { content: string; portfolio: string[]; preferences: string }, ref: Ref = {}) {
    // The source is text someone forwarded or a page we fetched: data in tagged blocks, never a
    // JSON document the model is invited to read as one instruction.
    const user = [
      P.wrap("source_content", P.truncate(input.content, 40_000)),
      P.wrap("tracked_companies", input.portfolio.join("\n") || "(none)"),
      P.wrap("preference_profile", P.truncate(input.preferences || "(none written yet)", 14_000)),
    ].join("\n\n");
    return this.run<z.infer<typeof S.SourceCompaniesSchema>>(PROMPTS["A10.sources"], { user }, ref);
  }

  // A10 --------------------------------------------------------------------
  async suggestCompanies(
    input: {
      portfolio: Array<{ name: string; domain: string; oneLiner?: string; sector?: string; stage?: string; sizeBand?: string; hqCountry?: string; tags?: string[] }>;
      preferenceProfile?: string;
      excludeDomains: string[];
      rejected: Array<{ name: string; reason: string }>;
      limit: number;
    },
    ref: Ref = {},
  ): Promise<Array<{ name: string; homepageUrl: string; similarTo: string[]; rationale: string; confidence: number }> | null> {
    const portfolio = input.portfolio
      .slice(0, 60)
      .map((c) => `- ${c.name} (${c.domain})${c.sector ? ` — ${c.sector}` : ""}${c.stage ? `, ${c.stage}` : ""}${c.sizeBand ? `, ${c.sizeBand}` : ""}${c.hqCountry ? `, ${c.hqCountry}` : ""}${c.oneLiner ? `: ${c.oneLiner}` : ""}`)
      .join("\n");
    const user = [
      `Return up to ${input.limit} candidates.`,
      P.wrap("tracked_companies", portfolio),
      input.preferenceProfile ? P.wrap("preference_profile", P.truncate(input.preferenceProfile, 6000)) : "",
      `Excluded domains (never suggest these): ${input.excludeDomains.slice(0, 400).join(", ")}`,
      input.rejected.length ? P.wrap("previously_rejected", input.rejected.map((r) => `- ${r.name}: ${r.reason}`).join("\n")) : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await this.run<S.CompanySuggestionsOutput>(PROMPTS.A10, { user }, ref);
    if (!result) return null;
    const excluded = new Set(input.excludeDomains.map((d) => d.toLowerCase()));
    const out: Array<{ name: string; homepageUrl: string; similarTo: string[]; rationale: string; confidence: number }> = [];
    const seen = new Set<string>();
    for (const c of result.candidates) {
      if (!/^https?:\/\//i.test(c.homepageUrl)) continue;
      let domain: string;
      try {
        domain = new URL(c.homepageUrl).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        continue;
      }
      if (excluded.has(domain) || AGGREGATORS.some((a) => domain === a || domain.endsWith(`.${a}`))) continue;
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({
        name: c.name.trim(),
        homepageUrl: c.homepageUrl,
        similarTo: (c.similarTo ?? []).slice(0, 6),
        rationale: c.rationale.trim().slice(0, 400),
        confidence: clamp01(c.confidence),
      });
    }
    return out.slice(0, input.limit);
  }

  // A11 --------------------------------------------------------------------
  /**
   * Read one document someone brought to their Library and propose what it says.
   *
   * One call over one document, because a CV is small and the proposal is only ever a proposal:
   * the person ticks through it, and `validateLibraryProposal` has already dropped anything the
   * document does not support. `effort: "low"` for the same reason the evidence review uses it —
   * this is reading and copying, not judgement — and the document goes in the user turn in a
   * tagged block, never in the system prompt, because it is text the product did not write.
   *
   * Nothing is cached: a document is read once and then lives in the import row as text, so a
   * cache write would be paid for and never read.
   */
  async extractLibrary(
    input: { document: string; model?: string },
    ref: Ref = {},
  ): Promise<LibraryProposalPlan | null> {
    const document = input.document.trim();
    if (!document) return null;
    return this.run<LibraryProposalPlan>(PROMPTS.A11, {
      // The most an import row stores (`LIBRARY_IMPORT_MAX_CHARS`); the text arrives capped,
      // and this is the backstop for a row written before that cap existed.
      user: P.wrap("document", P.truncate(document, 40_000)),
      ...(input.model ? { model: input.model } : {}),
    }, ref);
  }

  // A12 --------------------------------------------------------------------
  /**
   * How much evidence each entry of a person's library carries, and what to ask for next.
   *
   * Batched exactly as the CV assessment is, and for the same reason: every batch has to see the
   * whole library to judge one entry against the rest of it, so the library is written to the
   * cache once and read back rather than paid for per batch. The first batch runs alone until its
   * response begins — that is when the cache entry becomes readable — and the rest run together.
   *
   * The model classifies and asks; it never writes evidence, and it never returns a score. Every
   * entry is put through `validateLibraryReview`, which keeps the person's rows as the unit, drops
   * rows the model invented, marks a row whose quote is not anchored in it as unverified, and
   * computes the score in code. An entry the model left out, or whose rows it did not all
   * classify, is asked for once more, and what is still uncovered comes back unverified: marked as
   * unread, never guessed at.
   *
   * An entry may carry `known`: rows an earlier review of it already classified, keyed by their
   * normalised text (`knownLibraryRows`). The batch still shows every row of the entry, so the
   * questions are asked with the whole entry in view, but names only the others as the rows to
   * classify, and `validateLibraryReview` keeps the known rows as they were. A one-row edit to a
   * twenty-row job pays for one row.
   *
   * A batch that produces nothing usable at all fails the pass rather than returning zeros,
   * because a caller writing those zeros over the rules baseline would report a transport fault
   * as a judgement about the person's writing.
   */
  async reviewLibraryEntries(
    input: { library: CvLibrary; entries: LibraryReviewEntry[]; model?: string },
    ref: { userId: string; refType: "library"; refId: string; signal?: AbortSignal },
    hooks: LibraryReviewHooks = {},
  ): Promise<LibraryEntryReview[]> {
    if (!input.entries.length) return [];
    // The whole library, as written, including the entries this pass is not reviewing: an entry is
    // judged for what it adds to the record, which needs the rest of the record in view.
    const evidence = P.wrap("library", P.truncate(libraryEvidenceText(input.library), 120_000));
    const batches: LibraryReviewEntry[][] = [];
    for (let offset = 0; offset < input.entries.length; offset += LIBRARY_REVIEW_BATCH)
      batches.push(input.entries.slice(offset, offset + LIBRARY_REVIEW_BATCH));

    // One controller for the pass: a batch that fails cancels its siblings, and so does the run's
    // signal or the caller's, so a task that has been given up on stops paying for the rest.
    const controller = batchController([this.options.signal, hooks.signal, ref.signal]);

    const ask = (entries: LibraryReviewEntry[], missing: string[] | undefined, onStart: (() => void) | undefined,
      onRecord: (record: AiUsageRecord) => void) => this.run<LibraryReviewPlan>(PROMPTS.A12, {
      user: {
        stable: [evidence],
        tail: P.wrap("entries_under_review", entriesUnderReview(input.library, entries)) + (missing?.length
          ? `\n\nYour previous answer left these entries out, or left rows of them unclassified. Return each of them exactly once, with every row you were asked to classify: ${missing.join(", ")}.`
          : ""),
      },
      ...(input.model ? { model: input.model } : {}),
      signal: controller.signal,
      onStart,
      onRecord,
      // A re-run is a second charge for one batch, and the difference between a pass that asked
      // twice and one that simply had many batches. Name it separately.
    }, { ...ref, stage: missing ? "review_retry" : "review" });

    // Null when the batch produced nothing usable at all.
    const reviewBatch = async (index: number, onStart?: () => void): Promise<LibraryEntryReview[] | null> => {
      const entries = batches[index]!;
      const say = (phase: LibraryReviewBatchEvent["phase"], extra: Partial<LibraryReviewBatchEvent> = {}) =>
        this.notify(hooks.onBatch, { index, total: batches.length, phase, entries: entries.length, ...extra }, "library review batch hook failed");
      await say("start");
      let usage: AiUsageRecord | undefined;
      let plan = await ask(entries, undefined, onStart, record => { usage = record; });
      // Covered means answered for, with every row that needed classifying classified.
      const uncoveredBy = (answer: LibraryReviewPlan | null) => entries.filter(entry =>
        !libraryPlanCovers(entry, answer?.entries.find(said => said.entryId === entry.id), entry.known));
      let uncovered = uncoveredBy(plan);
      if (uncovered.length) {
        await say("retry", { usage, uncovered: uncovered.length });
        // Only the entries still owed: the ones answered in full stand, and asking for them again
        // paid for a second copy of every row the first answer had already classified.
        const again = await ask(uncovered, uncovered.map(entry => entry.id), undefined, record => { usage = record; });
        if (!plan && !again) {
          await say("failed", { usage, uncovered: uncovered.length });
          return null;
        }
        if (again) {
          // The first answer's rows and prompts stand; the second fills in what the first lacked —
          // an entry it left out, or rows of an entry it answered for only in part.
          const merged = new Map((plan?.entries ?? []).map(said => [said.entryId, said]));
          for (const said of again.entries) {
            const before = merged.get(said.entryId);
            // A row the first answer already named keeps that reading: taken twice, the number
            // would read as named more than once and the row would lose its classification.
            const named = new Set(before?.rows.map(row => row.row));
            merged.set(said.entryId, before
              ? { ...before, rows: [...before.rows, ...said.rows.filter(row => !named.has(row.row))], prompts: before.prompts.length ? before.prompts : said.prompts }
              : said);
          }
          plan = { entries: [...merged.values()] };
          uncovered = uncoveredBy(plan);
        }
      }
      const said = new Map(plan!.entries.map(entry => [entry.entryId, entry]));
      // Every entry is answered for, covered or not: an entry the model never mentioned reads as
      // rows nobody classified, which is what the Library shows as unread rather than as absent.
      // So does one whose answer asked the person about a demographic attribute: that answer is
      // refused for that entry alone, which keeps its rules baseline and asks about it again next
      // pass, instead of throwing away every other entry the pass read.
      const nothing = (entry: CvEntry): LibraryReviewPlanEntry => ({ entryId: entry.id, rows: [], prompts: [] });
      const reviews = entries.map(entry => {
        const answer = said.get(entry.id);
        // Left out: the known rows stand and the rest go unverified, which is unread when any
        // row needed classifying.
        if (!answer) return validateLibraryReview(entry, nothing(entry), entry.known);
        if (answer.prompts.some(prompt => mentionsDemographicAttribute(prompt))) {
          this.log("library review asked about a demographic attribute; entry left unread", { entryId: entry.id });
          return validateLibraryReview(entry, nothing(entry));
        }
        return validateLibraryReview(entry, answer, entry.known);
      });
      await say("done", { usage, ...(uncovered.length ? { uncovered: uncovered.length } : {}) });
      return reviews;
    };

    // Without every batch the pass is incomplete; the runner has already stopped paying for the rest.
    const results = await runBatchedPass(batches.map((_, index) => index), controller, reviewBatch, result => result !== null);
    const reviews = batches.map((_, index) => results.get(index) ?? null);
    if (reviews.includes(null)) throw new Error("The evidence review returned nothing usable for one batch of entries.");
    return (reviews as LibraryEntryReview[][]).flat();
  }
}

type CvEntry = CvLibrary["entries"][number];

/**
 * One entry for the evidence review, with the rows an earlier review of it already classified,
 * keyed by normalised text (`knownLibraryRows`), when there are any.
 */
export type LibraryReviewEntry = CvEntry & { known?: ReadonlyMap<string, LibraryRowReview> };

/**
 * The library as evidence context: the jobs it records and every entry's rows exactly as written,
 * including the entries this pass is not reviewing and the types the person tagged them with.
 *
 * Deliberately not `groupCvLibrary`/`cvEvidenceItems`, which the CV assessment uses: those keep
 * only confirmed rows and refuse a library with none, and an entry nobody has confirmed yet is
 * exactly the one this review exists to help with.
 */
function libraryEvidenceText(library: CvLibrary): string {
  const lines: string[] = [];
  if (library.profile.trim()) lines.push(`Profile: ${library.profile.trim()}`, "");
  for (const job of library.employment ?? []) lines.push(`Job [${job.id}]: ${employmentHeading(job)}`);
  if (library.employment?.length) lines.push("");
  for (const entry of library.entries) {
    const job = library.employment?.find(item => item.id === entry.employmentId);
    lines.push(`Entry [${entry.id}] ${entry.kind}${job ? ` at job [${job.id}]` : ""}: ${entry.heading}`);
    for (const row of responsibilityRows(entry.details)) {
      const facets = rowFacets(entry, row);
      lines.push(`  - ${row}${facets.length ? ` (they tagged this ${facets.join(", ")})` : ""}`);
    }
    for (const skill of entry.skillItems ?? []) lines.push(`  - skill: ${skill}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * The batch: which entries to classify now, whose they are, and their rows verbatim. Every row of
 * an entry is listed, so its questions are asked with the whole entry in view; when an earlier
 * review already classified some of them, the rows still to classify are named after it.
 */
function entriesUnderReview(library: CvLibrary, entries: LibraryReviewEntry[]): string {
  return entries.map(entry => {
    const job = library.employment?.find(item => item.id === entry.employmentId);
    const rows = reviewableRows(entry);
    // Numbered, so the answer names a row by its number instead of copying it back; the rows still
    // to classify are named by number too, rather than listed a second time.
    const { toClassify } = rowNumbers(entry, entry.known);
    return [
      `Entry [${entry.id}] (${entry.kind})`,
      job ? `Company: ${job.company}` : null,
      job ? `Title: ${job.jobTitle}` : null,
      `Heading: ${entry.heading}`,
      "Rows:",
      ...rows.map((row, index) => `${index + 1}. ${row}`),
      ...(toClassify.length < rows.length
        ? [toClassify.length
          ? `Classify only rows ${toClassify.join(", ")} (the others are already classified; do not return them).`
          : "Classify no rows (all are already classified): return this entry with no rows, and its prompts."]
        : []),
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

const AGGREGATORS = [
  "linkedin.com", "glassdoor.com", "glassdoor.co.uk", "crunchbase.com", "wikipedia.org", "indeed.com", "indeed.co.uk",
  "pitchbook.com", "ycombinator.com", "otta.com", "welcometothejungle.com", "totaljobs.com", "reed.co.uk", "monster.com",
  "ziprecruiter.com", "builtin.com", "wellfound.com", "angel.co",
];

export interface DecisionForDigest {
  title: string;
  company: string;
  location?: string | null;
  department?: string | null;
  decision: "apply" | "skip";
  reason: string;
  tags: string[];
  snippet?: string | null;
  fitScore?: number | null;
  at: string;
}

/**
 * A3's output ceiling for a page of `lines` links. Each posting copied out is about 50-65 tokens —
 * a URL tokenises poorly — and the recipe and confidence follow it, so the ceiling grows with the
 * listing, from a floor for a short page to the cap a streamed answer is allowed. At the cap it
 * covers the schema's 500 postings at 60 tokens each.
 */
export function a3OutputCeiling(lines: number): number {
  return Math.min(32_000, Math.max(4_000, 2_000 + Math.max(0, lines) * 70));
}

/** Compact, newest-first summary of past decisions used as cached context for scoring. */
export function decisionDigest(decisions: DecisionForDigest[], opts: { maxItems?: number; maxChars?: number } = {}): string {
  const maxItems = opts.maxItems ?? 100;
  const maxChars = opts.maxChars ?? 12_000;
  const sorted = [...decisions].sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
  const lines: string[] = [];
  let used = 0;
  for (const d of sorted.slice(0, maxItems)) {
    const reason = (d.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    const tags = d.tags.length ? ` #${d.tags.join(" #")}` : "";
    const location = d.location?.trim();
    // Keep the actual decision's title, reason and tags in the digest even when its stored
    // employer location list is enormous. The complete list remains on the decision record.
    const digestLocation = location && location.length > 1_000
      ? "multiple/long location listing omitted from this summary" : location;
    const line = `- [${d.decision}] ${d.title} @ ${d.company}${digestLocation ? ` (${digestLocation})` : ""}${reason ? ` — ${reason}` : ""}${tags}`;
    if (used + line.length + 1 > maxChars) continue;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * What a filter suggestion names, as one comparable key: its type and its term, lowercased, or the
 * company a pause is for. A suggestion from the scans (`{ term, source }`) and one from the model
 * (`{ term }`) naming the same term are the same suggestion.
 */
export function filterSuggestionKey(type: string, value: unknown): string {
  const v = (value ?? {}) as Record<string, unknown>;
  if (type === "pause_company") return `${type}|${typeof v.companyId === "string" ? v.companyId.trim() : JSON.stringify(v)}`;
  return `${type}|${typeof v.term === "string" ? v.term.trim().toLowerCase() : JSON.stringify(v).toLowerCase()}`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(Math.max(0, Math.min(1, n)).toFixed(3));
}

function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function textOf(response: ParseResponse): string {
  return (response.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Recover a JSON object from a fenced block or the first balanced braces in free text. */
export function extractJsonBlock(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      /* try the next strategy */
    }
    const start = trimmed.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/**
 * An audit answer with every library citation named by its block. The auditor may cite a row of
 * the canonical evidence under the row's own id; the validators know the block, and the row is in
 * it, so the citation stands or falls on its quote exactly as it would under the block's id.
 */
function sourcedByBlock(review: CvReviewBatchAnswer | null, entryIds?: ReadonlySet<string>): CvReviewBatchAnswer | null {
  if (!review) return review;
  const byBlock = <T extends { id: string }>(refs: T[]) => refs.map(ref => ({ ...ref, id: evidenceBlockId(ref.id, entryIds) }));
  return {
    ...review,
    matches: review.matches.map(match => (match.libraryEvidence ? { ...match, libraryEvidence: byBlock(match.libraryEvidence) } : match)),
    claims: review.claims.map(claim => ({ ...claim, evidence: byBlock(claim.evidence) })),
  };
}

/**
 * Validate against the call site schema, keeping the reason on failure. That reason is what
 * makes a bad response diagnosable from the AI call log: "sections.0.bullets.3: Too big"
 * names the offending field, where a bare "no parseable output" does not.
 */
function validate<T>(schema: z.ZodType, value: unknown): { data: T } | { error: string } {
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data as T };
  const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { error: `${SCHEMA_ERROR_PREFIX} ${issues}`.slice(0, 500) };
}

/** What one fit score (A5) is computed from. */
export interface ScoreJobInput {
  profileMarkdown: string;
  decisionDigest: string;
  /** Model and effort resolved with the same fresh settings as this score's fingerprint. */
  route?: { model: string; effort: Effort };
  /** The evidence that bears on this role, already bounded (`scoringEvidence` in core). */
  evidence?: string;
  job: { title: string; company: string; location?: string; locations?: string[]; locationTerms?: string[]; locationStatus?: "pending" | "unavailable"; department?: string; employmentType?: string; description?: string; keywordTerms?: string[] };
}

/** One fit score, clamped and checked. */
export interface ScoreJobResult {
  score: number;
  verdict: "strong" | "possible" | "unlikely";
  rationale: string;
  flags: string[];
}

/** One role's A5 request for a batch, with what it is held at. */
export interface BatchScoreRequest {
  params: Record<string, unknown>;
  meta: AiCallMeta;
  model: string;
  /** The request at the batch price, the account's context priced as a cache write, output at its ceiling. */
  estimateUsd: number;
}

/** Who and what a batch result was for, as its ledger row records it. */
export interface BatchResultContext {
  batchId: string;
  /** The model the request was sent to, for a result that names none. */
  model: string;
  /** The prompt the request was sent with, which a deploy since may have changed. */
  promptId: string;
  promptVersion: string;
  submittedAt: Date;
  userId: string;
  jobId: string;
  now?: Date;
}

/** How long one batch submission, status read or results stream may take to begin. */
export const BATCH_REQUEST_TIMEOUT_MS = 120_000;
/** The label of a batch request the provider reports as errored, followed by the error's type. */
export const BATCH_ERROR_PREFIX = "batch request errored:";

function batchIdentity(item: BatchResultContext) {
  return { refType: "job", refId: item.jobId, userId: item.userId, promptId: item.promptId, promptVersion: item.promptVersion };
}

/**
 * The A5 user turn: the account's own context first, cached, because it is the same for every role
 * the account scores and a rescore reads it back; the evidence chosen for this role and the role
 * itself vary, so they come after it.
 */
function scoreJobUser(input: ScoreJobInput): { stable: string[]; tail: string } {
  const j = input.job;
  const jobText = [
    `Title: ${j.title}`,
    `Company: ${j.company}`,
    j.locations?.length ? scoreLocationEvidence(j.locations, j.locationTerms) : null,
    !j.locations?.length && j.location ? `Location: ${j.location}` : null,
    j.locationStatus === "pending" ? "Location: awaiting verification of the current places" : null,
    j.locationStatus === "unavailable" ? "Location: current places could not be verified" : null,
    j.department ? `Department: ${j.department}` : null,
    j.employmentType ? `Employment type: ${j.employmentType}` : null,
    j.keywordTerms?.length ? `Matched keywords: ${j.keywordTerms.join(", ")}` : null,
    j.description ? `\nDescription:\n${P.truncate(j.description, 6000)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const account = [
    P.wrap("preference_profile", P.truncate(input.profileMarkdown || "(no profile yet; rely on the decisions)", 8_000)),
    P.wrap("decisions", P.truncate(input.decisionDigest || "(no decisions recorded yet)", 12_000)),
  ].join("\n\n");
  const role = [
    P.wrap("evidence_library", P.truncate(input.evidence || "(no confirmed evidence yet)", 10_000)),
    P.wrap("job", jobText),
  ].join("\n\n");
  return { stable: [account], tail: role };
}

/** A validated A5 answer as a score: clamped, its verdict the one its score implies, its flags cleaned. */
function finishScore(result: S.FitScoreOutput): ScoreJobResult {
  const score = Math.round(Math.max(0, Math.min(100, result.score)));
  const verdict = score >= 70 ? "strong" : score >= 30 ? "possible" : "unlikely";
  return {
    score,
    verdict: result.verdict === verdict ? result.verdict : verdict,
    rationale: result.rationale.trim().slice(0, 300),
    flags: [...new Set((result.flags ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean))].slice(0, 8),
  };
}

export function createAiEngine(options: AiEngineOptions): AiEngine {
  return new AiEngine(options);
}

/**
 * A provider client for a caller that wraps it — a recording, say — before handing it to an
 * engine. An engine given a client leaves retrying to that client, so this one keeps the SDK's own
 * retries of a request that failed before its response began.
 */
export function createProviderClient(apiKey: string): AiClientLike {
  return new Anthropic({ apiKey, maxRetries: SDK_MAX_RETRIES }) as unknown as AiClientLike;
}
