/**
 * Text helpers with no Node dependency, so a module that runs in the browser (the evidence rubric)
 * can share them with the server-side scorers. `normalize.ts` re-exports them beside the helpers
 * that need `node:crypto`.
 */

/**
 * Text compared as a person reads it: compatibility forms folded (NFKC), every run of whitespace
 * one space, trimmed. What quote anchoring, row matching and facet matching all compare.
 */
export function normaliseText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** `value` as a literal inside a regular expression. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
