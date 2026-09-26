import type { CvRubric } from "./cv-assessment";
import type { CvTailoringPlan } from "./cv-tailoring";

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
  plan_evidence: { stage: "analysing", title: "Matching the role to your strongest confirmed evidence" },
  gap_quiz: { stage: "analysing", title: "Preparing a few optional evidence questions" },
  improve_content: { stage: "assessing", title: "Strengthening important evidence the first draft missed" },
  compare_content: { stage: "assessing", title: "Checking the revision improves coverage without weakening your CV" },
  /**
   * The last motion of a build whose optional improvement ran after the baseline was published:
   * the stronger candidate saved as a new revision of the same chain, or the original kept.
   */
  adopt_revision: { stage: "publishing", title: "Deciding whether to adopt the stronger revision" },
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

/** What a model call cost the step that made it. Only steps that made one carry these. */
export type CvStepCost = { usd?: number; tokens?: number };

/** One writing attempt: what it was allowed, and what it produced. */
type CvWritingDetail = CvStepCost & {
  attempt?: number; budgetCharacters?: number; budgetScale?: number; maxPages?: number;
  roles?: number; bullets?: number; characters?: number;
  /**
   * Set only on a `write` recorded as `skipped`: the wording was already written by an earlier
   * attempt of this build and saved with its checkpoint, so nothing was paid for. `attempt` is then
   * the writing attempt (1-3) that produced the reused wording.
   */
  reused?: "checkpoint";
  /**
   * A `rewrite` only: why the previous attempt did not stand. `overflow` is a measured PDF over the
   * page limit, `layout_error` a layout the renderer could not place at all; `pages` and `maxPages`
   * are that previous measurement. Absent on a rewrite asked for by a correction instead.
   */
  reason?: "overflow" | "layout_error";
  pages?: number;
  /**
   * A `rewrite` asked for because the previous answer was unusable as written (a wrong skill
   * format, an evidence reference that does not exist, a repeated section): how many corrections
   * the writer was given. Carries no `reason`, because nothing was measured.
   */
  corrections?: number;
};

/** Which audit a batch or a score belongs to: the baseline's, or the optional revision's re-check. */
export type CvAuditPass = "draft" | "revision";

/**
 * The figures each motion records, named per motion.
 *
 * The ledger stores `detail` as one jsonb object, so for a while every call site could put
 * anything in it and the interface had to guess what a motion carried. This is the vocabulary:
 * one entry per motion, every key optional because a step gathers its figures as it goes (opened
 * with what is known, closed with what it learnt). The journal is generic over the motion, so a
 * figure written under the wrong motion does not compile. A count that would be zero is left out
 * rather than written, so the page never prints "0 claims".
 */
