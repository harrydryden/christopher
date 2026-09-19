/**
 * USD per million tokens. Check against Anthropic's pricing page before relying on the numbers.
 * A cache read costs a tenth of input unless the model prices it separately.
 */
export const PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const FALLBACK = PRICING["claude-opus-5"]!;

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
  cacheWriteTokens: number;
}

export function priceFor(model: string): { input: number; output: number; cacheRead?: number } {
  return PRICING[model] ?? PRICING[model.replace(/-\d{8}$/, "")] ?? FALLBACK;
}

/** How many assessment batches a calibrated build is expected to run. */
const CV_ASSESSMENT_BATCHES = 5;

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
export type CvBuildParts = "all" | "assessment";

/** The tokens each part of a build is calibrated at, so the parts always add up to the whole. */
function cvBuildUsage(size: CvBuildSize, parts: CvBuildParts): TokenUsage {
  const description = size.descriptionBytes / 3;
  const library = size.libraryBytes / 3;
  const batches = CV_ASSESSMENT_BATCHES;
  // The audit writes the evidence, rubric and CV to the cache once and reads them back for the
  // other batches; each batch sends its own slice of the rubric and writes about 7k tokens.
  const assessment: TokenUsage = {
    inputTokens: batches * 2_500,
    cacheWriteTokens: library + 3_000,
    cacheReadTokens: (batches - 1) * library,
    outputTokens: batches * 7_000,
  };
  if (parts === "assessment") return assessment;
  return {
    // The rubric reads the description; the author reads the library and the description.
    inputTokens: description + (library + description) + assessment.inputTokens,
    cacheWriteTokens: assessment.cacheWriteTokens,
    cacheReadTokens: assessment.cacheReadTokens,
    outputTokens: 4_500 + 12_000 + assessment.outputTokens,
  };
}

/**
 * What a CV build is expected to cost, for admitting it against the budget. Calibrated on recorded
 * builds of a 35 KB library against a 7.7 KB description, which cost $3.0–3.4 on Fable 5.1: the
 * rubric reads the description and writes about 4.5k tokens; the author reads the library and
 * description and writes 8–16k; the assessment writes the CV-sized context to the cache once,
 * reads it back for the other four batches, and writes about 7k tokens a batch. A hold at the
 * calls' ceilings instead refused builds the month could plainly afford, and only part-way through.
 *
 * `parts` narrows it to what a resumed attempt has left to pay for: on that calibration the audit
 * alone is about two thirds of a build, and the share is derived from the same figures rather than
 * written down as a fraction that could drift away from them.
 */
export function estimateCvBuildUsd(model: string, size: CvBuildSize, parts: CvBuildParts = "all"): number {
  return estimateCostUsd(model, cvBuildUsage(size, parts));
}

/** Entries per A12 batch. Mirrors `LIBRARY_REVIEW_BATCH` in @christopher/core. */
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

/** Cache writes cost 1.25x input (the five-minute entries this engine writes). */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  const perToken = price.input / 1_000_000;
  const cacheReadPerToken = (price.cacheRead ?? price.input * 0.1) / 1_000_000;
  const cost =
    usage.inputTokens * perToken +
    usage.cacheReadTokens * cacheReadPerToken +
    usage.cacheWriteTokens * perToken * 1.25 +
    usage.outputTokens * (price.output / 1_000_000);
  return Number(cost.toFixed(6));
}
