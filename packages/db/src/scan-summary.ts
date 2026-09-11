import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** New counts are insert counts across attempts; health uses the latest attempt per source. */
export async function scanRunSummary(db: Db, runId: string) {
  const result = await db.execute<{ sources: number; pending: number; companies_ok: number; new_roles: number; closed_roles: number }>(sql`
    with latest_sources as (
      select distinct on (s.source_id) s.source_id, cs.company_id, s.status, s.finished_at
      from scans s join career_sources cs on cs.id = s.source_id
      where s.scan_run_id = ${runId}
      order by s.source_id, s.started_at desc, s.id desc
    ), successful_companies as (
      select company_id from latest_sources group by company_id
      having bool_and(status = 'ok' and finished_at is not null)
    )
    select
      (select count(*)::int from latest_sources) as sources,
      (select count(*)::int from tasks where type = 'scan_company'
        and payload->>'scanRunId' = ${runId} and status in ('queued','running')) as pending,
      (select count(*)::int from successful_companies c where not exists (
        select 1 from tasks t where t.type = 'scan_company' and t.payload->>'scanRunId' = ${runId}
        and t.payload->>'companyId' = c.company_id::text and t.status <> 'done'
      )) as companies_ok,
      coalesce(sum(new_count), 0)::int as new_roles,
      coalesce(sum(closed_count), 0)::int as closed_roles
    from scans where scan_run_id = ${runId}
  `);
  return result.rows[0]!;
}
