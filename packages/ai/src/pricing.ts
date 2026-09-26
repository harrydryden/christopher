import { EFFORT_OUTPUT_SCALE, PROMPTS, expectedOutputTokens, resolveRoute, routedModel, type CacheTtl, type PromptEntry, type PromptId, type StageRoutes } from "./prompt-registry";

/**
 * USD per million tokens. Check against Anthropic's pricing page before relying on the numbers.
 * A cache read costs a tenth of input unless the model prices it separately.
 */
export const PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const FALLBACK_MODEL = "claude-opus-5";
const FALLBACK = PRICING[FALLBACK_MODEL]!;

/**
 * Server-side tools are billed per request, on top of the tokens their results add to the turn.
 * Web search is $10 per 1,000 searches; web fetch is not charged per request. Only A10 and the
 * newsletter extraction ask for a tool, but a search-heavy suggestion round is the dearest thing
 * the deployment does, so leaving it out understates exactly the call site that needs watching.
 * Check against Anthropic's pricing page before relying on the number.
 */
export const SERVER_TOOL_USD: Record<string, number> = {
  web_search_requests: 10 / 1_000,
};

/** What the model's server-side tool calls cost, from the `server_tool_use` block of its usage. */
export function serverToolCostUsd(use: Record<string, unknown> | null | undefined): number {
  if (!use) return 0;
  let cost = 0;
  for (const [field, price] of Object.entries(SERVER_TOOL_USD)) {
    const requests = use[field];
    if (typeof requests === "number" && Number.isFinite(requests) && requests > 0) cost += requests * price;
  }
  return Number(cost.toFixed(6));
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Every token written to the cache, whatever the entry's lifetime. */
  cacheWriteTokens: number;
  /**
   * The part of `cacheWriteTokens` written to an hour-long entry (`usage.cache_creation
   * .ephemeral_1h_input_tokens`), billed at twice input; the rest are five-minute writes at 1.25x.
   */
  cacheWrite1hTokens?: number;
}

export function priceFor(model: string): { input: number; output: number; cacheRead?: number } {
  return PRICING[model] ?? PRICING[model.replace(/-\d{8}$/, "")] ?? FALLBACK;
}

/** How many assessment batches a calibrated build is expected to run. */
const CV_ASSESSMENT_BATCHES = 5;

/**
 * How many times one writing pass may call the author: the fitter rewrites when the pages
 * overflow, up to three attempts (`buildFittedCv` in core). The build is held for all three.
 */
export const CV_FITTER_ATTEMPTS = 3;

/** The most one author call is calibrated to write: recorded two-page builds reach 15.6k. */
const CV_AUTHOR_OUTPUT_TOKENS = 16_000;

/** What a CV build is measured in: the two inputs every one of its calls is sized from. */
export interface CvBuildSize {
  libraryBytes: number;
  descriptionBytes: number;
}

/**
 * Which calls of a build are still to come.
 *
 * `all` is a build starting from nothing. `assessment` is a retry resuming from a checkpoint that
 * already carries the written CV: the rubric and the author have been paid for and will not run
 * again, so holding the whole build's estimate against the account would refuse a resumption the
 * month can plainly afford — and hold roughly three times what the attempt can spend.
 */
export type CvBuildParts = "all" | "assessment" | "tailored" | "tailored_completion" | "tailored_assessment";

/** The tokens each part of a build is calibrated at, so the parts always add up to the whole. */
function cvBuildUsage(size: CvBuildSize, parts: CvBuildParts): TokenUsage {
  const description = size.descriptionBytes / 3;
  const library = size.libraryBytes / 3;
  const batches = CV_ASSESSMENT_BATCHES;
  // The audit writes the evidence, rubric and CV to the cache once and reads them back for the
  // other batches; each batch sends its own slice of the rubric and writes about 7k tokens. The
  // evidence and rubric are an hour-long entry, so they outlive the writer and serve the re-audit;
  // the CV is a five-minute one.
  const assessment: TokenUsage = {
    inputTokens: batches * 2_500,
    cacheWriteTokens: library + 3_000,
    cacheWrite1hTokens: library,
    cacheReadTokens: (batches - 1) * library,
    outputTokens: batches * 7_000,
  };
  if (parts === "assessment") return assessment;
  return {
    // The rubric reads the description; each of the fitter's author calls reads the library and
    // the description again, and writes up to the calibrated most a call writes.
    inputTokens: description + CV_FITTER_ATTEMPTS * (library + description) + assessment.inputTokens,
    cacheWriteTokens: assessment.cacheWriteTokens,
    cacheWrite1hTokens: assessment.cacheWrite1hTokens,
    cacheReadTokens: assessment.cacheReadTokens,
    outputTokens: 4_500 + CV_FITTER_ATTEMPTS * CV_AUTHOR_OUTPUT_TOKENS + assessment.outputTokens,
  };
}

