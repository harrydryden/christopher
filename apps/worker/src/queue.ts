import { recordWorkerEvent, releaseAiHolds, schema, type Db, type ReleasedHolds, type Task } from "@christopher/db";
import { deadlineMsFor, TASK_DEADLINES_MS, taskSubject, taskUserId, type TaskDeadlines } from "@christopher/core";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { finaliseScanRuns } from "./handlers/daily";
import { LeaseBusyError } from "./lease";
import { log, withLogContext } from "./log";
import { vitals } from "./vitals";

export type TaskHandler = (task: Task, deps: WorkerDeps) => Promise<unknown>;
export type HandlerMap = Partial<Record<Task["type"], TaskHandler>>;

/**
 * What to do for the thing a task was for when the task is given up on for good.
 *
 * A failed task is not the end of the story: a CV draft, a scan run, a discovery candidate can be
 * left half-alive by a task that never wrote its own failure. The hook is the type's chance to
 * close that off, and it runs on every path that fails a task for good — the last attempt of a
 * handler that threw, and a task whose worker died with it claimed.
 */
export type AbandonHook = (task: Task, deps: WorkerDeps, reason: string) => Promise<void>;
export type AbandonHookMap = Partial<Record<Task["type"], AbandonHook>>;

/** What a recovery needs to close off the work behind the tasks it gives up on. */
export interface AbandonContext {
  deps?: WorkerDeps;
  onAbandon?: AbandonHookMap;
}

// Ten missed 30-second renewals; aligned with the resource lease expiry.
export const TASK_STALE_AFTER_MS = 5 * 60_000;

// The deadline table lives in @christopher/core, because the interface shows elapsed time against
// it and cannot import the worker. Re-exported here so nothing else had to change.
export { deadlineMsFor, TASK_DEADLINES_MS };
export type { TaskDeadlines };

/** Heap in use, as a fraction of the ceiling V8 kills the process at, that is worth a warning. */
export const HEAP_PRESSURE_FRACTION = 0.85;

/** A handler that outlived its deadline. Carries the type and the elapsed time into the task row. */
export class TimeoutError extends Error {
  constructor(type: string, deadlineMs: number, elapsedMs: number) {
    super(`${type} exceeded its ${Math.round(deadlineMs / 1000)}s deadline after ${Math.round(elapsedMs / 1000)}s and was abandoned`);
    this.name = "TimeoutError";
  }
}

/** How long `stop()` waits for a running handler before handing its task back to the queue. */
export const STOP_GRACE_MS = 25_000;

export interface QueueOptions {
  concurrency: number;
  pollMs?: number;
  workerId: string;
  staleAfterMs?: number;
  heartbeatMs?: number;
  /** Per-type deadline overrides; tests use them to keep a fake slow handler quick. */
  deadlines?: TaskDeadlines;
  /** What to close off when a task of a given type is given up on for good. */
  onAbandon?: AbandonHookMap;
}

export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

export const scanTypes = ["scan_company", "run_daily"];
export const interactiveTypes = ["generate_cv", "discover", "tag_reason", "reevaluate_gate"];
export type QueueLane = "all" | "scan" | "interactive" | "background";

