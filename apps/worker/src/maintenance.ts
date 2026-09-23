import { sql, type SQL } from "drizzle-orm";
import { pruneHttpHostDaily } from "@ava/db";
import type { WorkerDeps } from "./context";
import { log } from "./log";

/** Rows one retention statement may touch. Small enough to hold its locks for a moment only. */
export const RETENTION_BATCH = 5_000;
/** How long one table may keep deleting in a run before the rest wait for the next hour. */
export const RETENTION_TABLE_BUDGET_MS = 20_000;

export interface MaintenanceOptions {
  batch?: number;
  tableBudgetMs?: number;
  /** Stops the run between batches, for a worker shutting down. */
  signal?: AbortSignal;
  /** Milliseconds, for the budget alone; a test can make time pass with it. */
  clock?: () => number;
}

/** What one table's retention did in a run. `backlog` means it stopped at its budget with more to do. */
export interface Pruned {
  rows: number;
  backlog: boolean;
  /** Why the table's statement failed; the other tables are pruned regardless. */
  error?: string;
}

/**
 * Repeat `run` in batches until a batch comes back short, the deadline passes or the run is
 * stopped. Every batch is its own statement outside any transaction, so nothing is held between
 * batches, and a statement that fails ends this table's run without ending anyone else's.
 */
export async function pruneInBatches(run: (limit: number) => Promise<number>, options: { batch: number; deadline: number; clock: () => number; signal?: AbortSignal }): Promise<Pruned> {
  let rows = 0;
  for (;;) {
    let removed: number;
    try {
      removed = await run(options.batch);
    } catch (error) {
      return { rows, backlog: true, error: error instanceof Error ? error.message : String(error) };
    }
    rows += removed;
    if (removed < options.batch) return { rows, backlog: false };
    if (options.clock() >= options.deadline || options.signal?.aborted) return { rows, backlog: true };
  }
}

/**
 * Each table's retention rule as one bounded statement. Every one reads an index rather than its
 * table, except `host_pacing`, which holds one row per host and is rewritten on every request, so
 * an index there would cost more than the scan it saves. What is never pruned: decisions,
 * applications, review evidence, and the 'discovered', 'closed', 'reopened', 'decided' and 'hidden'
 * events a role's history is made of; of scans, the last three per source and its last successful
 * one, which is what closure is measured against.
 */
const RULES: Array<[table: string, statement: (limit: number) => SQL]> = [
  ["tasks", n => sql`delete from tasks where id in (select id from tasks where status in ('done','failed') and finished_at < now() - interval '30 days' limit ${n})`],
  ["job_events", n => sql`delete from job_events where id in (select id from job_events where type in ('updated','scored','description_fetched') and at < now() - interval '90 days' limit ${n})`],
  // `ai_calls` is the only record of what was spent, and a budget question can be asked about last
  // year's invoice, so it is kept for thirteen months — a full year plus the month being reconciled.
  ["ai_calls", n => sql`delete from ai_calls where id in (select id from ai_calls where at < now() - interval '13 months' limit ${n})`],
  ["scans", n => sql`delete from scans where id in (select s.id from scans s where s.started_at < now() - interval '90 days'
      and not exists (select 1 from (select id from scans recent where recent.source_id=s.source_id order by started_at desc limit 3) keep where keep.id=s.id)
      and not exists (select 1 from (select id from scans recent where recent.source_id=s.source_id and status='ok' order by started_at desc limit 1) keep where keep.id=s.id) limit ${n})`],
  ["discovery_documents", n => sql`update discovery_documents set content='' where id in (select d.id from discovery_documents d
      where d.processed_at < now() - interval '90 days' and d.content <> '' and not exists
      (select 1 from discovery_candidates c where c.document_id=d.id and c.processed_at is null) limit ${n})`],
  // Every attempt and retry keeps a row with its candidates and log. The newest per company is what
  // the interface reads, and a run still running or waiting for confirmation is acted on by id.
  ["discovery_runs", n => sql`delete from discovery_runs where id in (select r.id from discovery_runs r
      where r.started_at < now() - interval '90 days' and r.status in ('resolved','not_found','failed')
      and exists (select 1 from discovery_runs newer where newer.company_id = r.company_id and newer.started_at > r.started_at) limit ${n})`],
  ["verification_cache", n => sql`delete from verification_cache where key in (select key from verification_cache where expires_at < now() limit ${n})`],
  ["host_pacing", n => sql`delete from host_pacing where host in (select host from host_pacing where next_at < now() - interval '7 days' limit ${n})`],
  // Holds are released as they end and swept on every reservation; this catches what no reservation came after.
  ["ai_reservations", n => sql`delete from ai_reservations where id in (select id from ai_reservations where expires_at < now() - interval '1 hour' limit ${n})`],
  // Sign-in bookkeeping: throttling rows, expired sessions and spent links are short-lived.
  ["login_attempts", n => sql`delete from login_attempts where id in (select id from login_attempts where at < now() - interval '1 day' limit ${n})`],
  ["sessions", n => sql`delete from sessions where id in (select id from sessions where expires_at < now() limit ${n})`],
  ["auth_tokens", n => sql`delete from auth_tokens where id in (select id from auth_tokens where expires_at < now() - interval '1 day' limit ${n})`],
  ["auth_tokens", n => sql`delete from auth_tokens where id in (select id from auth_tokens where used_at < now() - interval '1 day' limit ${n})`],
];

