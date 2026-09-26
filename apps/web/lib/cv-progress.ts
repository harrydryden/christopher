/**
 * One reading of a CV build for the page and for its progress feed, assembled from the same rows by
 * the same function, so the token the page renders and the token the feed answers cannot disagree.
 *
 * Pure: the rows come from `readCvProgress` in lib/queries/cv.ts (one query) or from what the page
 * has already read.
 */
import type { CvBuildCheckpoint, CvBuildFailure } from "@ava/core";
import { stepToWire, type CvJournalStep } from "./cv-build-journal";
import { CV_PROGRESS_STALE_MS, cvBuildState, cvStepsSignature, cvWorkFlags, cvWorkVersion, type CvBuildDraft, type CvBuildTask } from "./cv-build-state";
import type { CvProgressReading } from "./cv-progress-types";

export interface CvProgressRows {
  draft: {
    status: CvBuildDraft["status"];
    buildStage: string | null;
    error: string | null;
    createdAt: Date;
    progressAt: Date | null;
    failure: CvBuildFailure | null;
    buildCheckpoint?: CvBuildCheckpoint | null;
  };
  /** The newest `generate_cv` row behind the draft, or null when there is none. */
  task: CvBuildTask | null;
  /** Any queue row naming this draft is still queued or running, whatever its type. */
  anyTaskActive: boolean;
  /** The steps this reading carries (all of them, or the delta). */
  steps: CvJournalStep[];
  /** `cvStepsSignature` of the whole ledger, canonical form. */
  signature: string;
}

/**
 * Whether the ledger is still growing after the build itself is over: a ready draft whose queue row
 * is still at work (the improvement pass runs after the baseline is published) or whose ledger has
 * a motion opened within the last ten minutes. An old open row is a process that died, not work.
 */
export function cvLedgerLive(rows: Pick<CvProgressRows, "draft" | "anyTaskActive" | "steps">, now: Date): boolean {
  if (rows.draft.status === "queued" || rows.draft.status === "generating") return true;
  if (rows.draft.status !== "ready") return false;
  if (rows.anyTaskActive) return true;
  return rows.steps.some((step) => step.status === "running" && now.getTime() - step.startedAt.getTime() < CV_PROGRESS_STALE_MS);
}

export function cvProgressReading(rows: CvProgressRows, now: Date = new Date(), timeZone = "UTC"): CvProgressReading {
  const { draft, task } = rows;
  const active = draft.status === "queued" || draft.status === "generating";
  const failed = draft.status === "failed";
  const state = active || failed ? cvBuildState(draft, task, now, timeZone) : null;
  return {
    active,
    live: cvLedgerLive(rows, now),
    version: cvWorkVersion(draft, cvWorkFlags(draft, task, now)),
    phase: state?.phase ?? draft.status,
    failure: draft.failure ?? null,
    status: draft.status,
    stage: draft.buildStage,
    createdAt: draft.createdAt.toISOString(),
    build: state
      ? {
          phase: state.phase,
          message: state.message,
          title: state.title,
          tone: state.tone,
          attempts: state.attempts,
          maxAttempts: state.maxAttempts,
          lastProgressAt: state.lastProgressAt.toISOString(),
          retryAt: state.retryAt ? state.retryAt.toISOString() : null,
          taskError: state.taskError,
        }
      : null,
    signature: rows.signature,
    steps: rows.steps.map(stepToWire),
  };
}

/** The ledger's signature from rows already in hand, for a reading built without the aggregate. */
export function signatureOf(steps: readonly CvJournalStep[]): string {
  return cvStepsSignature(steps);
}