export type CvBuildStepDetails = {
  load_inputs: {
    libraryVersion?: number; descriptionCharacters?: number; mode?: "build" | "assess" | "improve";
    roles?: number; qualifications?: number; skillBlocks?: number;
    reusedRubric?: boolean; reusedContent?: boolean;
    /** The queue row's attempt ceiling, beside the attempt the step already carries. */
    maxAttempts?: number;
  };
  /**
   * One admission per stage, taken inside the account's budget lock immediately before the stage
   * runs. `stage` names it (rubric, plan, write, audit, improve, reaudit); `heldUsd` is what the
   * account's other work in flight holds, excluding this stage's own hold.
   */
  admit_budget: {
    stage?: CvBuildStageName; expectedUsd?: number; limitUsd?: number; heldUsd?: number; leftUsd?: number;
    /** Closed `skipped` with this when an optional stage after publication was refused: the original stands. */
    reason?: string;
  };
  rubric: CvStepCost & {
    reused?: "checkpoint" | "parent" | "assessment";
    requirements?: number; essential?: number; desirable?: number; responsibilities?: number;
  };
  /** Recorded as `skipped` with `reused: true` when the plan came from this build's checkpoint. */
  plan_evidence: CvStepCost & { requirements?: number; supported?: number; questions?: number; reused?: boolean };
  gap_quiz: { questions?: number; skipped?: boolean };
  /**
   * The optional improvement's writing call. Done: `opportunities`, the evidence gaps it was asked
   * to close. Closed `skipped` with `kept: true` and a neutral `reason` when the call failed or
   * its answer was unusable: the published original stands, and that is not a failure.
   */
  improve_content: CvStepCost & { opportunities?: number; skipped?: boolean; reason?: string; kept?: boolean };
  compare_content: { accepted?: boolean; reasons?: string[] };
  /**
   * Done: the stronger revision was saved as a new revision of the same chain - its id, revision
   * number, daily version and the name the page shows it by ("26-Sep-V3"). Skipped: the original
   * was kept, and `reason` says why in a sentence ("Kept the original: <reason>").
   */
  adopt_revision: {
    /** The adopted revision's own draft: the page links to `/cv/<draftId>`. `revisionId` is the same id. */
    draftId?: string; revisionId?: string; revision?: number; version?: number;
    /** The name the page shows the revision by; `name` is the same text. */
    label?: string; name?: string; reason?: string;
  };
  write: CvWritingDetail;
  /** A second or third writing attempt against a smaller budget; the same figures as `write`. */
  rewrite: CvWritingDetail;
  check_plan: { omitted?: string[]; skillFormatCorrections?: number };
  /**
   * Opened before the PDF is rendered, closed with what it measured. `renders` counts the PDFs
   * rendered to reach the answer (the fitter bisects over trims); `outcome` is `fits`, `overflow`
   * (still over the limit after trimming), or `layout_error` (nothing could be placed).
   */
  measure: { pages?: number; maxPages?: number; renders?: number; outcome?: "fits" | "overflow" | "layout_error" };
  shorten: { removed?: number; pages?: number; changes?: string[] };
  /**
   * `pass` says which audit the batch belongs to. A batch cancelled because a sibling failed closes
   * `skipped` with `cancelled: true`; the failed batch closes `failed` with the error and failure
   * on the step itself.
   */
  assess_batch: CvStepCost & {
    batch?: number; batches?: number; requirements?: number; claims?: number;
    /** The same position as `batch` of `batches`, one-based, under the names the page reads. */
    index?: number; of?: number;
    pass?: CvAuditPass; cancelled?: boolean;
  };
  /** `index` is `batch` again, one-based, under the name the page reads. */
  assess_retry: CvStepCost & { batch?: number; index?: number; corrections?: number; pass?: CvAuditPass };
  /** `reused: true` (status `skipped`) when a published baseline's assessment was taken as it stood. */
  assemble: {
    pageCount?: number;
    demonstrated?: number; partial?: number; missing?: number; unknown?: number;
    supported?: number; unsupported?: number; uncertain?: number;
    reused?: boolean; pass?: CvAuditPass;
  };
  /**
   * Closed inside the transaction that makes the CV ready. `reservedUsd` is what this attempt's
   * stages were admitted at in all; `spentUsd` is what the whole build has recorded, every attempt.
   */
  publish: { revision?: number; archivedPrevious?: boolean; reservedUsd?: number; spentUsd?: number };
};

/**
 * The stages a build admits against the budget, one hold each, in the order they run. The audit is
 * one admission for all of its batches still to run; `improve` and `reaudit` run after publication.
 */
export const CV_BUILD_STAGE_NAMES = ["rubric", "plan", "write", "audit", "improve", "reaudit"] as const;
export type CvBuildStageName = (typeof CV_BUILD_STAGE_NAMES)[number];

/** The figures one motion records; every motion's when the motion is not yet known. */
export type CvBuildStepDetail<M extends CvBuildMotion = CvBuildMotion> = CvBuildStepDetails[M];

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
  /** The assessment batch that failed, one-based, when the failure was one batch's. */
  batch?: number;
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
 * One stage's saved result: the key it was made under (a hash of its inputs, the prompt set and
 * the model), when, and the value a resumed attempt reuses instead of paying for it again.
 */
export interface CvStageCheckpoint {
  key: string;
  at: string;
  value: unknown;
}

