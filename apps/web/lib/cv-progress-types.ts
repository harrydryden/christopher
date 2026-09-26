/**
 * What `/api/cv/[id]/progress` answers, and what the CV page hands its live build component as the
 * first reading. Client-safe: types only.
 */
import type { CvBuildFailure } from "@ava/core";
import type { CvJournalStepWire } from "./cv-build-journal";

/** The build's state as the header renders it, with its moments as ISO strings. */
export interface CvProgressBuild {
  phase: "waiting" | "progressing" | "stalled" | "retrying" | "stopped" | "failed";
  message: string;
  title: string | null;
  tone: "blue" | "amber" | "red";
  attempts: number | null;
  maxAttempts: number | null;
  lastProgressAt: string;
  retryAt: string | null;
  taskError: string | null;
}

export interface CvProgressReading {
  /** The draft is queued or generating: the page is watching a build. */
  active: boolean;
  /**
   * Something is still writing to the ledger — a build in flight, or the improvement pass that
   * runs after the baseline is published — so the log keeps growing on a ready page.
   */
  live: boolean;
  /** `cvWorkVersion`: changes only on a transition the server has to render. */
  version: string;
  /** The build's phase while it has one; the draft's status once it is over. */
  phase: string;
  failure: CvBuildFailure | null;
  status: string;
  /** The stage column the worker writes, for a build that has recorded no motion yet. */
  stage: string | null;
  createdAt: string;
  build: CvProgressBuild | null;
  /** `cvStepsSignature` of the whole ledger: the client resynchronises when its own differs. */
  signature: string;
  /** The rows this reading carries: every row for the first reading, then only what moved. */
  steps: CvJournalStepWire[];
}
