import { schema, type Db, type Task } from "@christopher/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { finaliseScanRuns } from "./handlers/daily";
import { log } from "./log";

export type TaskHandler = (task: Task, deps: WorkerDeps) => Promise<unknown>;
export type HandlerMap = Partial<Record<Task["type"], TaskHandler>>;

export interface QueueOptions {
  concurrency: number;
  pollMs?: number;
  workerId: string;
  staleAfterMs?: number;
}

export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

export async function claimTask(db: Db, workerId: string): Promise<Task | null> {
  const res = await db.execute<{ id: string }>(sql`
    update tasks set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, started_at = now()
    where id = (
      select id from tasks where status = 'queued' and run_after <= now()
      order by priority asc, run_after asc, created_at asc
      limit 1 for update skip locked
    )
    returning id`);
  const id = res.rows[0]?.id;
  if (!id) return null;
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function completeTask(db: Db, task: Task, result: unknown): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ status: "done", finishedAt: new Date(), result: result === undefined ? null : (result as object), error: null, lockedAt: null })
    .where(eq(schema.tasks.id, task.id));
}

export async function failTask(db: Db, task: Task, err: unknown): Promise<"retry" | "failed"> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const retry = task.attempts < task.maxAttempts;
  await db
    .update(schema.tasks)
    .set(
      retry
        ? { status: "queued", error: message.slice(0, 2000), runAfter: new Date(Date.now() + backoffMs(task.attempts)), lockedAt: null }
        : { status: "failed", error: message.slice(0, 2000), finishedAt: new Date(), lockedAt: null },
    )
    .where(eq(schema.tasks.id, task.id));
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
        task = await claimTask(this.deps.db, `${this.opts.workerId}#${slot}`);
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
    try {
      if (!handler) throw new Error(`no handler for task type ${task.type}`);
      log.info("task start", { id: task.id, type: task.type, attempt: task.attempts });
      const result = await handler(task, this.deps);
      await completeTask(this.deps.db, task, result);
      if (task.type === "scan_company" || task.type === "run_daily") await finaliseScanRuns(this.deps);
      log.info("task done", { id: task.id, type: task.type, ms: Date.now() - started });
    } catch (err) {
      const outcome = await failTask(this.deps.db, task, err).catch((e) => {
        log.error("failTask failed", e);
        return "failed" as const;
      });
      log.warn(`task ${outcome}`, { id: task.id, type: task.type, error: (err as Error).message, ms: Date.now() - started });
    } finally {
      this.active--;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
