import { CvReviewPlanSchema, type CvRubric, type CvReviewPlan, type CvTextItem, type CvClaimItem } from "@ava/core/cv-assessment";
import { CvBuildStop } from "@ava/core/cv-build-failure";
import { mentionsDemographicAttribute } from "@ava/core/cv-review";
import { cvReviewBatches, reviewBatchIssues, markUnverifiedFindings, type CvReviewBatch } from "./cv-review-batch";
import {
  CV_PAGE_LIMITS,
  LIBRARY_REVIEW_BATCH,
  employmentHeading,
  responsibilityRows,
  cvTailoringEvidence,
  validateCvTailoringPlan,
  validateCvPlanProvenance,
  reviewableRows,
  rowFacets,
  validateLibraryReview,
  type CvWritingBudget,
  type CvPlan,
  type CvLibrary,
  type CvTailoringPlan,
  type LibraryEntryReview,
  type LibraryProposalPlan,
  type LibraryReviewPlan,
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
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { estimateCostUsd, SERVER_TOOL_USD, serverToolCostUsd } from "./pricing";
import { modelSupportsEffort } from "./model-capabilities";
import * as P from "./prompts";
import type * as S from "./schemas";
import { CV_REVIEW_BATCH_SIZE, PROMPTS, layoutFor, type LayoutParts, type PromptEntry } from "./prompt-registry";

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
}

export interface AiUsageRecord {
  callSite: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  /**
   * Stops this one call: the request, the SDK's retries, and the wait for either. A handler passes
   * its run's signal, so a task that outran its deadline or lost its lease stops paying for an
   * answer nobody will read. It is never recorded; the rest of the ref is.
   */
  signal?: AbortSignal;
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
  };
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
}

export interface ParseResponse {
  parsed_output?: unknown;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
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
  /** Route calls through the server-side refusal fallback. Requires a model that supports it. */
  useServerFallback?: boolean;
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
 * How many times a turn a server tool paused (`stop_reason: "pause_turn"`, the server's own
 * iteration limit) is resumed before the call is given up as unfinished.
 */
export const MAX_PAUSE_CONTINUATIONS = 2;
/** The label of a server-tool turn still paused after every continuation it was allowed. */
export const PAUSED_ERROR = `Server tool turn still paused after ${MAX_PAUSE_CONTINUATIONS} continuations.`;

type Usage = NonNullable<ParseResponse["usage"]>;

/** Two requests' usage as one: every token count added, and every server-tool count by its name. */
function addUsage(a: Usage, b: Usage): Usage {
  const tools: Record<string, unknown> = { ...(a.server_tool_use ?? {}) };
  for (const [field, value] of Object.entries(b.server_tool_use ?? {}))
    tools[field] = typeof value === "number" ? (typeof tools[field] === "number" ? (tools[field] as number) : 0) + value : value;
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    ...(Object.keys(tools).length ? { server_tool_use: tools } : {}),
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

function cutMessage(cut: CallCut, reason: unknown): string {
  if (cut === "stalled") return `Stream timed out: no complete response after ${STREAM_CEILING_MS / 60_000} minutes.`;
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
    if (error.cut === "stalled") return { kind: "stalled" };
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

class BatchFailed extends Error {}

/**
 * One controller for a batched pass: aborted with the outer signal's own reason when any outer
 * signal aborts (so a deadline stays a deadline on every batch), and with `SiblingFailed` by the
 * pass itself when one batch fails.
 */
function batchController(outer: Array<AbortSignal | undefined>) {
  const controller = new AbortController();
  const signals = outer.filter((signal): signal is AbortSignal => !!signal);
  const forward = (event: Event) => controller.abort((event.target as AbortSignal).reason);
  const aborted = signals.find(signal => signal.aborted);
  if (aborted) controller.abort(aborted.reason);
  else for (const signal of signals) signal.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    siblingFailed: () => controller.abort(new SiblingFailed()),
    release: () => { for (const signal of signals) signal.removeEventListener("abort", forward); },
  };
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
  phase: "start" | "done" | "retry" | "failed";
  requirements: number;
  claims: number;
  /** How many attribution corrections the re-run was asked to make; absent when there was none. */
  corrections?: number;
  /** The call's own cost and tokens, once it has been recorded. */
  usage?: AiUsageRecord;
}

export interface CvAssessHooks {
  /** Never throws into the audit: a hook that fails is logged and the batch carries on. */
  onBatch?: (event: CvAssessBatchEvent) => void | Promise<void>;
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

  constructor(private readonly options: AiEngineOptions) {
    if (options.client) {
      this.client = options.client;
    } else if (options.apiKey) {
      // The SDK retries only before a response begins (rate limits, overload, connection errors),
      // so a retried call is never billed twice and a streamed answer is never re-requested part-way.
      this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: SDK_MAX_RETRIES }) as unknown as AiClientLike;
    } else {
      this.client = null;
    }
    this.enabled = this.client !== null;
  }