/**
 * What a CV build may cost, for admitting it against the budget. Calibrated on recorded builds of
 * a 35 KB library against a 7.7 KB description, which cost $3.0–3.4 on Fable 5.1: the rubric reads
 * the description and writes about 4.5k tokens; the author reads the library and description and
 * writes 8–16k; the assessment writes the CV-sized context to the cache once, reads it back for
 * the other four batches, and writes about 7k tokens a batch. A hold at the calls' ceilings (32k
 * a write) refused builds the month could plainly afford, and only part-way through.
 *
 * The writing is held at the fitter's worst case, though: three author calls at the calibrated
 * most a call writes. Held at one call, a build that had to rewrite twice spent several dollars
 * beyond what it was admitted at, and two such builds at once put a month past its budget. The
 * hold is taken off as each call is recorded, so the margin costs nothing once it is spent.
 *
 * `parts` narrows it to what a resumed attempt has left to pay for: on that calibration the audit
 * alone is about two thirds of a build, and the share is derived from the same figures rather than
 * written down as a fraction that could drift away from them.
 */
export function estimateCvBuildUsd(model: string, size: CvBuildSize, parts: CvBuildParts = "all", routes?: StageRoutes | null): number {
  // A stage the administrator has routed to another model is priced at that model. With none
  // routed away, the whole build is priced at the one model, exactly as it always was.
  // A stage routed to another effort writes more or less (`EFFORT_OUTPUT_SCALE`); its input is unchanged.
  const stages = cvBuildStages(size, parts);
  const scale = (id: PromptId) => EFFORT_OUTPUT_SCALE[resolveRoute(PROMPTS[id], routes).effort] / EFFORT_OUTPUT_SCALE[PROMPTS[id].effort];
  if (stages.some(([id]) => cvStageModel(id, model, routes) !== model || scale(id) !== 1))
    return Number(stages.reduce((sum, [id, usage]) =>
      sum + estimateCostUsd(cvStageModel(id, model, routes), { ...usage, outputTokens: usage.outputTokens * scale(id) }), 0).toFixed(6));
  if (parts === "tailored" || parts === "tailored_completion" || parts === "tailored_assessment") {
    const library = size.libraryBytes / 3;
    const description = size.descriptionBytes / 3;
    const planning = estimateCostUsd(model, { inputTokens: library + description + 1500, outputTokens: 6000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const rubric = estimateCostUsd(model, { inputTokens: description, outputTokens: 4500, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const writingAndAudit = estimateCostUsd(model, cvBuildUsage(size, "all")) - rubric;
    if (parts === "tailored_assessment") {
      // The first author call is checkpointed, but its audit may still discover an opportunity.
      return estimateCostUsd(model, cvBuildUsage(size, "assessment")) + writingAndAudit;
    }
    // Includes one optional revision and re-check. The pause releases the hold; continuing only
    // reserves the remaining work. New quiz evidence may require one fresh evidence plan.
    return writingAndAudit * 2 + planning + (parts === "tailored" ? rubric + planning : 0);
  }
  return estimateCostUsd(model, cvBuildUsage(size, parts));
}

/** The model one CV stage runs on: its administrator route when it has one, the build's model otherwise. */
export function cvStageModel(id: PromptId, cvModel: string, routes?: StageRoutes | null): string {
  return routedModel(resolveRoute(PROMPTS[id], routes), { cvModel }, cvModel);
}

/**
 * The same calibration as `cvBuildUsage`, split by the stage that spends it, so each stage can be
 * priced at its own model. The parts add up to the whole: a resumed audit is the review alone; a
 * tailored build writes twice (the draft and the one optional improvement) and audits twice (the
 * draft and the improved candidate), and plans once more after the quiz.
 */
function cvBuildStages(size: CvBuildSize, parts: CvBuildParts): Array<[PromptId, TokenUsage]> {
  const description = size.descriptionBytes / 3;
  const library = size.libraryBytes / 3;
  const none = { cacheReadTokens: 0, cacheWriteTokens: 0 };
  const review = cvBuildUsage(size, "assessment");
  const rubric: TokenUsage = { inputTokens: description, outputTokens: 4_500, ...none };
  const author: TokenUsage = { inputTokens: CV_FITTER_ATTEMPTS * (library + description), outputTokens: CV_FITTER_ATTEMPTS * CV_AUTHOR_OUTPUT_TOKENS, ...none };
  const planning: TokenUsage = { inputTokens: library + description + 1500, outputTokens: 6000, ...none };
  if (parts === "assessment") return [["cv.review", review]];
  if (parts === "all") return [["cv.rubric", rubric], ["cv.author", author], ["cv.review", review]];
  const improvement: Array<[PromptId, TokenUsage]> = [["cv.improvement", author], ["cv.review_candidate", review]];
  if (parts === "tailored_assessment") return [["cv.review", review], ...improvement];
  const completion: Array<[PromptId, TokenUsage]> = [["cv.author", author], ["cv.review", review], ...improvement, ["cv.planning", planning]];
  return parts === "tailored" ? [...completion, ["cv.rubric", rubric], ["cv.planning", planning]] : completion;
}

/** What one stage is measured in, for admitting it on its own. */
export interface StageSizes {
  /** Bytes of the stable blocks the entry's layout declares, in order. Default: none. */
  stableBytes?: readonly number[];
  /** Bytes of the volatile tail each call sends (the system prompt is added from the entry). */
  tailBytes: number;
  /** How many calls of this entry the stage makes: an audit's batches, the fitter's attempts. Default 1. */
  calls?: number;
  /** What each call writes; defaults to the entry's calibrated `expectedOutputTokens` at its routed effort. */
  outputTokens?: number;
}

/** What the symbolic models of a route stand for, and the administrator's routes. */
export interface StageModels {
  /** The account's CV model, for an entry routed to `cvModel`. */
  cvModel?: string;
  /** The deployment's model for the entry's call site, for an entry routed to `callSite`. */
  callSiteModel?: string;
  routes?: StageRoutes | null;
}

/**
 * What one stage is expected to cost, at the model it is routed to, for admitting it on its own.
 *
 * Priced by the entry's cache layout: on the first call, every token up to a breakpoint is written
 * at that breakpoint's lifetime (twice input for an hour, 1.25x for five minutes) and every later
 * call reads it back; whatever follows the last breakpoint, and the tail, is sent at full price
 * each time. English runs about four bytes a token, so a third of the byte count leaves headroom.
 */
export function estimateStage(entry: PromptEntry, sizes: StageSizes, models: StageModels = {}): number {
  const route = resolveRoute(entry, models.routes);
  const model = routedModel(route, { cvModel: models.cvModel, callSite: models.callSiteModel }, FALLBACK_MODEL);
  const calls = Math.max(1, Math.round(sizes.calls ?? 1));
  const tokens = (bytes: number) => Math.max(0, bytes) / 3;
  const segments: Array<{ tokens: number; ttl: CacheTtl | null }> = [
    { tokens: tokens(Buffer.byteLength(entry.system)), ttl: entry.cacheLayout.system },
    ...entry.cacheLayout.stable.map((ttl, index) => ({ tokens: tokens(sizes.stableBytes?.[index] ?? 0), ttl })),
  ];
  // Each segment is cached under the next breakpoint at or after it; after the last, nothing is.
  let written5m = 0, written1h = 0, uncached = tokens(sizes.tailBytes);
  let pending = 0;
  for (const segment of segments) {
    pending += segment.tokens;
    if (!segment.ttl) continue;
    if (segment.ttl === "1h") written1h += pending; else written5m += pending;
    pending = 0;
  }
  uncached += pending;
  const cached = written5m + written1h;
  return estimateCostUsd(model, {
    inputTokens: calls * uncached,
    cacheWriteTokens: cached,
    cacheWrite1hTokens: written1h,
    cacheReadTokens: (calls - 1) * cached,
    // At the effort the stage is routed to: a lower effort writes less, and output is the dear part.
    outputTokens: calls * (sizes.outputTokens ?? expectedOutputTokens(entry, route.effort)),
  });
}

/**
 * What reading one document into a Library proposal is expected to cost, for admitting it against
 * the budget.
 *
 * One call, nothing cached: the document goes in whole and the answer copies the parts of it that
 * are employment, responsibilities, qualifications and skills. The output is therefore a fraction
 * of the input rather than a multiple of it — a two-page CV of about 6 KB proposes a few hundred
 * tokens of rows, and the 40 KB ceiling an import row stores is roughly 13k tokens in and at most
 * the call's own cap out. Held at that cap rather than at the expected answer, because a budget
 * that refuses after the call has been made has refused nothing.
 */
export function estimateLibraryImportUsd(model: string, size: { documentBytes: number }): number {
  const document = Math.max(0, size.documentBytes) / 3;
  return estimateCostUsd(model, {
    inputTokens: document + 1_200,
    // A long career copied twice — each row and the quote behind it — under the call's ceiling.
    outputTokens: Math.min(16_000, Math.max(1_500, document / 2)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

/** Entries per A12 batch. Mirrors `LIBRARY_REVIEW_BATCH` in @ava/core. */
const LIBRARY_REVIEW_BATCH = 8;

/** What a library evidence review is measured in: the library itself and how much of it to review. */
export interface LibraryReviewSize {
  libraryBytes: number;
  /** Entries this pass will review — every entry on a first pass, one after a typo fix. */
  entryCount: number;
}

/**
 * What an A12 evidence review is expected to cost, for admitting it against the budget.
 *
 * Shaped like the CV assessment above, because it is the same motion: the whole library and the
 * instructions are written to the cache once and read back by every later batch, and each batch of
 * eight entries then sends only the entries it is about. It runs on `effort: "low"` — it
 * classifies rows and asks questions, it does not reason its way to a judgement — which is why the
 * output is a few hundred tokens an entry rather than the seven thousand a batch an assessment
 * writes. On a 45 KB library of ten entries on Fable 5.1 that is about $0.43 for the whole pass.
 *
 * A one-entry pass is dominated by that cached write, not by the entry: re-reviewing one entry
 * still has to put the library in front of the model. That is the reason the task reviews a whole
 * library at once rather than firing per entry, and the reason an unchanged entry is answered from
 * its stored review instead of being asked about again.
 */
export function estimateLibraryReviewUsd(model: string, size: LibraryReviewSize): number {
  if (size.entryCount <= 0) return 0;
  const library = size.libraryBytes / 3;
  const batches = Math.ceil(size.entryCount / LIBRARY_REVIEW_BATCH);
  const cached = library + 1_500;
  return estimateCostUsd(model, {
    // Each batch names its entries and their rows; the library behind them is read from the cache.
    inputTokens: batches * 1_200,
    cacheWriteTokens: cached,
    cacheReadTokens: (batches - 1) * cached,
    outputTokens: size.entryCount * 400,
  });
}

/** What a five-minute cache write costs, as a multiple of input. */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
/** What an hour-long cache write costs, as a multiple of input. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/**
 * What a call's tokens cost. Cache writes are priced by lifetime: the hour-long part at twice
 * input, the rest at 1.25x. A usage with no split is all five-minute writes, which is what every
 * row recorded before the split existed was.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  const perToken = price.input / 1_000_000;
  const cacheReadPerToken = (price.cacheRead ?? price.input * 0.1) / 1_000_000;
  const hour = Math.min(Math.max(0, usage.cacheWrite1hTokens ?? 0), usage.cacheWriteTokens);
  const cost =
    usage.inputTokens * perToken +
    usage.cacheReadTokens * cacheReadPerToken +
    (usage.cacheWriteTokens - hour) * perToken * CACHE_WRITE_5M_MULTIPLIER +
    hour * perToken * CACHE_WRITE_1H_MULTIPLIER +
    usage.outputTokens * (price.output / 1_000_000);
  return Number(cost.toFixed(6));
}
