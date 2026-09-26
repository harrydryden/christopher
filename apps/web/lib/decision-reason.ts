/**
 * Spec R-6.1: a reason is required for `skip`, and encouraged (never required) for `apply`.
 *
 * Shared by the decision actions, which enforce it, and the roles table, which checks it before
 * sending so that the common refusal never takes a row off the page only to put it back.
 */
export const SKIP_REASON_REQUIRED = "Give a reason when you dismiss a role: it is what the ranking learns from.";

/** The sentence a decision is refused with for want of a reason, or null when it has what it needs. */
export function missingDecisionReason(decision: "apply" | "skip" | null, reason: string): string | null {
  return decision === "skip" && reason.trim().length === 0 ? SKIP_REASON_REQUIRED : null;
}
