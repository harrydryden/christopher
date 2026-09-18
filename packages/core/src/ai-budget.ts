/**
 * Which AI spend counts towards a budget, and what to call the work that spent it.
 *
 * There is one budget and it is an account's: monthly, set by its holder or by an administrator.
 * It keeps no running total; it is the sum of that account's `ai_calls` rows inside its window, so
 * a counter is "reset" by moving the window rather than by deleting anything, and Health can still
 * show every call that was ever made. Work no account asked for (extraction, discovery) counts
 * towards no budget.
 */

/**
 * The instant a monthly budget starts counting from: the later of the start of the current UTC
 * month and the account's recorded reset. A missing or unusable marker means the month start, so a
 * corrupt setting can never widen a budget beyond the month it belongs to.
 */
export function aiBudgetWindowStart(now: Date, resetAt: string | null | undefined): Date {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (typeof resetAt !== "string" || !resetAt.trim()) return monthStart;
  const reset = new Date(resetAt);
  if (Number.isNaN(reset.getTime())) return monthStart;
  return reset.getTime() > monthStart.getTime() ? reset : monthStart;
}

/**
 * What a call site is called in a report. The call sites are the spec's A1–A10 plus the CV
 * builder; a reader of a spend table should see the feature they recognise, not the code.
 */
export const AI_FEATURE_LABELS: Readonly<Record<string, string>> = {
  CV: "CV builder",
  A1: "Discovery",
  A2: "Discovery",
  A3: "Extraction",
  A4: "Description clean-up",
  A5: "Role scoring",
  A6: "Reason tagging",
  A7: "Preference profile",
  A8: "Filter suggestions",
  A9: "Company profiling",
  A10: "Company suggestions",
};

/** A short product name for one call site; an unknown call site is reported as itself. */
export function aiFeatureLabel(callSite: string): string {
  return AI_FEATURE_LABELS[callSite.trim().toUpperCase()] ?? callSite;
}
