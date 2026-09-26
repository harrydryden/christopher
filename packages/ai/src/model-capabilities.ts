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
