/**
 * The decisions a CV build makes before and around its model calls, none of which need a database.
 *
 * Which rubric a revision is measured against, what a refused budget tells the person, what a call
 * cost, and how an assessment landed: all of it used to sit inside the worker's handler, where the
 * only way to reach it was to drain a real queue. It is pure, so it belongs here with tests of its
 * own.
 */
import type { CvBuildCheckpoint } from "./cv-build";
import type { CvReviewPlan } from "./cv-assessment";

/** Which limit refused a hold, and the figures it was measured against. */
export interface AiBudgetRefusal {
  limit: "account" | "day" | "discovery";
  limitUsd: number;
  /** Recorded spend within the limit's window. */
  spent: number;
  /** Held by calls in flight. */
  held: number;
}

/**
 * Why work was not admitted, with the figures behind it, so the reader can tell a cap from a fault.
 *
 * The account's own budget is the one the person who asked for the work is told about plainly: it
 * is theirs, it is monthly, and they can raise it themselves. Capacity held by their own calls in
 * flight is named when there is any, because a second build started while the first is running is
 * the ordinary way to meet it. The deployment's optional day and discovery caps are the operator's
 * and live in the worker's environment, so a refusal by one of those says so instead.
 *
 * `subject` names what was refused, in the grammar of the sentence: "This build", or the feature
 * label of whichever call site asked.
 */
export function aiBudgetRefusalMessage(subject: string, expectedUsd: number, refusal: AiBudgetRefusal): string {
  const left = Math.max(0, refusal.limitUsd - refusal.spent - refusal.held);
  const needs = `${subject} needs about $${expectedUsd.toFixed(2)} of AI budget;`;
  const held = refusal.held > 0 ? ` after $${refusal.held.toFixed(2)} held by calls in flight` : "";
  if (refusal.limit === "account")
    return `${needs} your budget of $${refusal.limitUsd} has $${left.toFixed(2)} left this month${held} (it resets on the 1st). Raise it on Settings, or ask an administrator.`;
  return `${needs} the deployment's ${refusal.limit === "day" ? "daily" : "discovery"} AI cap of $${refusal.limitUsd} has $${left.toFixed(2)} left${held}. An administrator can raise it in the worker's environment; then retry.`;
}

export type CvRubricSource = { jobDescription: string; assessment: { rubric: unknown } | null };

/**
 * The rubric a revision is assessed against stays fixed for its job description: the one its task
 * carries, else its parent's for the same description, else its own from an earlier assessment.
 * A parent that failed before assessing, or that the rolling archive has removed, must not cost a
 * fresh rubric that would move the goalposts between revisions.
 */
export function reusableCvRubric(draft: CvRubricSource, parent: CvRubricSource | undefined, supplied: unknown): unknown {
  return supplied ?? (parent?.jobDescription === draft.jobDescription ? parent.assessment?.rubric : undefined) ?? draft.assessment?.rubric;
}

/**
 * Which source supplied a rubric this build does not have to pay for, named so the narrative can
 * say which. A checkpoint comes first: it is this build's own earlier attempt, already validated
 * against this description, and the cheapest thing a retry can skip.
 */
export function reusedCvRubric(
  draft: CvRubricSource & { buildCheckpoint?: CvBuildCheckpoint | null },
  parent: CvRubricSource | undefined,
  supplied: unknown,
): { reused: "checkpoint" | "parent" | "assessment"; rubric: unknown } | null {
  if (draft.buildCheckpoint?.rubric) return { reused: "checkpoint", rubric: draft.buildCheckpoint.rubric };
  // A rubric on the task is the parent revision's, carried so that retention deleting the parent
  // cannot move the goalposts; to the reader it is the same thing as the parent's own.
  const inherited = reusableCvRubric(draft, parent, supplied);
  if (!inherited) return null;
  return { reused: inherited === draft.assessment?.rubric && !supplied ? "assessment" : "parent", rubric: inherited };
}

/** Money as the narrative shows it: enough precision for a batch that cost a fifth of a cent. */
export const usd = (value: number) => Number(value.toFixed(4));

/** What one model call consumed, as the engine records it. Structural, so core stays free of the engine. */
export interface CvCallUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What a call consumed, for the step that made it. Tokens are every token it was billed for. */
export function callCost(usage: CvCallUsage | undefined): { usd?: number; tokens?: number } {
  if (!usage) return {};
  return {
    usd: usd(usage.costUsd),
    tokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
  };
}

/** The assessment in one line of figures: how the requirements landed and how the claims held up. */
export function assessmentTally(review: CvReviewPlan): {
  demonstrated: number; partial: number; missing: number; unknown: number;
  supported: number; unsupported: number; uncertain: number;
} {
  const count = <T extends string>(values: T[], value: T) => values.filter(item => item === value).length;
  const matches = review.matches.map(match => match.status);
  const claims = review.claims.map(claim => claim.status);
  return {
    demonstrated: count(matches, "demonstrated"), partial: count(matches, "partial"),
    missing: count(matches, "missing"), unknown: count(matches, "unknown"),
    supported: count(claims, "supported"), unsupported: count(claims, "unsupported"),
    uncertain: count(claims, "uncertain"),
  };
}
