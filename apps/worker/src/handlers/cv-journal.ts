import type { CvBuildFailure, CvBuildMotion, CvBuildStepStatus } from "@christopher/core";
import { failOpenCvBuildSteps, finishCvBuildStep, schema, startCvBuildStep, type Db } from "@christopher/db";
import { eq } from "drizzle-orm";
import { log } from "../log";

type Detail = Record<string, unknown>;
type Closed = Exclude<CvBuildStepStatus, "running">;

/** A step that is open: more figures can be merged into it until it closes. */
export interface CvJournalStep {
  add(detail: Detail): void;
}

/**
 * A step this process opened and will close.
 *
 * `id` is null when the ledger refused the row. Closing such a step does nothing and the build
 * carries on regardless: an account of the work must never become part of it.
 */
export class CvOpenStep implements CvJournalStep {
  readonly gathered: Detail = {};
  constructor(readonly id: string | null) {}
  add(detail: Detail): void {
    Object.assign(this.gathered, detail);
  }
}

export interface CvJournalOptions {
  db: Db;
  draftId: string;
  userId: string;
  taskId: string | null;
  /** The queue attempt these steps belong to, so a resumed build's steps are distinguishable. */
  attempt: number;
  now: () => Date;
  /**
   * Run whenever a step closes. The build's AI reservation outlives its longest model call only
   * because something renews it, and a step closing is the one moment that is always the build
   * genuinely advancing.
   */
  onClose?: () => Promise<void>;
}

/**
 * The build's own account of itself: one row per motion, written as it happens.
 *
 * A CV build is seven model calls and several minutes, and it used to report four stage names and
 * the moment it last advanced. That was enough to tell a slow build from a dead one and nothing
 * else: not which of five assessment batches was slow, not what the second writing attempt was
 * given, not what the trimming removed, not what any of it cost. Each motion is written down as it
 * starts and finishes, with the figures behind it, and the CV page reads the rows back as a
 * narrative while the build runs.
 *
 * Nothing here may fail a build. Every write is attempted, logged if it fails, and forgotten.
 * `run` is the exception only in that it lets the *work's* error through — and it deliberately
 * leaves the step open when it does, because the build's own catch closes everything still running
 * with the failure classified, and that is the only place that knows what kind of failure it was.
 */
export class CvJournal {
  /** Steps this journal opened and has not closed, so a failure can close them with their figures. */
  private readonly running = new Set<CvOpenStep>();
  /**
   * Ledger writes run one after another, however concurrent the work they describe is.
   *
   * A step takes the next `seq` for its draft, and the assessment runs its batches together: two
   * overlapping inserts would read the same maximum and land on the same number, leaving the page
   * to order two rows that claim the same place. The writes are short and off the critical path,
   * so queueing them costs nothing and the narrative comes out in the order it happened.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CvJournalOptions) {}

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Open a step. Never throws; a ledger that refused the row gives a step with a null id. */
  async open(motion: CvBuildMotion, detail: Detail = {}, title?: string): Promise<CvOpenStep> {
    return this.queued(async () => {
      try {
        const id = await startCvBuildStep(this.options.db, {
          draftId: this.options.draftId,
          userId: this.options.userId,
          taskId: this.options.taskId,
          attempt: this.options.attempt,
          motion,
          ...(title ? { title } : {}),
          detail,
        });
        const step = new CvOpenStep(id);
        this.running.add(step);
        return step;
      } catch (error) {
        log.warn("CV build step could not be opened", { draftId: this.options.draftId, motion, error: (error as Error).message });
        return new CvOpenStep(null);
      }
    });
  }

  /** Close a step with its outcome and whatever figures it gathered. Never throws. */
  async close(
    step: CvOpenStep | null | undefined,
    status: Closed,
    detail: Detail = {},
    outcome: { error?: string; failure?: CvBuildFailure } = {},
  ): Promise<void> {
    if (step) this.running.delete(step);
    await this.queued(async () => {
      if (!step?.id) return;
      try {
        await finishCvBuildStep(this.options.db, step.id, {
          status,
          detail: { ...step.gathered, ...detail },
          error: outcome.error ?? null,
          failure: outcome.failure ?? null,
        });
      } catch (error) {
        log.warn("CV build step could not be closed", { draftId: this.options.draftId, error: (error as Error).message });
      }
    });
    await this.progressed();
  }

  /**
   * One motion that begins and ends in the same breath: a rubric taken from a checkpoint, a plan
   * checked, a measurement read. Opened and closed together so the narrative still has its row.
   */
  async record(motion: CvBuildMotion, detail: Detail, status: Closed = "done", title?: string): Promise<void> {
    await this.close(await this.open(motion, detail, title), status);
  }

  /** Run `work` as one motion, closing the step with anything `work` added to it. */
  async run<T>(
    motion: CvBuildMotion,
    detail: Detail,
    work: (step: CvJournalStep) => Promise<T>,
    options: { title?: string; status?: Closed } = {},
  ): Promise<T> {
    const step = await this.open(motion, detail, options.title);
    const result = await work(step);
    await this.close(step, options.status ?? "done");
    return result;
  }

  /**
   * Close everything still running for this draft with the failure that ended the build.
   *
   * This journal's own steps are closed one at a time so each keeps the figures it had gathered —
   * the budget a refused build was measured against, the batch a failed audit was on — which a
   * blanket sweep would throw away. The sweep still runs afterwards, for a step left behind by an
   * attempt whose process is gone.
   */
  async failOpen(error: string, failure?: CvBuildFailure): Promise<void> {
    for (const step of [...this.running]) await this.close(step, "failed", {}, { error: error.slice(0, 1000), failure });
    await failOpenCvBuildStepsQuietly(this.options.db, this.options.draftId, error, failure);
    await this.progressed();
  }

  /**
   * The draft's last sign of life, moved on by every step that closes.
   *
   * A stage lasts as long as its model calls, and the longest of them run for minutes; without
   * this a build that died with its process was indistinguishable from one still thinking, for
   * hours. Never throws: a missed mark must not fail a build that is otherwise fine.
   */
  private async progressed(): Promise<void> {
    try {
      await this.options.db.update(schema.cvDrafts).set({ progressAt: this.options.now() })
        .where(eq(schema.cvDrafts.id, this.options.draftId));
    } catch (error) {
      log.warn("CV progress mark failed", { draftId: this.options.draftId, error: (error as Error).message });
    }
    try {
      await this.options.onClose?.();
    } catch (error) {
      log.warn("CV build hold renewal failed", { draftId: this.options.draftId, error: (error as Error).message });
    }
  }
}

/**
 * Close a draft's open steps without letting the ledger fail the caller.
 *
 * Shared with the abandonment paths, which run when the worker that owned those steps is gone:
 * a crash, a deadline, a lost lease. They are recoveries, and a recovery that throws over a
 * narrative row would leave the draft it was cleaning up worse off than it found it.
 */
export async function failOpenCvBuildStepsQuietly(db: Db, draftId: string, error: string, failure?: CvBuildFailure): Promise<number> {
  try {
    return await failOpenCvBuildSteps(db, draftId, error.slice(0, 1000), failure);
  } catch (err) {
    log.warn("CV build steps could not be closed", { draftId, error: (err as Error).message });
    return 0;
  }
}
