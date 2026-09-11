import { schema, type Db, type Task } from "@christopher/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { finaliseScanRuns } from "./handlers/daily";
import { LeaseBusyError } from "./lease";
import { log } from "./log";

export type TaskHandler = (task: Task, deps: WorkerDeps) => Promise<unknown>;
export type HandlerMap = Partial<Record<Task["type"], TaskHandler>>;

export interface QueueOptions {
  concurrency: number;
  pollMs?: number;
  workerId: string;
  staleAfterMs?: number;
  heartbeatMs?: number;
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
  const res = await db.execute<{ id: string }>(sql`
    update tasks set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, started_at = now()
    where id = (
      select id from tasks where status = 'queued' and run_after <= now() and ${laneFilter}
      order by greatest(0, priority - floor(extract(epoch from (now() - created_at)) / 300)) asc, run_after asc, created_at asc
      limit 1 for update skip locked
    )
    returning id`);
  const id = res.rows[0]?.id;
  if (!id) return null;
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return rows[0] ?? null;
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
export async function requeueStale(db: Db, staleAfterMs = 20 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .update(schema.tasks)
    .set({ status: "queued", lockedAt: null, lockedBy: null, error: "requeued: stale lock" })
    .where(and(eq(schema.tasks.status, "running"), lt(schema.tasks.lockedAt, cutoff)))
    .returning({ id: schema.tasks.id });
  return rows.length;
}

export class TaskQueue {
  private stopping = false;
  private loops: Promise<void>[] = [];
  private active = 0;
  private turn = 0;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly handlers: HandlerMap,
    private readonly opts: QueueOptions,
  ) {}

  start(): void {
    for (let i = 0; i < this.opts.concurrency; i++) this.loops.push(this.loop(i));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.loops);
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
        // With three or more slots each class has guaranteed capacity. Small workers rotate
        // classes to avoid starvation, but cannot promise simultaneous execution.
        const lane: QueueLane = this.opts.concurrency >= 3
          ? (["interactive", "scan", "background"] as const)[slot % 3]!
          : (["interactive", "scan", "background"] as const)[this.turn++ % 3]!;
        task = await claimTask(this.deps.db, `${this.opts.workerId}#${slot}`, lane);
        if (!task && this.opts.concurrency < 3) task = await claimTask(this.deps.db, `${this.opts.workerId}#${slot}`);
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
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renewTask(this.deps.db, task).catch(err => log.warn("task heartbeat failed", err)).finally(() => { renewing = false; });
    }, this.opts.heartbeatMs ?? Math.max(100, Math.min(30_000, (this.opts.staleAfterMs ?? 1_200_000) / 3)));
    heartbeat.unref();
    try {
      if (!handler) throw new Error(`no handler for task type ${task.type}`);
      log.info("task start", { id: task.id, type: task.type, attempt: task.attempts, queueWaitMs: Math.max(0, Date.now() - task.createdAt.getTime()) });
      const result = await handler(task, { ...this.deps, assertOwnership: db => assertTaskOwnership(db, task) });
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
      this.active--;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