  /**
   * This engine for one run: every call it makes also stops when `signal` aborts. The client, and
   * its connection pool, is shared rather than built again from the key, and so are the budget
   * and the ledger, so a run's engine spends and records exactly as the shared one does.
   */
  withSignal(signal: AbortSignal): AiEngine {
    return new AiEngine({ ...this.options, client: this.client ?? undefined, signal: anySignal(this.options.signal, signal) });
  }

  private log(msg: string, data?: unknown) {
    this.options.logger?.(msg, data);
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
    const { messages } = this.client!;
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
    let stalled = false;
    let ceiling: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!messages.stream) {
        const response = await settled(messages.create(request, options, params.meta));
        params.onStart?.();
        return response;
      }
      const open = messages.stream(request, options, params.meta);
      stream = open;
      let started = false;
      open.on("streamEvent", () => {
        if (started) return;
        started = true;
        params.onStart?.();
      });
      ceiling = setTimeout(() => {
        stalled = true;
        open.abort();
      }, STREAM_CEILING_MS);
      return await settled(open.finalMessage());
    } catch (err) {
      const cut: CallCut | undefined = stalled ? "stalled" : signal?.aborted ? cutFor(signal.reason) : undefined;
      // A create call that failed on its own is thrown as it came, so its class still names it.
      if (!stream && !cut) throw err;
      throw new CallCutOff(cut ? cutMessage(cut, signal?.reason) : (err as Error).message, stream?.currentMessage, err, cut);
    } finally {
      clearTimeout(ceiling);
      if (stopWaiting) signal!.removeEventListener("abort", stopWaiting);
    }
  }

  private async run<T>(entry: PromptEntry, call: CallInput, ref: Ref = {}): Promise<T | null> {
    // The signal stops the call, and is not part of what is recorded about it.
    const { signal: callerSignal, ...recorded } = ref;
    // A call's own signal when it has one (an assessment batch's, which already listens to the
    // run's and the caller's), otherwise the caller's and the run's together.
    const signal = call.signal ?? anySignal(callerSignal, this.options.signal);
    if (!this.client || signal?.aborted) return null;
    const callSite = entry.callSite;
    const model = call.model ?? await this.options.getModel(callSite);
    const started = Date.now();
    const { system, content } = layoutFor(entry, typeof call.user === "string" ? { tail: call.user } : call.user);
    const texts = [...system.map(block => block.text), ...(typeof content === "string" ? [content] : content.map(block => block.text))];
    const maxTokens = call.maxTokens ?? entry.maxTokens;
    // The format goes without its parser. Given one, the SDK parses inside the stream and rejects
    // the whole answer when the text is not valid JSON — which a truncated answer and a prose
    // refusal always are — so it arrived here as an unnamed error instead of as a refusal, an
    // output limit or a schema failure. Validation is `validate` below, on both paths.
    const { parse: _parse, ...format } = zodOutputFormat(entry.schema);
    const request: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system,
      // The cache is a prefix match, so a cached block sits before everything that varies.
      messages: [{ role: "user", content }],
      output_config: { format, ...(modelSupportsEffort(model) ? { effort: entry.effort } : {}) },
    };
    const tools = entry.tools?.map(tool => ({ ...tool }));
    if (tools) request.tools = tools;
    // The caller names the step when it knows better (a re-run, a revision); otherwise the entry does.
    const stage = recorded.stage ?? entry.stage;
    const identity = { ...recorded, ...(stage ? { stage } : {}), promptId: entry.id, promptVersion: entry.version };
    const meta: AiCallMeta = { promptId: entry.id, promptVersion: entry.version, ...(stage ? { stage } : {}) };

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
      const maxDurationMs = requests * ((SDK_MAX_RETRIES + 1) * entry.timeoutMs + STREAM_CEILING_MS + 60_000);
      settle = await this.options.reserve(callSite, estimate, recorded, { maxDurationMs });
      if (settle === null) throw new Error("AI budget reserved or exhausted; retry later");
    }
    // What the requests before the last one used: a paused turn is resumed as a new request, and
    // every one of them is billed, so the one record this call leaves carries them all.
    let prior: Usage = {};
    try {
      const sending: Sending = { timeoutMs: entry.timeoutMs, meta, ...(call.onStart ? { onStart: call.onStart } : {}), ...(signal ? { signal } : {}) };
      let response = await this.complete(request, sending);
      // A server tool that reached its iteration limit pauses the turn; sending the turn back, as
      // it stands, lets it carry on from there. No extra user turn: the assistant's is resumed.
      for (let resumed = 0; response.stop_reason === "pause_turn" && resumed < MAX_PAUSE_CONTINUATIONS && !signal?.aborted; resumed++) {
        prior = addUsage(prior, response.usage ?? {});
        request.messages = [...(request.messages as unknown[]), { role: "assistant", content: response.content ?? [] }];
        response = await this.complete(request, sending);
      }
      const usage = addUsage(prior, response.usage ?? {});
      const tokens = {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      };
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
      const served = response.model ?? model;
      // An answered call that cannot be used still has a name: the model declined, it ran out of
      // room, or what came back did not fit the schema. All three are the model's answer failing,
      // never the transport, and the caller decides differently about each.
      const failure: AiFailure | undefined = validated !== null ? undefined
        : refused ? { kind: "refused" }
        : truncated ? { kind: "output_limit" }
        : { kind: "output_invalid" };
      const record: AiUsageRecord = {
        callSite,
        model: served,
        ...tokens,
        // A web search is billed per request as well as by the tokens its results add to the turn.
        costUsd: estimateCostUsd(served, tokens) + serverToolCostUsd(usage.server_tool_use),
        durationMs: Date.now() - started,
        ok: validated !== null,
        error: "error" in outcome ? outcome.error : undefined,
        ...(failure ? { failure } : {}),
        ...identity,
      };
      landed = await this.record(record);
      call.onRecord?.(record);
      if (refused) this.log(`${callSite} refused`, response.stop_details);
      return validated;
    } catch (err) {
      // A call that failed before it began spent nothing. One cut off part-way was billed for the
      // prompt it had processed, which is in the snapshot the cut-off carries.
      const snapshot = err instanceof CallCutOff ? err.snapshot : undefined;
      const partial: Usage = addUsage(prior, snapshot?.usage ?? {});
      const tokens = {
        inputTokens: partial.input_tokens ?? 0,
        outputTokens: partial.output_tokens ?? 0,
        cacheReadTokens: partial.cache_read_input_tokens ?? 0,
        cacheWriteTokens: partial.cache_creation_input_tokens ?? 0,
      };
      // Price at the model that served the call when the snapshot names one, as the success path
      // does: a server-side fallback bills at the model that answered, not the one that was asked.
      const served = snapshot?.model ?? model;
      const failure = classifyAiFailure(err);
      const record: AiUsageRecord = {
        callSite,
        model: served,
        ...tokens,
        costUsd: estimateCostUsd(served, tokens) + serverToolCostUsd(partial.server_tool_use),
        durationMs: Date.now() - started,
        ok: false,
        error: (err as Error).message.slice(0, 500),
        ...(failure ? { failure } : {}),
        ...identity,
      };
      landed = await this.record(record);
      call.onRecord?.(record);
      this.log(`${callSite} failed`, err);
      return null;
    } finally {
      // A call whose cost never reached the ledger keeps its hold until the hold expires.
      if (landed) await settle?.();
    }
  }

  async analyseCvJob(
    description: string,
    ref: Ref = {},
  ): Promise<CvRubric | null> {
    return this.run<CvRubric>(PROMPTS["cv.rubric"], { user: JSON.stringify({ description }) }, ref);
  }

  /** One bounded pre-writing call. The returned index is validated against exact trusted rows. */
  async planCvTailoring(
    input: { rubric: CvRubric; library: CvLibrary },
    ref: Ref = {},
  ): Promise<CvTailoringPlan | null> {
    const evidence = cvTailoringEvidence(input.library);
    const destinations = {
      employment: (input.library.employment ?? []).map(job => ({ employmentId: job.id, label: employmentHeading(job) })),
      evidence: input.library.entries.map(entry => ({ entryId: entry.id, label: entry.heading, kind: entry.kind })),
    };
    const result = await this.run<CvTailoringPlan>(PROMPTS["cv.planning"], {
      user: JSON.stringify({ rubric: input.rubric, evidence, destinations }),
    }, ref);
    if (!result) return null;
    try {
      return validateCvTailoringPlan(result, input.rubric, evidence, input.library);
    } catch (error) {
      throw new CvBuildStop("output_invalid", `The evidence plan could not be verified: ${(error as Error).message}`);
    }
  }

  async assessCv(
    input: {
      rubric: CvRubric;
      cv: CvTextItem[];
      claims: CvClaimItem[];
      evidence: CvTextItem[];
    },
    ref: Ref = {},
    hooks: CvAssessHooks = {},
  ): Promise<CvReviewPlan | null> {
    // A full CV audit can exceed what one call may produce, so it is split into batches that each
    // see the complete CV and evidence. The batches are independent: they run together, and they
    // share that context through the cache rather than each paying for it again.
    const batchSize = CV_REVIEW_BATCH_SIZE;
    const { requirements: _requirements, ...rubricContext } = input.rubric;
    // The shared context is two cached blocks in the order it changes, least often first: the
    // evidence and rubric outlive a revision, so the re-audit of an edited CV reads them from
    // cache and writes only the CV; within one audit the batches after the first read both. The
    // cache is a prefix match, so nothing that varies may come before either.
    const stable = JSON.stringify({ evidence: input.evidence, rubric: rubricContext });
    const printed = JSON.stringify({ cv: input.cv });
    const batches = cvReviewBatches(input, batchSize);
    // One controller for the audit: a batch that fails cancels its siblings, and so does the run's
    // own signal, so a build whose task has been given up on stops paying for the rest of its audit.
    const controller = batchController([this.options.signal, ref.signal]);
    const runBatch = (batch: CvReviewBatch, corrections?: string[], onStart?: () => void, onRecord?: (record: AiUsageRecord) => void) => this.run<CvReviewPlan>(PROMPTS["cv.review"], {
      user: { stable: [stable, printed], tail: JSON.stringify({ ...batch, ...(corrections ? { corrections } : {}) }) },
      signal: controller.signal,
      onStart,
      onRecord,
      // The corrections re-run is a second charge for one batch, and the difference between an
      // audit that cost twice over and one that simply had many batches. Name it separately.
    }, corrections ? { ...ref, stage: `${ref.stage ?? "review"}_retry` } : ref);
    const assess = async (batch: CvReviewBatch, index: number, onStart?: () => void): Promise<CvReviewPlan> => {
      const context = { cv: input.cv, claims: batch.claims, evidence: input.evidence };
      // The batches run together, so a watcher that only saw the audit begin and end could not say
      // which of five was slow or which paid twice. Each says so for itself, carrying the usage of
      // its own call rather than leaving the caller to guess from the engine-wide record.
      const say = async (phase: CvAssessBatchEvent["phase"], extra: Partial<CvAssessBatchEvent> = {}) => {
        try {
          await hooks.onBatch?.({ index, total: batches.length, phase,
            requirements: batch.requirements.length, claims: batch.claims.length, ...extra });
        } catch (err) {
          this.log("assessment batch hook failed", err);
        }
      };
      await say("start");
      let usage: AiUsageRecord | undefined;
      let result = await runBatch(batch, undefined, onStart, record => { usage = record; });
      if (!result) {
        await say("failed", { usage });
        throw new BatchFailed();
      }
      const corrections = reviewBatchIssues(result, context).map(issue => issue.correction);
      if (corrections.length) {
        // The first call is finished and paid for; what follows is a second charge for this batch.
        await say("retry", { usage, corrections: corrections.length });
        result = await runBatch(batch, corrections, undefined, record => { usage = record; });
        if (!result) {
          await say("failed", { usage, corrections: corrections.length });
          throw new BatchFailed();
        }
        // A repeated attribution mistake earns no credit and remains visible for review.
        // The final strict source validator still checks all accepted evidence quotes.
        result = markUnverifiedFindings(result, reviewBatchIssues(result, context));
      }
      const complete = (expected: string[], actual: string[]) =>
        expected.length === actual.length && new Set(actual).size === actual.length &&
        expected.every(id => actual.includes(id));
      if (!complete(batch.requirements.map(item => item.id), result.matches.map(item => item.requirementId)) ||
          !complete(batch.claims.map(item => item.id), result.claims.map(item => item.claimId))) {
        await say("failed", { usage, ...(corrections.length ? { corrections: corrections.length } : {}) });
        throw new Error("The assessment did not cover every requested requirement and claim exactly once. The fitted CV is saved; retry its assessment.");
      }
      await say("done", { usage, ...(corrections.length ? { corrections: corrections.length } : {}) });
      return result;
    };
    const results: CvReviewPlan[] = [];
    const pending: Promise<void>[] = [];
    try {
      if (batches.length) {
        // The cache entry is readable only once the first response has begun; batches sent before
        // then would each write their own copy. So the first goes alone until then, the rest together.
        let begun!: () => void;
        const firstBegun = new Promise<void>(resolve => { begun = resolve; });
        let firstFailed = false;
        const first = assess(batches[0]!, 0, () => begun()).then(result => { results[0] = result; });
        pending.push(first);
        await Promise.race([firstBegun, first.then(() => undefined, () => { firstFailed = true; })]);
        if (firstFailed) await first;
        batches.slice(1).forEach((batch, index) => {
          pending.push(assess(batch, index + 1).then(result => { results[index + 1] = result; }));
        });
        await Promise.all(pending);
      }
    } catch (err) {
      // Without every batch the audit is worthless: stop paying for the rest, then let them record.
      controller.siblingFailed();
      await Promise.allSettled(pending);
      if (err instanceof BatchFailed) return null;
      throw err;
    } finally {
      controller.release();
    }
    const review = { matches: results.flatMap(result => result.matches), claims: results.flatMap(result => result.claims) };
    const result = CvReviewPlanSchema.safeParse(review);
    return result.success ? result.data : null;
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
      linkedinUrl: _linkedin,
      websiteUrl: _website,
      ...evidenceLibrary
    } = input.library;
    // The optional improvement is the same prompt asked a second time with the audit's findings;
    // it is its own entry so its cost and its prompt version are recorded as its own.
    const entry = ref.stage === "improvement" || input.improvements?.length ? PROMPTS["cv.improvement"] : PROMPTS["cv.author"];
    const plan = await this.run<CvPlan>(entry, {
      user: JSON.stringify({ ...input, maxPages: input.maxPages ?? CV_PAGE_LIMITS.default, library: evidenceLibrary,
        ...(input.tailoringPlan ? { tailoringEvidence: cvTailoringEvidence(input.library) } : {}) }),
    }, ref);
    if (!plan || !input.tailoringPlan) return plan;
    try {
      return validateCvPlanProvenance(plan, input.library);
    } catch (error) {
      throw new CvBuildStop("output_invalid", `The written CV's sources could not be verified: ${(error as Error).message}`);
    }
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
  ): Promise<{ descriptionText: string; salaryText?: string; employmentType?: string; remote?: boolean } | null> {
    const result = await this.run<S.DescriptionOutput>(PROMPTS.A4, {
      user: `Role: ${input.title}\n\n${P.wrap("page_content", P.truncate(input.rawText, 40_000))}`,
    }, ref);
    if (!result) return null;
    return {
      descriptionText: result.descriptionText.trim().slice(0, 30_000),
      salaryText: result.salaryText?.trim() || undefined,
      employmentType: result.employmentType?.trim() || undefined,
      remote: result.remote ?? undefined,
    };
  }

  // A5 ---------------------------------------------------------------------
  async scoreJob(
    input: {
      profileMarkdown: string;
      decisionDigest: string;
      /** The evidence that bears on this role, already bounded (`scoringEvidence` in core). */
      evidence?: string;
      job: { title: string; company: string; location?: string; department?: string; employmentType?: string; description?: string; keywordTerms?: string[] };
    },
    ref: Ref = {},
  ): Promise<{ score: number; verdict: "strong" | "possible" | "unlikely"; rationale: string; flags: string[] } | null> {
    const j = input.job;
    const jobText = [
      `Title: ${j.title}`,
      `Company: ${j.company}`,
      j.location ? `Location: ${j.location}` : null,
      j.department ? `Department: ${j.department}` : null,
      j.employmentType ? `Employment type: ${j.employmentType}` : null,
      j.keywordTerms?.length ? `Matched keywords: ${j.keywordTerms.join(", ")}` : null,
      j.description ? `\nDescription:\n${P.truncate(j.description, 6000)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    // The account's own context is the first block and is cached: it is the same for every role
    // the account scores, so a rescore reads it back. The evidence chosen for this role and the
    // role itself vary, so they come after it.
    const account = [
      P.wrap("preference_profile", P.truncate(input.profileMarkdown || "(no profile yet; rely on the decisions)", 8_000)),
      P.wrap("decisions", P.truncate(input.decisionDigest || "(no decisions recorded yet)", 12_000)),
    ].join("\n\n");
    const role = [
      P.wrap("evidence_library", P.truncate(input.evidence || "(no confirmed evidence yet)", 10_000)),
      P.wrap("job", jobText),
    ].join("\n\n");
    const result = await this.run<S.FitScoreOutput>(PROMPTS.A5, { user: { stable: [account], tail: role } }, ref);
    if (!result) return null;
    const score = Math.round(Math.max(0, Math.min(100, result.score)));
    const verdict = score >= 70 ? "strong" : score >= 30 ? "possible" : "unlikely";
    return {
      score,
      verdict: result.verdict === verdict ? result.verdict : verdict,
      rationale: result.rationale.trim().slice(0, 300),
      flags: [...new Set((result.flags ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean))].slice(0, 8),
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
      outcomes?: Array<{ title: string; company: string; status: string; appliedOn: string }>;
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
            .map(outcome => `- [${outcome.status}] ${outcome.title} @ ${outcome.company} (applied ${outcome.appliedOn})`).join("\n"))
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
   * computes the score in code. An entry the model left out is asked for once more, and what is
   * still uncovered comes back with every row unverified: marked as unread, never guessed at.
   *
   * A batch that produces nothing usable at all fails the pass rather than returning zeros,
   * because a caller writing those zeros over the rules baseline would report a transport fault
   * as a judgement about the person's writing.
   */
  async reviewLibraryEntries(
    input: { library: CvLibrary; entries: CvEntry[]; model?: string },
    ref: { userId: string; refType: "library"; refId: string; signal?: AbortSignal },
    hooks: LibraryReviewHooks = {},
  ): Promise<LibraryEntryReview[]> {
    if (!input.entries.length) return [];
    // The whole library, as written, including the entries this pass is not reviewing: an entry is
    // judged for what it adds to the record, which needs the rest of the record in view.
    const evidence = P.wrap("library", P.truncate(libraryEvidenceText(input.library), 120_000));
    const batches: CvEntry[][] = [];
    for (let offset = 0; offset < input.entries.length; offset += LIBRARY_REVIEW_BATCH)
      batches.push(input.entries.slice(offset, offset + LIBRARY_REVIEW_BATCH));

    // One controller for the pass: a batch that fails cancels its siblings, and so does the run's
    // signal or the caller's, so a task that has been given up on stops paying for the rest.
    const controller = batchController([this.options.signal, hooks.signal, ref.signal]);

    const ask = (entries: CvEntry[], missing: string[] | undefined, onStart: (() => void) | undefined,
      onRecord: (record: AiUsageRecord) => void) => this.run<LibraryReviewPlan>(PROMPTS.A12, {
      user: {
        stable: [evidence],
        tail: P.wrap("entries_under_review", entriesUnderReview(input.library, entries)) + (missing?.length
          ? `\n\nYour previous answer left these entries out. Return each of them exactly once, with every row classified: ${missing.join(", ")}.`
          : ""),
      },
      ...(input.model ? { model: input.model } : {}),
      signal: controller.signal,
      onStart,
      onRecord,
      // A re-run is a second charge for one batch, and the difference between a pass that asked
      // twice and one that simply had many batches. Name it separately.
    }, { ...ref, stage: missing ? "review_retry" : "review" });

    const reviewBatch = async (entries: CvEntry[], index: number, onStart?: () => void): Promise<LibraryEntryReview[]> => {
      const say = async (phase: LibraryReviewBatchEvent["phase"], extra: Partial<LibraryReviewBatchEvent> = {}) => {
        try {
          await hooks.onBatch?.({ index, total: batches.length, phase, entries: entries.length, ...extra });
        } catch (err) {
          this.log("library review batch hook failed", err);
        }
      };
      await say("start");
      let usage: AiUsageRecord | undefined;
      let plan = await ask(entries, undefined, onStart, record => { usage = record; });
      let uncovered = plan ? entries.filter(entry => !plan!.entries.some(said => said.entryId === entry.id)) : entries;
      if (uncovered.length) {
        await say("retry", { usage, uncovered: uncovered.length });
        const again = await ask(entries, uncovered.map(entry => entry.id), undefined, record => { usage = record; });
        if (!plan && !again) {
          await say("failed", { usage, uncovered: uncovered.length });
          throw new BatchFailed();
        }
        if (again) {
          const already = new Set(plan?.entries.map(said => said.entryId) ?? []);
          plan = { entries: [...(plan?.entries ?? []), ...again.entries.filter(said => !already.has(said.entryId))] };
          uncovered = entries.filter(entry => !plan!.entries.some(said => said.entryId === entry.id));
        }
      }
      const said = new Map(plan!.entries.map(entry => [entry.entryId, entry]));
      // Every entry is answered for, covered or not: an entry the model never mentioned reads as
      // rows nobody classified, which is what the Library shows as unread rather than as absent.
      // So does one whose answer asked the person about a demographic attribute: that answer is
      // refused for that entry alone, which keeps its rules baseline and asks about it again next
      // pass, instead of throwing away every other entry the pass read.
      const unread = (entry: CvEntry) => validateLibraryReview(entry, { entryId: entry.id, rows: [], prompts: [] });
      const reviews = entries.map(entry => {
        const answer = said.get(entry.id);
        if (!answer) return unread(entry);
        if (answer.prompts.some(prompt => mentionsDemographicAttribute(prompt))) {
          this.log("library review asked about a demographic attribute; entry left unread", { entryId: entry.id });
          return unread(entry);
        }
        return validateLibraryReview(entry, answer);
      });
      await say("done", { usage, ...(uncovered.length ? { uncovered: uncovered.length } : {}) });
      return reviews;
    };

    const results: LibraryEntryReview[][] = [];
    const pending: Promise<void>[] = [];
    try {
      // The cache entry is readable only once the first response has begun; batches sent before
      // then would each write their own copy of the library. So the first goes alone until then.
      let begun!: () => void;
      const firstBegun = new Promise<void>(resolve => { begun = resolve; });
      let firstFailed = false;
      const first = reviewBatch(batches[0]!, 0, () => begun()).then(result => { results[0] = result; });
      pending.push(first);
      await Promise.race([firstBegun, first.then(() => undefined, () => { firstFailed = true; })]);
      if (firstFailed) await first;
      batches.slice(1).forEach((batch, index) => {
        pending.push(reviewBatch(batch, index + 1).then(result => { results[index + 1] = result; }));
      });
      await Promise.all(pending);
    } catch (err) {
      // Without every batch the pass is incomplete: stop paying for the rest, then let them record.
      controller.siblingFailed();
      await Promise.allSettled(pending);
      throw err instanceof BatchFailed
        ? new Error("The evidence review returned nothing usable for one batch of entries.")
        : err;
    } finally {
      controller.release();
    }
    return results.flat();
  }
}

type CvEntry = CvLibrary["entries"][number];

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

/** The batch: which entries to classify now, whose they are, and their rows verbatim. */
function entriesUnderReview(library: CvLibrary, entries: CvEntry[]): string {
  return entries.map(entry => {
    const job = library.employment?.find(item => item.id === entry.employmentId);
    return [
      `Entry [${entry.id}] (${entry.kind})`,
      job ? `Company: ${job.company}` : null,
      job ? `Title: ${job.jobTitle}` : null,
      `Heading: ${entry.heading}`,
      "Rows:",
      ...reviewableRows(entry).map(row => `- ${row}`),
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
    const line = `- [${d.decision}] ${d.title} @ ${d.company}${d.location ? ` (${d.location})` : ""}${reason ? ` — ${reason}` : ""}${tags}`;
    if (used + line.length + 1 > maxChars) break;
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

export function createAiEngine(options: AiEngineOptions): AiEngine {
  return new AiEngine(options);
}
