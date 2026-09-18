import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface ScanRunSummary {
  sources: number;
  pending: number;
  companies_ok: number;
  new_roles: number;
  closed_roles: number;
}

const EMPTY: ScanRunSummary = { sources: 0, pending: 0, companies_ok: 0, new_roles: 0, closed_roles: 0 };

/**
 * New counts are insert counts across attempts; health uses the latest attempt per source.
 * With a `userId` the summary covers only the companies that account follows: the run is shared,
 * the banner is personal.
 *
 * Every term is an aggregate over the run, joined by run and company — no per-company subquery —
 * because this runs on every server render, on a timer in every open tab, and once per row of
 * Health's run history.
 */
export async function scanRunSummaries(db: Db, runIds: string[], userId?: string): Promise<Map<string, ScanRunSummary>> {
  const byRun = new Map<string, ScanRunSummary>();
  const ids = [...new Set(runIds)];
  if (!ids.length) return byRun;
  const scoped = userId ?? null;
  // Drizzle renders one placeholder per element, so the ids are spelled out rather than passed as
  // an array parameter (which Postgres would read as a malformed array literal).
  const runValues = sql.join(ids.map((id) => sql`(${id}::uuid)`), sql`, `);
  const runIdList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const runTextList = sql.join(ids.map((id) => sql`${id}::text`), sql`, `);
  const result = await db.execute(sql`
    with runs as (
      select v.run_id from (values ${runValues}) as v(run_id)
    ), followed as (
      select c.id as company_id from companies c
      where ${scoped}::uuid is null or exists (select 1 from company_subscriptions s where s.company_id = c.id and s.user_id = ${scoped}::uuid)
    ), run_scans as (
      select s.scan_run_id as run_id, s.source_id, cs.company_id, s.status, s.started_at, s.id,
             s.finished_at, s.new_count, s.closed_count
      from scans s
      join career_sources cs on cs.id = s.source_id
      join followed f on f.company_id = cs.company_id
      where s.scan_run_id in (${runIdList})
    ), latest_sources as (
      select distinct on (run_id, source_id) run_id, source_id, company_id, status, finished_at
      from run_scans order by run_id, source_id, started_at desc, id desc
    ), company_state as (
      select run_id, company_id, bool_and(status = 'ok' and finished_at is not null) as ok
      from latest_sources group by run_id, company_id
    ), run_tasks as (
      select t.payload->>'scanRunId' as run_id, t.payload->>'companyId' as company_id,
             count(*) filter (where t.status in ('queued','running'))::int as pending,
             count(*) filter (where t.status <> 'done')::int as unfinished
      from tasks t
      where t.type = 'scan_company' and t.payload->>'scanRunId' in (${runTextList})
      group by 1, 2
    )
    select r.run_id::text as run_id,
      coalesce(src.sources, 0)::int as sources,
      coalesce(pend.pending, 0)::int as pending,
      coalesce(okc.companies_ok, 0)::int as companies_ok,
      coalesce(counts.new_roles, 0)::int as new_roles,
      coalesce(counts.closed_roles, 0)::int as closed_roles
    from runs r
    left join (select run_id, count(*)::int as sources from latest_sources group by 1) src on src.run_id = r.run_id
    left join (
      select rt.run_id, sum(rt.pending)::int as pending from run_tasks rt
      join followed f on f.company_id::text = rt.company_id group by 1
    ) pend on pend.run_id = r.run_id::text
    left join (
      select c.run_id, count(*)::int as companies_ok from company_state c
      left join run_tasks rt on rt.run_id = c.run_id::text and rt.company_id = c.company_id::text
      where c.ok and coalesce(rt.unfinished, 0) = 0
      group by 1
    ) okc on okc.run_id = r.run_id
    left join (
      select run_id, sum(new_count)::int as new_roles, sum(closed_count)::int as closed_roles
      from run_scans group by 1
    ) counts on counts.run_id = r.run_id
  `);
  for (const row of result.rows as unknown as Array<ScanRunSummary & { run_id: string }>) {
    byRun.set(row.run_id, { sources: row.sources, pending: row.pending, companies_ok: row.companies_ok, new_roles: row.new_roles, closed_roles: row.closed_roles });
  }
  for (const id of ids) if (!byRun.has(id)) byRun.set(id, { ...EMPTY });
  return byRun;
}

/** One run's summary. Same shape as before: `{sources, pending, companies_ok, new_roles, closed_roles}`. */
export async function scanRunSummary(db: Db, runId: string, userId?: string): Promise<ScanRunSummary> {
  const summaries = await scanRunSummaries(db, [runId], userId);
  return summaries.get(runId) ?? { ...EMPTY };
}
