import { usd, type CvBuildFailure, type CvBuildMotion, type CvBuildStepDetails, type CvBuildStepStatus, type CvCallUsage } from "@ava/core";
import { failOpenCvBuildSteps, finishCvBuildStep, schema, startCvBuildStep, type Db } from "@ava/db";
import { eq } from "drizzle-orm";
import { LeaseLostError } from "../lease";
import { log } from "../log";

type Closed = Exclude<CvBuildStepStatus, "running">;

/**
 * Why a journal stopped: the draft was deleted while the build ran, this attempt is no longer the
 * one that owns the task, or the build's share of the budget was released out from under it. All
 * three mean the same thing to the build — stop, do not spend more — and differ only in what the
 * person is told.
 */
export type CvJournalLoss = "deleted" | "fenced" | "hold";

/** A step that is open: more figures can be merged into it until it closes. */
export interface CvJournalStep<M extends CvBuildMotion> {
  add(detail: CvBuildStepDetails[M]): void;
}

/**
 * A step this process opened and will close.
 *
 * `id` is null when the ledger refused the row. Closing such a step does nothing and the build
 * carries on regardless: an account of the work must never become part of it.
 */
export class CvOpenStep<M extends CvBuildMotion = CvBuildMotion> implements CvJournalStep<M> {
  readonly gathered: Record<string, unknown> = {};
  constructor(readonly id: string | null, readonly motion?: M) {}
  add(detail: CvBuildStepDetails[M]): void {
    Object.assign(this.gathered, detail);
  }
  /**
   * Charge a model call to this step, adding to whatever it has already been charged. Every call
   * the step made counts — one that failed, or was cancelled part-way, cost what it consumed — so
   * a step's cost is complete however it ends, not only when it ends well.
   */
  addCost(usage: CvCallUsage): void {
    const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    this.gathered.usd = usd(Number(this.gathered.usd ?? 0) + usage.costUsd);
    this.gathered.tokens = Number(this.gathered.tokens ?? 0) + tokens;
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
   * The fence this attempt writes behind: it refuses the write once the task belongs to another
   * worker. A build killed by its deadline keeps running, and its journal used to go on marking a
   * draft that a newer attempt was already building.
   */
  assertOwnership?: (db: Db) => Promise<void>;
  /**
   * Renew the build's AI reservation. The build's hold outlives its longest model call only
   * because something renews it, and a step closing is the one moment that is always the build
   * genuinely advancing. False means the hold has gone, and with it the budget's memory of this
   * build, so the journal stops and says so.
   */
  renewHold?: () => Promise<boolean>;
  /** Told once, when the journal learns this build must stop. */
  onLost?: (loss: CvJournalLoss) => void;
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
  private readonly running = new Set<CvOpenStep<CvBuildMotion>>();
  /** Set once, the first time this journal learns the build it describes is no longer its own. */
  private lost: CvJournalLoss | null = null;
  /**
   * Set once the CV is ready. The build goes on to its optional improvement, but a published CV has
   * finished advancing: its `progressAt` is the last moment it did, and the page reads a moved one
   * as a build still running. From here a step closing checks the fence and the draft and renews
   * the stage's hold, and writes nothing to the draft.
   */
  private published = false;
  /**
   * Ledger writes run one after another, however concurrent the work they describe is.
   *
   * A step takes the next `seq` for its draft, and the assessment runs its batches together: two
   * overlapping inserts would each wait on the draft's allocation lock, and the narrative would
   * come out in whichever order the lock was granted. The writes are short and off the critical
   * path, so queueing them costs nothing and the narrative comes out in the order it happened.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CvJournalOptions) {}

  /** Writes that would be stale (another worker owns this build) or pointless (the draft is gone). */
  private get silent(): boolean {
    return this.lost === "deleted" || this.lost === "fenced";
  }

  private stop(loss: CvJournalLoss): void {
    if (this.lost) return;
    this.lost = loss;
    log.warn("CV build journal stopped", { draftId: this.options.draftId, attempt: this.options.attempt, loss });
    this.options.onLost?.(loss);
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /**
   * The motion most recently opened and still running: where the build was when it stopped, for a
   * failure that does not say for itself.
   */
  get openMotion(): CvBuildMotion | undefined {
    let last: CvBuildMotion | undefined;
    for (const step of this.running) if (step.motion) last = step.motion;
    return last;
  }

  /** The CV is ready: from here nothing this journal writes may move the draft's `progressAt`. */
  markPublished(): void {
    this.published = true;
  }

  /**
   * Open a step. Never throws; a ledger that refused the row gives a step with a null id.
   *
   * Fenced like every other write this attempt makes: the row is inserted in the transaction that
   * checks the task is still this attempt's, so a build the deadline gave up on — which keeps
   * running until its calls notice — cannot add motions to the narrative of the attempt that
   * replaced it. A fence that refuses stops the journal, as a refused progress mark does.
   */
  async open<M extends CvBuildMotion>(motion: M, detail: CvBuildStepDetails[M], title?: string): Promise<CvOpenStep<M>> {
    return this.queued(async () => {
      if (this.silent) return new CvOpenStep<M>(null, motion);
      try {
        const id = await this.options.db.transaction(async (tx) => {
          await this.options.assertOwnership?.(tx as unknown as Db);
          return startCvBuildStep(tx as unknown as Db, {
            draftId: this.options.draftId,
            userId: this.options.userId,
            taskId: this.options.taskId,
            attempt: this.options.attempt,
            motion,
            ...(title ? { title } : {}),
            detail,
          });
        });
        const step = new CvOpenStep<M>(id, motion);
        this.running.add(step);
        return step;
      } catch (error) {
        if (error instanceof LeaseLostError) this.stop("fenced");
        else log.warn("CV build step could not be opened", { draftId: this.options.draftId, motion, error: (error as Error).message });
        return new CvOpenStep<M>(null, motion);
      }
    });
  }

  /**
   * Close a step inside the caller's transaction, so the row and what it describes commit together
   * or not at all: publication closes its step inside the transaction that makes the CV ready, and
   * a page that sees the CV ready sees it saved. Unlike `close`, a failure here is the caller's.
   */
  async closeWithin<M extends CvBuildMotion>(
    tx: Pick<Db, "update">,
    step: CvOpenStep<M> | null | undefined,
    status: Closed,
    detail?: CvBuildStepDetails[M],
  ): Promise<void> {
    if (!step?.id || this.silent) return;
    await finishCvBuildStep(tx, step.id, { status, detail: { ...step.gathered, ...(detail ?? {}) }, error: null, failure: null });
    this.running.delete(step);
  }

  /** Close a step with its outcome and whatever figures it gathered. Never throws. */
  async close<M extends CvBuildMotion>(
    step: CvOpenStep<M> | null | undefined,
    status: Closed,
    detail?: CvBuildStepDetails[M],
    outcome: { error?: string; failure?: CvBuildFailure } = {},
  ): Promise<void> {
    if (step) this.running.delete(step);
    await this.queued(async () => {
      if (!step?.id || this.silent) return;
      try {
        await finishCvBuildStep(this.options.db, step.id, {
          status,
          detail: { ...step.gathered, ...(detail ?? {}) },
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
  async record<M extends CvBuildMotion>(motion: M, detail: CvBuildStepDetails[M], status: Closed = "done", title?: string): Promise<void> {
    await this.close(await this.open(motion, detail, title), status);
  }

  /** Run `work` as one motion, closing the step with anything `work` added to it. */
  async run<T, M extends CvBuildMotion>(
    motion: M,
    detail: CvBuildStepDetails[M],
    work: (step: CvOpenStep<M>) => Promise<T>,
    options: { title?: string; status?: Closed } = {},
  ): Promise<T> {
    const step = await this.open(motion, detail, options.title);
    const result = await work(step);
    await this.close(step, options.status ?? "done");
    return result;
  }

  /**
   * Close everything still running for this attempt with the failure that ended the build.
   *
   * This journal's own steps are closed one at a time so each keeps the figures it had gathered —
   * the budget a refused build was measured against, the batch a failed audit was on — which a
   * blanket sweep would throw away. The sweep still runs afterwards, for a step this attempt left
   * behind before the process was replaced, and it is scoped to this attempt: a build the deadline
   * killed keeps running, and an unscoped sweep let its ghost close the live attempt's steps.
   */
  async failOpen(error: string, failure?: CvBuildFailure): Promise<void> {
    for (const step of [...this.running]) await this.close(step, "failed", undefined, { error: error.slice(0, 1000), failure });
    if (this.silent) return;
    await failOpenCvBuildStepsQuietly(this.options.db, this.options.draftId, error, failure, { attempt: this.options.attempt });
    await this.progressed();
  }

  /**
   * The draft's last sign of life, moved on by every step that closes, behind this attempt's fence.
   *
   * A stage lasts as long as its model calls, and the longest of them run for minutes; without
   * this a build that died with its process was indistinguishable from one still thinking, for
   * hours. Never throws: a missed mark must not fail a build that is otherwise fine. It is also
   * where a build finds out that it is over — the draft has been deleted, the task has been taken,
   * or its hold has gone — because it is the one write every motion makes.
   */
  private async progressed(): Promise<void> {
    if (this.silent) return;
    try {
      const alive = await this.options.db.transaction(async (tx) => {
        await this.options.assertOwnership?.(tx as unknown as Db);
        // Once published, only whether the draft is still there: its `progressAt` stays put.
        const rows = this.published
          ? await tx.select({ id: schema.cvDrafts.id }).from(schema.cvDrafts).where(eq(schema.cvDrafts.id, this.options.draftId))
          : await tx.update(schema.cvDrafts).set({ progressAt: this.options.now() })
              .where(eq(schema.cvDrafts.id, this.options.draftId)).returning({ id: schema.cvDrafts.id });
        return rows.length > 0;
      });
      // Nothing to mark: the draft was deleted while this build was running.
      if (!alive) return this.stop("deleted");
    } catch (error) {
      if (error instanceof LeaseLostError) return this.stop("fenced");
      log.warn("CV progress mark failed", { draftId: this.options.draftId, error: (error as Error).message });
    }
    if (this.lost) return;
    try {
      if ((await this.options.renewHold?.()) === false) this.stop("hold");
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
export async function failOpenCvBuildStepsQuietly(
  db: Db,
  draftId: string,
  error: string,
  failure?: CvBuildFailure,
  scope: { attempt?: number } = {},
): Promise<number> {
  try {
    return await failOpenCvBuildSteps(db, draftId, error.slice(0, 1000), failure, scope);
  } catch (err) {
    log.warn("CV build steps could not be closed", { draftId, error: (err as Error).message });
    return 0;
  }
}
