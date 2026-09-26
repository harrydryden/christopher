/**
 * The shape of a build's ledger as the interface reads it, including what the worker writes that
 * the shared types do not describe yet.
 *
 * The interface deploys separately from the worker, so it reads the ledger defensively whatever the
 * types say: every figure is optional, an unknown motion falls back to its own title, and an
 * unknown stage to its raw name. This module is the one place that widening is written down.
 *
 * Client-safe: type imports only, so the narrative can render in the browser without pulling the
 * core package's parsers into the bundle.
 */
import type { CvBuildFailure, CvBuildStepStatus, CvBuildStepView } from "@ava/core";

// TODO(merge P2): `adopt_revision` joins `CV_BUILD_MOTIONS` in packages/core/src/cv-build.ts with
// the improvement pass that now runs after the baseline is published. Until then it is a string
// the narrative recognises by name.
export type CvJournalMotion = CvBuildStepView["motion"] | "adopt_revision";

// TODO(merge P2): `failure.batch` is set by the worker on a failed assessment batch.
export type CvJournalFailure = CvBuildFailure & { batch?: number };

/**
 * One step as the narrative reads it. `motion` and `stage` are widened to strings because a worker a
 * release ahead can write a motion this build of the interface has never heard of.
 */
export interface CvJournalStep {
  id: string;
  seq: number;
  attempt: number;
  // TODO(merge P2): `CvBuildStepView.taskId`, which the ledger already stores in `task_id`.
  /** The queue row that ran this attempt: a manual retry is a new task starting again at attempt 1. */
  taskId?: string | null;
  stage: string;
  motion: string;
  title: string;
  status: CvBuildStepStatus;
  startedAt: Date;
  finishedAt: Date | null;
  ms: number | null;
  detail: Record<string, unknown>;
  error: string | null;
  failure: CvJournalFailure | null;
}

/** What crosses the wire for one step: the same fields with the moments as ISO strings. */
export interface CvJournalStepWire extends Omit<CvJournalStep, "startedAt" | "finishedAt"> {
  startedAt: string;
  finishedAt: string | null;
}

export function stepToWire(step: CvJournalStep): CvJournalStepWire {
  return { ...step, startedAt: step.startedAt.toISOString(), finishedAt: step.finishedAt ? step.finishedAt.toISOString() : null };
}

export function stepFromWire(step: CvJournalStepWire): CvJournalStep {
  return { ...step, startedAt: new Date(step.startedAt), finishedAt: step.finishedAt ? new Date(step.finishedAt) : null };
}

/** The part of a step the ledger's signature is made of: whether it is open, and when it last moved. */
export interface CvStepMoment {
  status: CvBuildStepStatus;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * The ledger's signature from rows in hand: how many motions there are, how many are open, and the
 * last moment any of them moved — UTC, to the millisecond, the form `readCvProgress` renders in SQL.
 * The progress feed answers the signature of the whole ledger; a reader whose own rows sign
 * differently has missed something and reads the ledger again whole.
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

/** The rows in hand with a delta laid over them, in ledger order; `replace` starts from the delta alone. */
export function mergeSteps(current: readonly CvJournalStep[], delta: readonly CvJournalStep[], replace = false): CvJournalStep[] {
  const byId = new Map<string, CvJournalStep>(replace ? [] : current.map((step) => [step.id, step]));
  for (const step of delta) byId.set(step.id, step);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}
