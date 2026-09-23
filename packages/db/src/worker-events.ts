import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { workerEvents, type WorkerEventKind } from "./schema";

export interface WorkerEventInput {
  workerId: string;
  kind: WorkerEventKind;
  taskId?: string | null;
  taskType?: string | null;
  userId?: string | null;
  detail?: Record<string, unknown>;
}

/** One row per thing the worker process did that Operations should be able to see later. Never throws: a ledger must not take the worker down. */
export async function recordWorkerEvent(db: Db, event: WorkerEventInput): Promise<void> {
  try {
    await db.insert(workerEvents).values({
      workerId: event.workerId, kind: event.kind, taskId: event.taskId ?? null, taskType: event.taskType ?? null,
      userId: event.userId ?? null, detail: event.detail ?? {},
    });
  } catch {
    // The caller is usually mid-boot or mid-failure; losing the ledger row is the lesser harm.
  }
}

export async function listWorkerEvents(db: Db, opts: { since?: Date; kinds?: WorkerEventKind[]; limit?: number } = {}) {
  const conditions = [];
  if (opts.since) conditions.push(gte(workerEvents.at, opts.since));
  if (opts.kinds?.length) conditions.push(sql`${workerEvents.kind} in (${sql.join(opts.kinds.map(k => sql`${k}`), sql`, `)})`);
  return db.select().from(workerEvents).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(workerEvents.at)).limit(opts.limit ?? 50);
}

export async function countWorkerEvents(db: Db, kind: WorkerEventKind, since: Date): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(workerEvents).where(and(eq(workerEvents.kind, kind), gte(workerEvents.at, since)));
  return rows[0]?.n ?? 0;
}

/**
 * Thirty days is enough to see a pattern; the ledger is not an audit trail. Deleted in batches of
 * `batch`, each its own statement, until one comes back short or `budgetMs` is spent, so a backlog
 * never holds one statement open over all of it.
 */
export async function pruneWorkerEvents(db: Db, olderThan = new Date(Date.now() - 30 * 86_400_000), batch = 5_000, budgetMs = 20_000): Promise<number> {
  const deadline = performance.now() + budgetMs;
  let total = 0;
  for (;;) {
    const result = await db.execute(sql`delete from worker_events where id in (select id from worker_events where at < ${olderThan.toISOString()}::timestamptz limit ${batch})`);
    const removed = result.rowCount ?? 0;
    total += removed;
    if (removed < batch || performance.now() >= deadline) return total;
  }
}
