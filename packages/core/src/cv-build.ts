import type { CvRubric } from "./cv-assessment";

/**
 * The motions of a CV build, in the order they run, and how each is spoken of to the person
 * watching. The worker records one step per motion in `cv_build_steps`; the CV page reads them
 * back as a narrative under the milestone strip; Operations aggregates them by motion. The four
 * milestones on the page are the `stage` each motion belongs to.
 */
export const CV_BUILD_STAGES = ["preparing", "analysing", "writing", "fitting", "assessing", "publishing"] as const;
export type CvBuildStage = (typeof CV_BUILD_STAGES)[number];

export const CV_BUILD_MOTIONS = {
  load_inputs: { stage: "preparing", title: "Reading your Library and the role" },
  admit_budget: { stage: "preparing", title: "Reserving this build's share of your AI budget" },
  rubric: { stage: "analysing", title: "Extracting the role's requirements" },
  write: { stage: "writing", title: "Writing the CV" },
  check_plan: { stage: "writing", title: "Checking the writer kept every role and qualification" },
  measure: { stage: "fitting", title: "Measuring the PDF against your page limit" },
  shorten: { stage: "fitting", title: "Trimming lower-priority wording to fit" },
  rewrite: { stage: "fitting", title: "Rewriting to a smaller budget" },
  assess_batch: { stage: "assessing", title: "Checking requirements and claims against your evidence" },
  assess_retry: { stage: "assessing", title: "Re-checking a batch whose evidence was misattributed" },
  assemble: { stage: "assessing", title: "Scoring the CV" },
  publish: { stage: "publishing", title: "Saving the CV" },
} as const satisfies Record<string, { stage: CvBuildStage; title: string }>;
export type CvBuildMotion = keyof typeof CV_BUILD_MOTIONS;

export const CV_BUILD_STEP_STATUSES = ["running", "done", "failed", "skipped"] as const;
export type CvBuildStepStatus = (typeof CV_BUILD_STEP_STATUSES)[number];

/**
 * Why a build stopped, named so the system knows whether to try again on its own and the person
 * knows what, if anything, is theirs to change. Every failure the worker can see maps to one of
 * these; `unknown` is the honest name for the rest.
 */
export const CV_FAILURE_KINDS = [
  // The person can resolve these; retrying without a change repeats the failure.
  "budget_exhausted",
  "library_invalid",
  "page_limit_unfittable",
  "description_unusable",
  "model_access",
  "refused",
  // The system resolves these by trying again, resuming from what the build already has.
  "rate_limited",
  "overloaded",
  "connection",
  "stalled",
  "output_limit",
  "output_invalid",
  "assessment_incomplete",
  "worker_interrupted",
  "unknown",
] as const;
export type CvFailureKind = (typeof CV_FAILURE_KINDS)[number];

/** What the page offers the person for a failure that is theirs to resolve. */
export type CvFailureAction =
  | "raise_budget"
  | "fix_library"
  | "shorten_or_raise_pages"
  | "paste_description"
  | "check_model_access"
  | "choose_model"
  | "retry";

export interface CvFailurePolicy {
  /** Who can make the next attempt succeed. `nobody` means the failure is final for this draft. */
  resolvedBy: "system" | "user";
  /** Whether the queue should try again on its own, with the build resuming from its checkpoint. */
  retryable: boolean;
  /** A short, plain name for the failure, used as the narrative's heading. */
  title: string;
  /** The person's way forward, when there is one. */
  action?: CvFailureAction;
}

