import { schema, enqueueTask, type Task } from "@christopher/db";
import { dedupeKeyFor, localDateParts, priorityFor } from "@christopher/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { log } from "../log";

interface DailyPayload {
  trigger: "schedule" | "manual";
  runDate?: string;
}

/**
 * Fan out one scan_company task per active company, then a finaliser that summarises the run.
 * Idempotent per (runDate, trigger) so a restart mid-run does not duplicate it.
 */
export async function handleRunDaily(task: Task, deps: WorkerDeps): Promise<unknown> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:daily-runs'))`);
    return runDaily(task, { ...deps, db: tx as unknown as WorkerDeps["db"] });
  });
}

async function runDaily(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as unknown as DailyPayload;
  const settings = await deps.settings();
  const runDate = payload.runDate ?? localDateParts(deps.now(), settings.timezone).ymd;

  const existing = await deps.db
    .select({ id: schema.scanRuns.id })
    .from(schema.scanRuns)
    .where(and(eq(schema.scanRuns.runDate, runDate), eq(schema.scanRuns.trigger, payload.trigger)))
    .limit(1);
  if (existing.length && payload.trigger === "schedule") {
    return { skipped: "run already exists for date", runDate };
  }

  const companies = await deps.db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.status, "active"));

  const [run] = await deps.db
    .insert(schema.scanRuns)
    .values({ runDate, trigger: payload.trigger, startedAt: deps.now(), companiesTotal: companies.length })
    .returning({ id: schema.scanRuns.id });
  if (!run) throw new Error("failed to create scan run");

  for (const company of companies) {
    const p = { companyId: company.id, scanRunId: run.id, trigger: payload.trigger };
    await enqueueTask(deps.db, "scan_company", p, { dedupeKey: `${dedupeKeyFor("scan_company", p)}:${run.id}`, priority: priorityFor("scan_company") });
  }

  log.info("daily run started", { runId: run.id, runDate, companies: companies.length });
  return { scanRunId: run.id, companies: companies.length };
}

/** Summarise a scan run once its scans are done. Called after the queue drains and by the scheduler. */
export async function finaliseScanRuns(deps: WorkerDeps): Promise<number> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:daily-runs'))`);
    return finalise({ ...deps, db: tx as unknown as WorkerDeps["db"] });
  });
}

async function finalise(deps: WorkerDeps): Promise<number> {
  const open = await deps.db
    .select()
    .from(schema.scanRuns)
    .where(sql`${schema.scanRuns.finishedAt} is null`);
  let finalised = 0;
  for (const run of open) {
    const pending = await deps.db.execute<{ n: number }>(sql`
      select count(*)::int as n from tasks
      where type = 'scan_company' and status in ('queued','running') and payload->>'scanRunId' = ${run.id}`);
    if ((pending.rows[0]?.n ?? 0) > 0) continue;

    const agg = await deps.db.execute<{ ok: number; failed: number; new_roles: number; closed_roles: number; sources: number }>(sql`
      select
        count(*) filter (where status in ('ok','partial'))::int as ok,
        count(*) filter (where status in ('failed','suspect_empty'))::int as failed,
        coalesce(sum(new_count), 0)::int as new_roles,
        coalesce(sum(closed_count), 0)::int as closed_roles,
        count(*)::int as sources
      from scans where scan_run_id = ${run.id}`);
    const row = agg.rows[0];
    const companiesOk = await deps.db.execute<{ n: number }>(sql`
      select count(distinct cs.company_id)::int as n from scans s
      join career_sources cs on cs.id = s.source_id
      where s.scan_run_id = ${run.id} and s.status in ('ok','partial')`);

    await deps.db
      .update(schema.scanRuns)
      .set({
        finishedAt: deps.now(),
        companiesOk: companiesOk.rows[0]?.n ?? 0,
        companiesFailed: Math.max(0, run.companiesTotal - (companiesOk.rows[0]?.n ?? 0)),
        newRoles: row?.new_roles ?? 0,
        closedRoles: row?.closed_roles ?? 0,
      })
      .where(eq(schema.scanRuns.id, run.id));
    finalised++;
    log.info("scan run finalised", { runId: run.id, ok: companiesOk.rows[0]?.n, failed: Math.max(0, run.companiesTotal - (companiesOk.rows[0]?.n ?? 0)), newRoles: row?.new_roles });
  }
  return finalised;
}

export async function companiesWithoutSources(deps: WorkerDeps): Promise<string[]> {
  const rows = await deps.db.execute<{ id: string }>(sql`
    select c.id from companies c
    left join career_sources cs on cs.company_id = c.id and cs.status in ('active','failing')
    where c.status = 'active' and cs.id is null`);
  return rows.rows.map((r) => r.id);
}

export { inArray as _inArray };