export async function claimTask(db: Db, workerId: string, lane: QueueLane = "all"): Promise<Task | null> {
  const types = lane === "scan" ? scanTypes : interactiveTypes;
  const laneFilter = lane === "all" ? sql`true` : lane === "background"
    ? sql`type not in (${sql.join([...scanTypes, ...interactiveTypes].map(t => sql`${t}`), sql`, `)})`
    : sql`type in (${sql.join(types.map(t => sql`${t}`), sql`, `)})`;
  // Ordered by the columns the ready-lane indexes carry, so a claim reads the first matching row
  // from the index instead of sorting every queued task. Ageing is a periodic sweep that lowers
  // `priority` itself (see `agePriorities`), which keeps waiting work moving up without putting an
  // expression no index can serve in the hot path.
  const rows = await db
    .update(schema.tasks)
    .set({ status: "running", lockedAt: sql`now()`, lockedBy: workerId, attempts: sql`${schema.tasks.attempts} + 1`, startedAt: sql`now()` })
    // `attempts < max_attempts` is what stops a task that kills the process being retried forever:
    // an out-of-memory is a hard death, so nothing compares the two before the lock goes stale and
    // the task is claimed again. A task already at its limit is failed by `requeueStale`, never
    // claimed. The column is read from the same index rows the lane filter walks.
    .where(sql`${schema.tasks.id} = (
      select id from tasks where status = 'queued' and run_after <= now() and attempts < max_attempts and ${laneFilter}
      order by priority asc, run_after asc, created_at asc
      limit 1 for update skip locked
    )`)
    .returning();
  return rows[0] ?? null;
}

/**
 * Bounded ageing sweep: a task that has waited long enough moves one step up the queue.
 *
 * The claim itself orders by the stored priority alone, so something has to move a task that keeps
 * losing to newer, higher-priority work. Running it from the scheduler keeps the claim indexed and
 * the sweep bounded; `limit` caps how much one sweep rewrites.
 */
