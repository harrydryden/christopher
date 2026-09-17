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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function priceFor(model: string): { input: number; output: number; cacheRead?: number } {
  return PRICING[model] ?? PRICING[model.replace(/-\d{8}$/, "")] ?? FALLBACK;
}

/**
 * What a CV build is expected to cost, for admitting it against the budget. Calibrated on recorded
 * builds of a 35 KB library against a 7.7 KB description, which cost $3.0–3.4 on Fable 5.1: the
 * rubric reads the description and writes about 4.5k tokens; the author reads the library and
 * description and writes 8–16k; the assessment writes the CV-sized context to the cache once,
 * reads it back for the other four batches, and writes about 7k tokens a batch. A hold at the
 * calls' ceilings instead refused builds the month could plainly afford, and only part-way through.
 */
export function estimateCvBuildUsd(model: string, size: { libraryBytes: number; descriptionBytes: number }): number {
  const description = size.descriptionBytes / 3;
  const library = size.libraryBytes / 3;
  const batches = 5;
  return estimateCostUsd(model, {
    inputTokens: description + (library + description) + batches * 2_500,
    cacheWriteTokens: library + 3_000,
    cacheReadTokens: (batches - 1) * library,
    outputTokens: 4_500 + 12_000 + batches * 7_000,
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