export const CV_FAILURE_POLICIES: Record<CvFailureKind, CvFailurePolicy> = {
  budget_exhausted: { resolvedBy: "user", retryable: false, title: "Not enough AI budget", action: "raise_budget" },
  library_invalid: { resolvedBy: "user", retryable: false, title: "The Library cannot be written from", action: "fix_library" },
  page_limit_unfittable: { resolvedBy: "user", retryable: false, title: "The CV cannot fit your page limit", action: "shorten_or_raise_pages" },
  description_unusable: { resolvedBy: "user", retryable: false, title: "The job description cannot be used", action: "paste_description" },
  model_access: { resolvedBy: "user", retryable: false, title: "The CV model cannot be reached", action: "check_model_access" },
  refused: { resolvedBy: "user", retryable: false, title: "The model declined this request", action: "retry" },
  rate_limited: { resolvedBy: "system", retryable: true, title: "The model provider asked us to slow down" },
  overloaded: { resolvedBy: "system", retryable: true, title: "The model provider is overloaded" },
  connection: { resolvedBy: "system", retryable: true, title: "The connection to the model provider dropped" },
  stalled: { resolvedBy: "system", retryable: true, title: "The model stopped responding" },
  output_limit: { resolvedBy: "system", retryable: true, title: "The model ran out of room for its answer", action: "choose_model" },
  output_invalid: { resolvedBy: "system", retryable: true, title: "The model's answer could not be used", action: "retry" },
  assessment_incomplete: { resolvedBy: "system", retryable: true, title: "The assessment missed part of the CV", action: "retry" },
  worker_interrupted: { resolvedBy: "system", retryable: true, title: "The worker was interrupted" },
  unknown: { resolvedBy: "user", retryable: false, title: "The build failed", action: "retry" },
};

/**
 * The record a failed build leaves on its draft: what went wrong, whose move it is, and what the
 * system did or the person should do. `attempt` and `maxAttempts` are the queue's, so the page can
 * say "retrying, attempt 2 of 3" as well as "gave up after 3".
 */
export interface CvBuildFailure {
  kind: CvFailureKind;
  resolvedBy: CvFailurePolicy["resolvedBy"];
  retryable: boolean;
  action?: CvFailureAction;
  /** One sentence in the reader's words, with the figures that matter (amounts, pages, batch). */
  message: string;
  /** The motion that failed. */
  motion?: CvBuildMotion;
  attempt?: number;
  maxAttempts?: number;
  /** When the queue will try again, for a failure the system is resolving. */
  retryAt?: string;
  /** The raw reason, for Operations; never shown as the person's explanation. */
  cause?: string;
}

/**
 * A failure of `kind`, with its policy applied and the figures the page needs.
 *
 * `extra` may also override `resolvedBy`, `retryable` and `action`, because two kinds change hands
 * with repetition rather than being one thing always: a model that ran out of room, or declined,
 * is worth one more attempt by the system, and after that it is the person who has to choose a
 * different model or reword the role. The kind stays what it was — what happened did not change —
 * so Operations still counts them together.
 */
export function cvBuildFailure(
  kind: CvFailureKind,
  message: string,
  extra: Partial<Omit<CvBuildFailure, "kind" | "message">> = {},
): CvBuildFailure {
  const policy = CV_FAILURE_POLICIES[kind];
  return { kind, resolvedBy: policy.resolvedBy, retryable: policy.retryable, ...(policy.action ? { action: policy.action } : {}), message, ...extra };
}

/**
 * What a build has already paid for, kept on the draft so a retry resumes instead of starting
 * over: the rubric (one model call), and the moment the written CV was saved (the dearest call).
 * A retry with a rubric here skips the rubric call; one whose draft carries content that still
 * fits its page limit skips writing and re-runs only the assessment.
 */
export interface CvBuildCheckpoint {
  rubric?: CvRubric;
  rubricAt?: string;
  contentAt?: string;
  /** The queue attempt that wrote the checkpoint, so a resumed build can say what it reused. */
  attempt?: number;
}

/** One step of a build as the page and Operations read it. */
export interface CvBuildStepView {
  id: string;
  seq: number;
  attempt: number;
  stage: CvBuildStage;
  motion: CvBuildMotion;
  title: string;
  status: CvBuildStepStatus;
  startedAt: Date;
  finishedAt: Date | null;
  ms: number | null;
  /** Figures the narrative renders after the title: counts, pages, batch position, cost. */
  detail: Record<string, unknown>;
  error: string | null;
  failure: CvBuildFailure | null;
}