/**
 * Hourly history cleanup, whichever worker gets there first. Each table is pruned in batches until
 * it is done or has had its budget, so the work keeps up with the insert rate at any scale instead
 * of removing a fixed thousand rows an hour; a table left with a backlog carries on next hour.
 * Returns what each table lost, or null when another run had the hour.
 */
export async function maintainHistory(deps: WorkerDeps, options: MaintenanceOptions = {}): Promise<Record<string, Pruned> | null> {
  const claimed = await deps.db.execute(sql`insert into settings (key,value,updated_at) values ('internal:lastMaintenance','{}',now())
    on conflict (key) do update set updated_at=now() where settings.updated_at < now() - interval '1 hour' returning key`);
  if (!claimed.rows.length) return null;
  const batch = options.batch ?? RETENTION_BATCH;
  const budget = options.tableBudgetMs ?? RETENTION_TABLE_BUDGET_MS;
  const clock = options.clock ?? (() => performance.now());
  const report: Record<string, Pruned> = {};
  const prune = async (table: string, run: (limit: number) => Promise<number>) => {
    if (options.signal?.aborted) return;
    const outcome = await pruneInBatches(run, { batch, deadline: clock() + budget, clock, signal: options.signal });
    if (outcome.error) log.warn("retention failed for a table; the others go ahead", { table, error: outcome.error });
    const previous = report[table];
    report[table] = previous
      ? { rows: previous.rows + outcome.rows, backlog: previous.backlog || outcome.backlog, ...(previous.error ?? outcome.error ? { error: previous.error ?? outcome.error } : {}) }
      : outcome;
  };
  for (const [table, statement] of RULES) {
    await prune(table, async limit => (await deps.db.execute(statement(limit))).rowCount ?? 0);
  }
  // The traffic rollup is one small row per host per day, kept long enough to answer "how did this
  // vendor behave last spring"; `pruneHttpHostDaily` owns that number.
  await prune("http_host_daily", limit => pruneHttpHostDaily(deps.db, 400, limit));

  const pruned = Object.fromEntries(Object.entries(report).filter(([, outcome]) => outcome.rows > 0).map(([table, outcome]) => [table, outcome.rows]));
  if (Object.keys(pruned).length) log.info("pruned history", pruned);
  const behind = Object.entries(report).filter(([, outcome]) => outcome.backlog && !outcome.error).map(([table]) => table);
  if (behind.length) log.warn("retention backlog; continuing next hour", { tables: behind, batch, budgetMs: budget });
  return report;
}