/**
 * What a build has already paid for, kept on the draft so a retry resumes instead of starting
 * over.
 *
 * Version 2 keeps one entry per stage under `stages`, each with the key it was made under, and
 * pins the prompt set that made them: a build resumed after a redeploy reuses only what the same
 * prompts produced. The version 1 flags remain beside it, written as mirrors, because the interface
 * reads `rubric`, `rubricAt` and `contentAt` to say what a retry will not pay for again, and copies
 * the task-intent fields (`mode`, `improvements`, `sourceRubric`, `tailoringEnabled`,
 * `quizCompleted`) onto a retried or continued draft. A version 1 checkpoint - no `v` - is read as
 * it always was.
 */
export interface CvBuildCheckpoint {
  /** 2 for a checkpoint written with per-stage entries; absent on a version 1 checkpoint. */
  v?: 2;
  /** The prompt set the stage entries were made by. */
  promptSetVersion?: string;
  /** Per-stage results, by stage name: rubric, plan, write, and audit[i] for each batch. */
  stages?: Record<string, CvStageCheckpoint>;
  /** New builds opt into planned shaping; legacy checkpoints remain readable. */
  tailoringEnabled?: boolean;
  tailoringPlan?: CvTailoringPlan;
  quizCompleted?: boolean;
  /**
   * Version 1 only: set before spending on the single optional revision, so retries never repeat
   * it. Version 2 publishes the baseline first and improves after, on the same task, so there is
   * nothing to fence: a retry of a published build is skipped.
   */
  improvementAttempted?: boolean;
  rubric?: CvRubric;
  rubricAt?: string;
  contentAt?: string;
  /** The queue attempt that wrote the checkpoint, so a resumed build can say what it reused. */
  attempt?: number;
  /**
   * What the revision's own task asked for, kept for its retries. A rebuild is queued with its
   * parent's rubric and the improvements to make; a direct edit with its parent's rubric and
   * `assess`. "Retry generation" queues a fresh task that knows only the draft, and the rolling
   * archive can have removed the parent by then, so without these a retried rebuild paid for a new
   * rubric and was written as a plain build, and a retried direct edit was rewritten from the
   * Library instead of keeping the person's wording.
   */
  mode?: "improve" | "assess";
  improvements?: string[];
  sourceRubric?: CvRubric;
}

/**
 * A stored checkpoint as the worker reads it: version 2 as written, version 1 as it always was.
 *
 * A version 2 checkpoint made by a different prompt set keeps only what the task asked for - the
 * mode, the improvements, the parent's rubric, the tailoring and quiz flags - and drops every paid
 * result, including the version 1 mirrors of them, so nothing the old prompts produced is reused.
 * A version 1 checkpoint predates the pin and is trusted as it was, so the builds in flight at the
 * release that introduces version 2 are not paid for twice.
 */
export function readCvBuildCheckpoint(
  raw: CvBuildCheckpoint | null | undefined,
  promptSetVersion: string,
): { checkpoint: CvBuildCheckpoint; discarded: boolean } {
  const stored = raw ?? {};
  if (stored.v !== 2 || stored.promptSetVersion === promptSetVersion)
    return { checkpoint: { ...stored, v: 2, promptSetVersion, stages: { ...(stored.stages ?? {}) } }, discarded: false };
  const { tailoringEnabled, quizCompleted, mode, improvements, sourceRubric } = stored;
  return {
    checkpoint: {
      v: 2, promptSetVersion, stages: {},
      ...(tailoringEnabled !== undefined ? { tailoringEnabled } : {}),
      ...(quizCompleted !== undefined ? { quizCompleted } : {}),
      ...(mode ? { mode } : {}), ...(improvements ? { improvements } : {}), ...(sourceRubric ? { sourceRubric } : {}),
    },
    discarded: true,
  };
}

/** One step of a build as the page and Operations read it. */
export interface CvBuildStepView {
  id: string;
  seq: number;
  attempt: number;
  /** The queue row this step's attempt ran under; absent on rows read by an older reader. */
  taskId?: string | null;
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