export async function agePriorities(db: Db, olderThanSeconds = 300, limit = 500): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    update tasks set priority = priority - 1
    where id in (
      select id from tasks
      where status = 'queued' and priority > 0 and created_at < now() - make_interval(secs => ${olderThanSeconds}::int)
      order by priority asc, created_at asc limit ${limit}
    ) returning id`);
  return rows.rows.length;
}

export function ownedTask(task: Task) {
  return and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "running"),
    eq(schema.tasks.attempts, task.attempts), eq(schema.tasks.lockedBy, task.lockedBy ?? ""));
}

export async function renewTask(db: Db, task: Task): Promise<boolean> {
  const rows = await db.update(schema.tasks).set({ lockedAt: new Date() }).where(ownedTask(task)).returning({ id: schema.tasks.id });
  return rows.length === 1;
}

export async function assertTaskOwnership(db: Db, task: Task): Promise<void> {
  const rows = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(ownedTask(task)).for("update");
  if (!rows.length) throw new Error("Task lease lost; refusing stale writes");
}

export async function completeTask(db: Db, task: Task, result: unknown): Promise<boolean> {
  const rows = await db
    .update(schema.tasks)
    .set({ status: "done", finishedAt: new Date(), result: result === undefined ? null : (result as object), error: null, lockedAt: null })
    .where(ownedTask(task)).returning({ id: schema.tasks.id });
  return rows.length === 1;
}

export async function failTask(db: Db, task: Task, err: unknown): Promise<"retry" | "failed" | "lost"> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const busy = err instanceof LeaseBusyError;
  const retry = busy || task.attempts < task.maxAttempts;
  const rows = await db
    .update(schema.tasks)
    .set(
      retry
        ? { status: "queued", error: message.slice(0, 2000), runAfter: new Date(Date.now() + (busy ? 30_000 : backoffMs(task.attempts))), attempts: busy ? task.attempts - 1 : task.attempts, lockedAt: null }
        : { status: "failed", error: message.slice(0, 2000), finishedAt: new Date(), lockedAt: null },
    )
    .where(ownedTask(task)).returning({ id: schema.tasks.id });
  if (!rows.length) return "lost";
  return retry ? "retry" : "failed";
}

/** Run the type's abandonment hook, if it has one. A hook that throws never fails the recovery. */
export async function runAbandonHook(task: Task, reason: string, context: AbandonContext): Promise<void> {
  const hook = context.onAbandon?.[task.type];
  if (!hook || !context.deps) return;
  try {
    await hook(task, context.deps, reason);
  } catch (err) {
    log.error("abandonment hook failed", { id: task.id, type: task.type, error: (err as Error)?.message });
  }
}

/**
 * Give up on one task for good: fail the row, write the ledger entry, close off what it was for.
 *
 * Fenced on the status and attempt it was read at, so a task another worker has already reclaimed
 * is left alone and its hook does not run.
 */
export async function abandonTask(db: Db, task: Task, error: string, workerId: string, context: AbandonContext = {}): Promise<boolean> {
  const rows = await db
    .update(schema.tasks)
    .set({ status: "failed", error: error.slice(0, 2000), finishedAt: new Date(), lockedAt: null })
    .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, task.status), eq(schema.tasks.attempts, task.attempts)))
    .returning({ id: schema.tasks.id });
  if (!rows.length) return false;
  log.warn("task abandoned", { id: task.id, type: task.type, attempts: task.attempts, lockedBy: task.lockedBy, error });
  await recordWorkerEvent(db, {
    workerId, kind: "task_abandoned", taskId: task.id, taskType: task.type, userId: taskUserId(task.payload),
    detail: { attempts: task.attempts, maxAttempts: task.maxAttempts, lockedBy: task.lockedBy, subject: taskSubject(task.type, task.payload), error },
  });
  await runAbandonHook(task, error, context);
  return true;
}

export interface RequeueOutcome {
  /** Put back on the queue, with an attempt spent and a backoff. */
  requeued: number;
  /** Given up on: out of attempts, so retrying it would only kill the next worker too. */
  failed: number;
}

/**
 * Reclaim what a dead worker was holding, and refuse to retry what killed it.
 *
 * Two things end up here. A task left `running` by a process that is gone — the lock stopped
 * being renewed — and a task sitting `queued` that has already spent every attempt, which only a
 * worker from before this rule can leave behind. Both are the same question: has this task had
 * its retries? Under the limit it goes back on the queue having spent one, with the usual
 * backoff, so a transient crash costs a delay rather than the work. At the limit it is failed,
 * because an out-of-memory is a hard death with no catch and no `failTask`: nothing ever compared
 * `attempts` with `max_attempts`, so one bad task was claimed, killed the process, and was claimed
 * again on the next boot, for as long as the deployment was left alone. Failing it also runs the
 * type's abandonment hook, so a CV draft does not keep saying "generating" for the rest of the day.
 *
 * `ids` names the tasks to reclaim whatever their lock age: boot recovery uses it, because a
 * process that has claimed nothing yet knows every `running` row belongs to an earlier incarnation.
 */
export async function requeueStale(
  db: Db,
  staleAfterMs = TASK_STALE_AFTER_MS,
  workerId = "worker",
  options: AbandonContext & { ids?: string[] } = {},
): Promise<RequeueOutcome> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const lost = await db.select().from(schema.tasks).where(
    options.ids?.length
      ? and(eq(schema.tasks.status, "running"), inArray(schema.tasks.id, options.ids))
      : and(eq(schema.tasks.status, "running"), lt(schema.tasks.lockedAt, cutoff)),
  );
  // A queued task past its limit can never be claimed again, so it would sit in the queue for
  // ever. It is given up on here, with the same ledger entry and hook.
  const spent = await db.select().from(schema.tasks)
    .where(and(eq(schema.tasks.status, "queued"), sql`${schema.tasks.attempts} >= ${schema.tasks.maxAttempts}`));

  const outcome: RequeueOutcome = { requeued: 0, failed: 0 };
  for (const task of [...lost, ...spent]) {
    if (task.attempts >= task.maxAttempts) {
      const error = task.status === "running"
        ? `worker lost while running this task (attempt ${task.attempts} of ${task.maxAttempts}); not retried`
        : `out of attempts (${task.attempts} of ${task.maxAttempts} spent); not retried`;
      if (await abandonTask(db, task, error, workerId, options)) outcome.failed++;
      continue;
    }
    const rows = await db
      .update(schema.tasks)
      .set({
        status: "queued", lockedAt: null, lockedBy: null,
        error: `requeued: worker lost while running (attempt ${task.attempts} of ${task.maxAttempts})`,
        runAfter: new Date(Date.now() + backoffMs(task.attempts)),
      })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "running"), eq(schema.tasks.attempts, task.attempts)))
      .returning({ id: schema.tasks.id });
    outcome.requeued += rows.length;
  }
  return outcome;
}

/** One task the previous incarnation of this worker was running when it died. */
export interface CrashSuspect {
  id: string;
  type: Task["type"];
  attempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  /** A short human label for what it was for: the company, draft or account behind it. */
  subject: string | null;
}

export interface CrashRecovery extends RequeueOutcome {
  suspects: CrashSuspect[];
  /** The suspect with the most attempts: the task most likely to have killed the process. */
  likely: CrashSuspect | null;
  holds: ReleasedHolds;
}

/**
 * What a worker does before it starts claiming, having found work that was already claimed.
 *
 * This process has claimed nothing yet, so every `running` task belonged to the incarnation
 * before it, and every AI reservation under this worker's id is a hold no live call can settle —
 * the id is the pod name, and two processes cannot share one. Both are recorded before they are
 * cleaned up, because the crash itself leaves no trace anywhere else: the ledger is how Operations
 * later says "the worker restarted eleven times and this task was running every time".
 *
 * The requeue is the scheduler's own function, so the attempts accounting after a crash is
 * identical to the accounting after a stale lock, and the task that killed the process is failed
 * here rather than claimed again.
 */
export async function recoverFromCrash(
  deps: WorkerDeps,
  opts: { workerId: string; onAbandon?: AbandonHookMap; staleAfterMs?: number },
): Promise<CrashRecovery> {
  const staleAfterMs = opts.staleAfterMs ?? TASK_STALE_AFTER_MS;
  const cutoff = Date.now() - staleAfterMs;
  const all = await deps.db.select().from(schema.tasks).where(eq(schema.tasks.status, "running"));
  // Ours, or nobody's. A slot locks a task as `<workerId>#<slot>`, and the worker id is the pod
  // name, so a running task locked by this id belonged to the incarnation before this one and can
  // be taken back at once. Anything else is left to age out through the ordinary stale sweep,
  // because a deployment that briefly overlaps two pods must not have its live work reclaimed.
  const running = all.filter(task =>
    task.lockedBy === opts.workerId || task.lockedBy?.startsWith(`${opts.workerId}#`)
    || !task.lockedAt || task.lockedAt.getTime() < cutoff);
  const suspects: CrashSuspect[] = running.map(task => ({
    id: task.id, type: task.type, attempts: task.attempts, lockedBy: task.lockedBy,
    lockedAt: task.lockedAt?.toISOString() ?? null, subject: taskSubject(task.type, task.payload),
  }));
  const likely = suspects.reduce<CrashSuspect | null>((worst, s) => (!worst || s.attempts > worst.attempts ? s : worst), null);
  if (suspects.length) {
    log.warn("worker recovered after an unclean exit", { workerId: opts.workerId, running: suspects.length, likely, vitals: vitals() });
    await recordWorkerEvent(deps.db, {
      workerId: opts.workerId, kind: "crash_recovery", taskId: likely?.id ?? null, taskType: likely?.type ?? null,
      detail: { suspects, likely, commit: process.env.RENDER_GIT_COMMIT ?? null },
    });
  }
  // Holds taken by the process that died: nothing can still be spending them, and until they
  // expire on their own they refuse that account work it can plainly afford. Released before the
  // tasks are recovered, so this reports everything the crash left behind rather than the
  // remainder after each abandonment hook has released its own.
  let holds: ReleasedHolds = { count: 0, amountUsd: 0 };
  try {
    holds = await releaseAiHolds(deps.db, { workerId: opts.workerId });
    if (holds.count) {
      log.warn("released ai holds left behind by an unclean exit", { workerId: opts.workerId, ...holds });
      await recordWorkerEvent(deps.db, { workerId: opts.workerId, kind: "holds_released", detail: { ...holds, reason: "boot" } });
    }
  } catch (err) {
    log.error("failed to release ai holds on boot", err);
  }

  const outcome = await requeueStale(deps.db, staleAfterMs, opts.workerId, {
    ids: suspects.map(s => s.id), deps, onAbandon: opts.onAbandon,
  });
  if (outcome.requeued || outcome.failed) log.warn("recovered tasks from a previous incarnation", { ...outcome, workerId: opts.workerId });
  return { ...outcome, suspects, likely, holds };
}

