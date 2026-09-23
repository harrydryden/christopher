/**
 * Telling a slow CV build from a stopped one — and, when it has stopped, whose move it is.
 *
 * A build is a chain of model calls that can legitimately take twenty minutes, so elapsed time
 * says nothing on its own. What separates the two is whether anything has happened lately: the
 * worker stamps `progress_at` on every stage change and every model call that returns, and the
 * task row says whether anything is still trying. During the October incident the CV page showed a
 * spinner for two and a half hours over a build whose process had died twenty seconds in.
 *
 * A build that stops now also leaves a `failure` on its draft: what went wrong, whose move it is,
 * and when the queue will try again. That record decides two further phases — `retrying`, which
 * the system is resolving on its own, and `failed`, which is waiting for the person to change
 * something — so the page has one state machine for a build's whole life, not two.
 *
 * Pure, so the page renders one named state and the wording lives in one place.
 */
import {
  CV_FAILURE_POLICIES,
  type CvBuildCheckpoint,
  type CvBuildFailure,
  type CvBuildStepStatus,
  type CvFailureAction,
  type CvFailureKind,
} from "@ava/core";
import { formatClock } from "./format";

/** No progress for this long, while a task is still running, is worth saying out loud. */
export const CV_PROGRESS_STALE_MS = 10 * 60_000;

/**
 * The token the CV page's existing poll compares. It changes when the build changes state, when it
 * advances, when a motion of it opens or closes, when a failure is recorded — and once a minute
 * while none of that happens, so "last progress 12 minutes ago" and "running 46 s" keep counting on
 * a page that is otherwise waiting for something that will never come. One mechanism, not two:
 * `/api/work-status` and the page must produce the same string for the same rows, so both assemble
 * it here — the poll through `cvWorkVersionFor` in lib/queries/cv.ts, which has only the draft's
 * id, and the page from the steps it has already read.
 */
export function cvWorkVersion(
  draft: { status: string; buildStage: string | null; progressAt: Date | null; createdAt: Date; failure?: CvBuildFailure | null },
  now: Date = new Date(),
  /** `cvBuildStepsSignature`: the count, the open steps and the last moment any of them moved. */
  stepsSignature = "",
): string {
  const since = (draft.progressAt ?? draft.createdAt).getTime();
  const minutes = Math.max(0, Math.floor((now.getTime() - since) / 60_000));
  // The kind and the attempt together: a second attempt failing the same way is still a change.
  const failure = draft.failure ? `${draft.failure.kind}:${draft.failure.attempt ?? ""}` : "";
  return `${draft.status}:${draft.buildStage ?? ""}:${since}:${minutes}:${failure}:${stepsSignature}`;
}

