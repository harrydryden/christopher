import { schema, type Db, type Task } from "@christopher/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { finaliseScanRuns } from "./handlers/daily";
import { LeaseBusyError } from "./lease";
import { log } from "./log";

export type TaskHandler = (task: Task, deps: WorkerDeps) => Promise<unknown>;
export type HandlerMap = Partial<Record<Task["type"], TaskHandler>>;
// Ten missed 30-second renewals; aligned with the resource lease expiry.
export const TASK_STALE_AFTER_MS = 5 * 60_000;

/**
 * How long one handler may run before its task is abandoned and failed.
 *
 * Nothing else bounds a handler: a fetch that hangs past its own timeouts, or a model call that
 * never returns, would otherwise hold a slot until the process restarts. `scan_company` is the
 * three minutes per company R-3.1 asks for; a CV build is a chain of model calls and gets half an
 * hour; discovery walks several pages. Everything else is short by construction.
 */
export const TASK_DEADLINES_MS: Partial<Record<Task["type"], number>> & { default: number } = {
  scan_company: 3 * 60_000,
  generate_cv: 30 * 60_000,
  discover: 5 * 60_000,
  default: 2 * 60_000,
};

export type TaskDeadlines = Partial<Record<Task["type"] | "default", number>>;

/** The deadline for one type: the caller's override first, then the table above. */
export function deadlineMsFor(type: Task["type"], overrides: TaskDeadlines = {}): number {
  return overrides[type] ?? overrides.default ?? TASK_DEADLINES_MS[type] ?? TASK_DEADLINES_MS.default;
}

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
    .where(sql`${schema.tasks.id} = (
      select id from tasks where status = 'queued' and run_after <= now() and ${laneFilter}
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

/** Tasks left "running" by a crashed worker go back to the queue. */
export async function requeueStale(db: Db, staleAfterMs = TASK_STALE_AFTER_MS): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .update(schema.tasks)
    .set({ status: "queued", lockedAt: null, lockedBy: null, error: "requeued: stale lock" })
    .where(and(eq(schema.tasks.status, "running"), lt(schema.tasks.lockedAt, cutoff)))
    .returning({ id: schema.tasks.id });
  return rows.length;
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
      const released = await this.deps.db.execute<{ id: string }>(sql`delete from ai_reservations where worker_id = ${this.opts.workerId} returning id`);
      if (released.rows.length) log.warn("released ai reservations on shutdown", { held: released.rows.length, workerId: this.opts.workerId });
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

  async runTask(task: Task): Promise<void> {
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
    try {
      if (!handler) throw new Error(`no handler for task type ${task.type}`);
      log.info("task start", { id: task.id, type: task.type, attempt: task.attempts, workerId: this.opts.workerId, commit: process.env.RENDER_GIT_COMMIT ?? null, queueWaitMs: Math.max(0, Date.now() - task.createdAt.getTime()) });
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
      log.info("task done", { id: task.id, type: task.type, ms: Date.now() - started });
    } catch (err) {
      const outcome = await failTask(this.deps.db, task, err).catch((e) => {
        log.error("failTask failed", e);
        return "failed" as const;
      });
      log.warn(`task ${outcome}`, { id: task.id, type: task.type, error: (err as Error).message, ms: Date.now() - started });
    } finally {
      clearInterval(heartbeat);
      this.running.delete(task.id);
      this.active--;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