const LANES = ["interactive", "scan", "background"] as const;
/**
 * How the slots are divided when there are enough to divide. Interactive work is what a person is
 * waiting for, so it gets half; the shared daily scan is next; background jobs keep a slot of
 * their own so a full table of scoring never stalls behind either.
 */
const LANE_SHARES: Record<(typeof LANES)[number], number> = { interactive: 0.5, scan: 0.3, background: 0.2 };

/**
 * One lane per slot, or null below three slots, where a slot rotates lanes instead.
 *
 * Every lane keeps at least one slot and the rest are shared out by largest remainder, so the
 * result always adds up to exactly `concurrency`: 3 gives one slot each, 6 gives 3 interactive,
 * 2 scan and 1 background. A slot is a first preference, not a fence — every slot falls through to
 * the whole queue when its own lane is empty.
 */
export function laneSlots(concurrency: number): QueueLane[] | null {
  if (concurrency < LANES.length) return null;
  const counts = new Map<QueueLane, number>();
  const remainders: Array<{ lane: QueueLane; part: number }> = [];
  for (const lane of LANES) {
    const exact = concurrency * LANE_SHARES[lane];
    counts.set(lane, Math.max(1, Math.floor(exact)));
    remainders.push({ lane, part: exact - Math.floor(exact) });
  }
  remainders.sort((a, b) => b.part - a.part);
  let assigned = [...counts.values()].reduce((n, c) => n + c, 0);
  for (let i = 0; assigned < concurrency; i++, assigned++) {
    const { lane } = remainders[i % remainders.length]!;
    counts.set(lane, counts.get(lane)! + 1);
  }
  return LANES.flatMap(lane => Array.from({ length: counts.get(lane)! }, () => lane as QueueLane));
}

