import { sql } from "drizzle-orm";
import type { Db } from "./client";

/**
 * New counts are insert counts across attempts; health uses the latest attempt per source.
 * With a `userId` the summary covers only the companies that account follows: the run is shared,
 * the banner is personal.
 */
export async function scanRunSummary(db: Db, runId: string, userId?: string) {
  const scoped = userId ?? null;
  const result = await db.execute<{ sources: number; pending: number; companies_ok: number; new_roles: number; closed_roles: number }>(sql`
    with followed as (
      select c.id as company_id from companies c
      where ${scoped}::uuid is null or exists (select 1 from company_subscriptions s where s.company_id = c.id and s.user_id = ${scoped}::uuid)
    ), latest_sources as (
      select distinct on (s.source_id) s.source_id, cs.company_id, s.status, s.finished_at, s.new_count, s.closed_count
      from scans s join career_sources cs on cs.id = s.source_id join followed f on f.company_id = cs.company_id
      where s.scan_run_id = ${runId}
      order by s.source_id, s.started_at desc, s.id desc
    ), successful_companies as (
      select company_id from latest_sources group by company_id
      having bool_and(status = 'ok' and finished_at is not null)
    )
    select
      (select count(*)::int from latest_sources) as sources,
      (select count(*)::int from tasks t where t.type = 'scan_company'
        and t.payload->>'scanRunId' = ${runId} and t.status in ('queued','running')
        and exists (select 1 from followed f where f.company_id::text = t.payload->>'companyId')) as pending,
      (select count(*)::int from successful_companies c where not exists (
        select 1 from tasks t where t.type = 'scan_company' and t.payload->>'scanRunId' = ${runId}
        and t.payload->>'companyId' = c.company_id::text and t.status <> 'done'
      )) as companies_ok,
      (select coalesce(sum(s.new_count), 0)::int from scans s join career_sources cs on cs.id = s.source_id
        join followed f on f.company_id = cs.company_id where s.scan_run_id = ${runId}) as new_roles,
      (select coalesce(sum(s.closed_count), 0)::int from scans s join career_sources cs on cs.id = s.source_id
        join followed f on f.company_id = cs.company_id where s.scan_run_id = ${runId}) as closed_roles
  `);
  return result.rows[0]!;
}