/** The part of a step the version token is made of: whether it is open, and when it last moved. */
export interface CvStepMoment {
  status: CvBuildStepStatus;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * The ledger's part of the version token, from rows the page already has: how many motions there
 * are, how many are open, and the last moment any of them moved.
 *
 * The page renders the steps, so it must not query for a signature of the rows in front of it; the
 * poll has only the draft's id, so `/api/work-status` keeps the aggregate query in
 * `cvBuildStepsSignature`. Both go through this canonical form — UTC, to the millisecond —
 * because the two strings are compared against each other: the SQL one renders
 * `timestamptz::text`, which carries microseconds in the database's own timezone, and a page whose
 * version never matched the poll's would refresh itself every ten seconds for ever.
 */
export function cvStepsSignature(steps: readonly CvStepMoment[]): string {
  let running = 0;
  let last = 0;
  for (const step of steps) {
    if (step.status === "running") running++;
    last = Math.max(last, (step.finishedAt ?? step.startedAt).getTime());
  }
  return `${steps.length}:${running}:${last ? new Date(last).toISOString() : ""}`;
}

/** `cvBuildStepsSignature`'s string reduced to what `cvStepsSignature` produces for the same rows. */
export function normaliseCvStepsSignature(signature: string): string {
  // The moment is the third field and carries colons of its own, so it is split off by position.
  const counts = signature.indexOf(":", signature.indexOf(":") + 1);
  if (counts === -1) return signature;
  const moment = signature.slice(counts + 1);
  if (!moment) return signature;
  const at = new Date(moment);
  return `${signature.slice(0, counts + 1)}${Number.isNaN(at.getTime()) ? moment : at.toISOString()}`;
}

export interface CvBuildTask {
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  maxAttempts: number;
  error: string | null;
  startedAt: Date | null;
  /** The worker has not reported recently, so nothing queued is being picked up. */
  workerStopped?: boolean;
}

export interface CvBuildDraft {
  status: "queued" | "generating" | "awaiting_evidence" | "ready" | "failed";
  buildStage: string | null;
  error: string | null;
  createdAt: Date;
  progressAt: Date | null;
  /** The structured record of why the last attempt stopped, when there is one. */
  failure?: CvBuildFailure | null;
  /** What the build already paid for, so the page can say a retry will not pay for it again. */
  buildCheckpoint?: CvBuildCheckpoint | null;
}

/** What a queued build says while no worker is running. */
export const CV_WORKER_STOPPED_MESSAGE =
  "The background worker is not running, so this build has not started. It stays queued and starts when the worker is back; an administrator can see why in Operations.";

export type CvBuildPhase = "waiting" | "progressing" | "stalled" | "retrying" | "stopped" | "failed";

export interface CvBuildState {
  phase: CvBuildPhase;
  /** Moment the build last advanced: a stage change or a model call returning. */
  lastProgressAt: Date;
  sinceProgressMs: number;
  /** One sentence naming the state, in the words the reader needs. */
  message: string;
  attempts: number | null;
  maxAttempts: number | null;
  /** Set when the phase is `stopped` and the task, not the draft, explained why. */
  taskError: string | null;
  /** The failure's heading, from its policy. Null when nothing recorded one. */
  title: string | null;
  failure: CvBuildFailure | null;
  /** The person's way forward, when the next move is theirs. Null while the system is handling it. */
  action: CvFailureAction | null;
  /** When the queue will try again, for a failure the system is resolving. */
  retryAt: Date | null;
  /** What a retry will not have to pay for again, when the build left a checkpoint. */
  resumeNote: string | null;
  /** The tone the header is written in: the four hues of the design system, by state. */
  tone: "blue" | "amber" | "red";
}

/** An ISO string from the worker, or null rather than an Invalid Date on the page. */
function parseMoment(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "A retry resumes from …", so nobody fears paying twice for a build that already ran the dear calls. */
function resumeNoteFor(checkpoint: CvBuildCheckpoint | null | undefined): string | null {
  if (!checkpoint) return null;
  const parts = [checkpoint.rubric ? "the requirements already extracted" : null, checkpoint.contentAt ? "the wording already written" : null].filter(
    (part): part is string => part !== null,
  );
  if (!parts.length) return null;
  return `A retry resumes from ${parts.join(" and ")}, so it does not pay for that again.`;
}

/**
 * How the retrying sentence opens for a kind the policy's title does not describe in the reader's
 * terms. A build the queue stops at its deadline is recorded as `worker_interrupted`, and "Attempt
 * 1 stopped: The worker was interrupted" is not what happened from where the person is sitting.
 */
const RETRY_OPENING: Partial<Record<CvFailureKind, string>> = {
  worker_interrupted: "ran out of time",
};

/**
 * `task` is the row with dedupe key `generate_cv:<draftId>`, or null when there is none — which is
 * itself a finding: a draft that says it is building with nothing queued to build it is stopped.
 * `timeZone` is the deployment's, for the clock time a retry is due at.
 */
export function cvBuildState(draft: CvBuildDraft, task: CvBuildTask | null, now: Date = new Date(), timeZone = "UTC"): CvBuildState {
  const lastProgressAt = draft.progressAt ?? task?.startedAt ?? draft.createdAt;
  const sinceProgressMs = Math.max(0, now.getTime() - lastProgressAt.getTime());
  const failure = draft.failure ?? null;
  // The kind's policy names the failure; the record itself says who resolves it, because a kind can
  // change hands with repetition (the system tries a refused prompt once, then it is the person's).
  const policyTitle = failure ? CV_FAILURE_POLICIES[failure.kind]?.title ?? "The build failed" : null;
  // A failure the queue has already moved past: the worker has claimed a later attempt, so the
  // record on the draft is history and the build is simply running again.
  const superseded = !!failure && task?.status === "running" && failure.attempt !== undefined && task.attempts > failure.attempt;
  // Which attempt is being spoken of. The failure's, because it is the attempt that stopped — but
  // not once a later one is running: "attempt 1 of 3" over a running attempt 2 is simply wrong.
  const attempts = (superseded ? null : failure?.attempt ?? null) ?? task?.attempts ?? null;
  const maxAttempts = (superseded ? null : failure?.maxAttempts ?? null) ?? task?.maxAttempts ?? null;
  const retryAt = parseMoment(failure?.retryAt);
  // A task handed back to the queue carries the message of the attempt that bounced — a lease
  // another worker was holding, most often. That is the queue talking to itself, never the
  // explanation of a build that stopped, so only a task the queue gave up on has one of those.
  const taskError = task?.status === "failed" ? task.error ?? null : null;
  const resumeNote = resumeNoteFor(draft.buildCheckpoint);
  const base = {
    lastProgressAt,
    sinceProgressMs,
    attempts,
    maxAttempts,
    taskError: null as string | null,
    title: null as string | null,
    failure,
    action: null as CvFailureAction | null,
    retryAt: null as Date | null,
    resumeNote: null as string | null,
    tone: "blue" as CvBuildState["tone"],
  };

  // The system is resolving it: the attempt stopped, the draft is still building, and the queue is
  // holding the next attempt. There is nothing for the person to do, so the page offers nothing.
  if (
    failure &&
    failure.resolvedBy === "system" &&
    !superseded &&
    (draft.status === "queued" || draft.status === "generating") &&
    (task?.status === "queued" || task?.status === "running")
  ) {
    const opening = RETRY_OPENING[failure.kind];
    const stopped = opening ? `Attempt ${attempts ?? 1} ${opening}.` : `Attempt ${attempts ?? 1} stopped: ${policyTitle}.`;
    const next = attempts === null ? "" : ` (attempt ${attempts + 1}${maxAttempts ? ` of ${maxAttempts}` : ""})`;
    return {
      ...base,
      phase: "retrying",
      tone: "amber",
      title: policyTitle,
      retryAt,
      resumeNote,
      message:
        retryAt && retryAt.getTime() > now.getTime()
          ? `${stopped} Retrying automatically at ${formatClock(retryAt, timeZone, false)}${next}.`
          : `${stopped} Waiting for the worker to pick this build up again.`,
    };
  }

  // The build is over and did not publish. Either the person has something to change, or the queue
  // spent every attempt it had on something it could not get past.
  if (draft.status === "failed") {
    const exhausted = failure?.resolvedBy === "system";
    const title = !policyTitle
      ? null
      : exhausted
        ? maxAttempts
          ? `Gave up after ${maxAttempts} attempts: ${policyTitle}`
          : `Gave up: ${policyTitle}`
        : policyTitle;
    return {
      ...base,
      phase: "failed",
      tone: "red",
      title,
      // Whoever the failure belongs to, a failed draft always has the retry path; a kind with its
      // own action names that instead, and the page shows the retry beside it.
      action: failure?.action ?? "retry",
      resumeNote,
      taskError,
      message: failure?.message ?? draft.error ?? "This build stopped before it finished.",
    };
  }

  // Nothing is going to finish this. Either the task failed, or it reported itself done without
  // publishing the draft, or the row is gone altogether.
  if (!task || task.status === "failed" || task.status === "done") {
    return {
      ...base,
      phase: "stopped",
      tone: "red",
      title: policyTitle,
      message: failure?.message ?? draft.error ?? "This build stopped before it finished.",
      taskError,
    };
  }

  // Queued while nothing is running to pick it up: only the worker builds CVs, so the build is
  // kept and starts when the worker is back, and the page says that rather than simply waiting.
  if (task.status === "queued" && task.workerStopped) {
    return { ...base, phase: "waiting", tone: "amber", message: CV_WORKER_STOPPED_MESSAGE };
  }

  // Queued and never claimed: the worker has not reached it yet, which is ordinary.
  if (task.status === "queued" && !task.startedAt) {
    return { ...base, phase: "waiting", message: "Waiting for the worker." };
  }

  if (sinceProgressMs >= CV_PROGRESS_STALE_MS) {
    const minutes = Math.floor(sinceProgressMs / 60_000);
    return {
      ...base,
      phase: "stalled",
      tone: "amber",
      message: `No progress for ${minutes} minutes. The worker may be restarting; an administrator can see why in Operations.`,
    };
  }

  // Handed back to the queue after a failed attempt, and waiting to be picked up again.
  if (task.status === "queued") {
    return { ...base, phase: "waiting", message: "Waiting for the worker to pick this build up again." };
  }
  return { ...base, phase: "progressing", message: "This build is running." };
}

export interface CvFailureWayForward {
  /** The links to put in front of the person, labelled with the action itself. */
  links: { label: string; href: string }[];
  /** What to say when the way forward is not theirs to take. */
  note: string | null;
  /** Whether to offer "Retry generation" — only ever on a failed, unfinalised draft. */
  retry: boolean;
  /** The sentence before the retry button when something has to change first. */
  retryNote: string | null;
}

/**
 * What the Content tab offers for a failure: the specific page that fixes it, and whether the
 * retry belongs beside it. A button that would always error is never rendered, so `canRetry` is
 * the caller's check of `assessCvDraft`'s preconditions — a failed draft that is not finalised.
 */
export function failureWayForward(
  action: CvFailureAction | null,
  context: { jobId?: string | null; admin?: boolean; canRetry?: boolean } = {},
): CvFailureWayForward {
  const canRetry = context.canRetry ?? false;
  const done = { retry: canRetry, retryNote: canRetry ? "When you have done that, retry generation." : null };
  switch (action) {
    case "raise_budget":
      return { links: [{ label: "Raise the AI budget", href: "/settings" }], note: null, ...done };
    case "fix_library":
      return { links: [{ label: "Open the Library", href: "/library" }], note: null, ...done };
    case "shorten_or_raise_pages":
      return {
        links: [
          { label: "Shorten the Library", href: "/library" },
          { label: "Raise the page limit", href: "/settings" },
        ],
        note: null,
        ...done,
      };
    case "paste_description":
      return {
        links: [{ label: "Paste the full job description", href: context.jobId ? `/applications?job=${context.jobId}` : "/applications" }],
        note: null,
        ...done,
      };
    case "check_model_access":
      // Models are a shared setting: an administrator can look, and nobody else can.
      return context.admin
        ? {
            links: [
              { label: "Check the CV model", href: "/admin/settings" },
              { label: "Open Operations", href: "/admin/health" },
            ],
            note: null,
            ...done,
          }
        : { links: [], note: "Ask an administrator to check this deployment's model access.", ...done };
    case "choose_model":
      return { links: [{ label: "Choose a different CV model", href: "/settings" }], note: null, ...done };
    case "retry":
      return { links: [], note: null, retry: canRetry, retryNote: null };
    default:
      return { links: [], note: null, retry: false, retryNote: null };
  }
}
