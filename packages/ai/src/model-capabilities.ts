/** Anthropic effort compatibility, checked 20 September 2026 against:
 * https://platform.claude.com/docs/en/build-with-claude/effort
 * Haiku supports structured output but does not accept output_config.effort.
 * Unknown/legacy models must not receive an unsupported optional parameter.
 */
const EFFORT_MODELS = new Set([
  "claude-fable-5", "claude-fable-5-1", "claude-mythos-preview", "claude-mythos-5", "claude-mythos-5-1",
  "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
  "claude-sonnet-4-6", "claude-sonnet-5",
]);

export function modelSupportsEffort(model: string): boolean {
  return EFFORT_MODELS.has(model.replace(/-\d{8}$/, ""));
}

/**
 * Models whose requests may carry the server-side refusal fallback (`fallbacks: "default"` under
 * the `server-side-fallback-2026-07-01` beta): the ones that run safety classifiers and publish
 * fallback targets. Anything else is sent without it, since the parameter is validated per model.
 */
const SERVER_FALLBACK_MODELS = new Set(["claude-fable-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5", "claude-opus-5-5"]);

export function modelSupportsServerFallback(model: string): boolean {
  return SERVER_FALLBACK_MODELS.has(model.replace(/-\d{8}$/, ""));
}
