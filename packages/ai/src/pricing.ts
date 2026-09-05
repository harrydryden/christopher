/** USD per million tokens. Check against Anthropic's pricing page before relying on the numbers. */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
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

export function priceFor(model: string): { input: number; output: number } {
  return PRICING[model] ?? PRICING[model.replace(/-\d{8}$/, "")] ?? FALLBACK;
}

/** Cache reads cost a tenth of input; cache writes cost 1.25x. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  const perToken = price.input / 1_000_000;
  const cost =
    usage.inputTokens * perToken +
    usage.cacheReadTokens * perToken * 0.1 +
    usage.cacheWriteTokens * perToken * 1.25 +
    usage.outputTokens * (price.output / 1_000_000);
  return Number(cost.toFixed(6));
}