/** Run `work`, rejecting with a `TimeoutError` if it has not settled within `ms`. */
async function withDeadline<T>(work: Promise<T>, ms: number, type: Task["type"], startedAt: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(type, ms, Date.now() - startedAt)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TaskQueue {
  private stopping = false;
  private loops: Promise<void>[] = [];
  private active = 0;
  private turn = 0;
  /** Tasks this worker has claimed and not yet finished, so a shutdown can hand them back. */
  private readonly running = new Map<string, Task>();
  private readonly lanes: QueueLane[] | null;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly handlers: HandlerMap,
    private readonly opts: QueueOptions,
  ) {
    this.lanes = laneSlots(opts.concurrency);
  }

  start(): void {
    for (let i = 0; i < this.opts.concurrency; i++) this.loops.push(this.loop(i));
  }

  /**
   * Stop claiming, wait a bounded while for what is running, then give back what this worker still
   * holds: its tasks go straight back on the queue and its AI reservations are released.
   *
   * Without this a task killed mid-flight stays `running` until `TASK_STALE_AFTER_MS` (five
   * minutes) has passed, and a killed CV build's half-hour hold sits against that account's budget
   * for the full half hour, refusing work the account can plainly afford.
   */
  async stop(graceMs = STOP_GRACE_MS): Promise<void> {
    this.stopping = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(this.loops),
      new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    await this.handBack();
  }

  /** Requeue every task still owned here and drop this worker's live reservations. */
  private async handBack(): Promise<void> {
    for (const task of [...this.running.values()]) {
      try {
        // Fenced by the lease: a task already reclaimed by another worker is left alone. The
        // attempt is given back too, so a shutdown never spends one of the task's retries.
        const rows = await this.deps.db
          .update(schema.tasks)
          .set({ status: "queued", lockedAt: null, lockedBy: null, attempts: task.attempts - 1, error: "requeued: worker shutting down" })
          .where(ownedTask(task)).returning({ id: schema.tasks.id });
        if (rows.length) log.warn("task requeued on shutdown", { id: task.id, type: task.type });
      } catch (err) {
        log.error("failed to requeue task on shutdown", err);
      }
    }
    this.running.clear();
    try {
      const released = await releaseAiHolds(this.deps.db, { workerId: this.opts.workerId });
      if (released.count) {
        log.warn("released ai reservations on shutdown", { ...released, workerId: this.opts.workerId });
        await recordWorkerEvent(this.deps.db, { workerId: this.opts.workerId, kind: "holds_released", detail: { ...released, reason: "shutdown" } });
      }
    } catch (err) {
      log.error("failed to release ai reservations on shutdown", err);
    }
  }

  get activeCount(): number {
    return this.active;
  }

  /** Process queued tasks until the queue is empty. Used by tests and the CLI. */
  async drain(maxTasks = 1000): Promise<number> {
    let n = 0;
    while (n < maxTasks) {
      const task = await claimTask(this.deps.db, this.opts.workerId);
      if (!task) break;
      await this.runTask(task);
      n++;
    }
    return n;
  }

  private async loop(slot: number): Promise<void> {
    const poll = this.opts.pollMs ?? 3000;
    while (!this.stopping) {
      let task: Task | null = null;
      try {
        // Each slot serves one class first, so the shared daily scan, the work someone is waiting
        // for and background jobs all keep capacity of their own; a worker too small to divide
        // rotates classes instead. Every slot then falls through to the whole queue, so no slot
        // sits idle on an empty lane while another lane is backed up — at the deployed size that
        // is the difference between the daily scan owning one slot and owning every free one.
        const lane: QueueLane = this.lanes ? this.lanes[slot % this.lanes.length]! : LANES[this.turn++ % LANES.length]!;
        const workerId = `${this.opts.workerId}#${slot}`;
        task = (await claimTask(this.deps.db, workerId, lane)) ?? (await claimTask(this.deps.db, workerId));
      } catch (err) {
        log.error("claim failed", err);
        await sleep(poll * 2);
        continue;
      }
      if (!task) {
        await sleep(poll);
        continue;
      }
      await this.runTask(task);
    }
  }

  /**
   * What the task cost the heap, and a warning when the process is near the ceiling V8 kills it
   * at. Logged once per task, after it has finished, so the warning names the task that got there.
   */
  private heapReport(before: ReturnType<typeof vitals>): Record<string, number> {
    const after = vitals();
    if (after.heapFraction > HEAP_PRESSURE_FRACTION) log.warn("heap pressure", { workerId: this.opts.workerId, ...after });
    return { heapUsedMb: after.heapUsedMb, heapDeltaMb: after.heapUsedMb - before.heapUsedMb, heapLimitMb: after.heapLimitMb };
  }

  /** Every line emitted while a task runs — at any depth — carries its id and type. */
  async runTask(task: Task): Promise<void> {
    return withLogContext({ taskId: task.id, taskType: task.type }, () => this.runTaskInContext(task));
  }

  private async runTaskInContext(task: Task): Promise<void> {
    const handler = this.handlers[task.type];
    const started = Date.now();
    this.active++;
    this.running.set(task.id, task);
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renewTask(this.deps.db, task).catch(err => log.warn("task heartbeat failed", err)).finally(() => { renewing = false; });
    }, this.opts.heartbeatMs ?? Math.max(100, Math.min(30_000, (this.opts.staleAfterMs ?? TASK_STALE_AFTER_MS) / 3)));
    heartbeat.unref();
    const before = vitals();
    try {
      if (!handler) throw new Error(`no handler for task type ${task.type}`);
      // The heap at both ends of every task: an out-of-memory kills the process without reaching
      // any catch, so the last "task start" line before a restart is the only evidence of which
      // task was holding what, and the delta is what says which type grows the heap.
      log.info("task start", { id: task.id, type: task.type, attempt: task.attempts, workerId: this.opts.workerId, commit: process.env.RENDER_GIT_COMMIT ?? null, readyWaitMs: readyWaitMs(task), heapUsedMb: before.heapUsedMb, heapLimitMb: before.heapLimitMb });
      const deadlineMs = deadlineMsFor(task.type, this.opts.deadlines);
      const work = handler(task, { ...this.deps, assertOwnership: db => assertTaskOwnership(db, task) });
      const result = await withDeadline(work, deadlineMs, task.type, started).catch(err => {
        // The handler keeps running: nothing here can cancel a fetch or a model call in flight.
        // Its outcome is logged rather than left unobserved, and its writes are refused by the
        // lease fence, because failing the task has already given the lease to someone else.
        if (err instanceof TimeoutError) void work.then(
          () => log.warn("abandoned task finished after its deadline", { id: task.id, type: task.type }),
          (e: unknown) => log.warn("abandoned task failed after its deadline", { id: task.id, type: task.type, error: (e as Error)?.message }),
        );
        throw err;
      });
      if (!await completeTask(this.deps.db, task, result)) { log.warn("task completion discarded: lease lost", { id: task.id }); return; }
      if (task.type === "scan_company" || task.type === "run_daily") await finaliseScanRuns(this.deps);
      log.info("task done", { id: task.id, type: task.type, ms: Date.now() - started, ...this.heapReport(before) });
    } catch (err) {
      const outcome = await failTask(this.deps.db, task, err).catch((e) => {
        log.error("failTask failed", e);
        return "failed" as const;
      });
      log.warn(`task ${outcome}`, { id: task.id, type: task.type, error: (err as Error).message, ms: Date.now() - started, ...this.heapReport(before) });
      if (err instanceof TimeoutError) {
        await recordWorkerEvent(this.deps.db, {
          workerId: this.opts.workerId, kind: "task_deadline", taskId: task.id, taskType: task.type, userId: taskUserId(task.payload),
          detail: { attempts: task.attempts, elapsedMs: Date.now() - started, deadlineMs: deadlineMsFor(task.type, this.opts.deadlines), outcome, subject: taskSubject(task.type, task.payload) },
        });
      }
      // The last attempt of a handler that keeps throwing leaves the same half-finished work
      // behind as a crash, so it closes it off the same way.
      if (outcome === "failed") {
        await recordWorkerEvent(this.deps.db, {
          workerId: this.opts.workerId, kind: "task_abandoned", taskId: task.id, taskType: task.type, userId: taskUserId(task.payload),
          detail: { attempts: task.attempts, maxAttempts: task.maxAttempts, lockedBy: task.lockedBy, subject: taskSubject(task.type, task.payload), error: (err as Error).message },
        });
        await runAbandonHook(task, (err as Error).message, { deps: this.deps, onAbandon: this.opts.onAbandon });
      }
    } finally {
      clearInterval(heartbeat);
      this.running.delete(task.id);
      this.active--;
    }
  }
}

/**
 * How long the task waited after it was ready to run. Measuring from `createdAt` counted the
 * backoff and the schedule a task was deliberately given as queue time, so a retry in an hour or a
 * scan queued for the morning read as an hour-long backlog; this measures only the part that
 * capacity explains.
 */
function readyWaitMs(task: Task): number {
  const readyAt = Math.max(task.createdAt.getTime(), task.runAfter?.getTime() ?? 0);
  return Math.max(0, Date.now() - readyAt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
