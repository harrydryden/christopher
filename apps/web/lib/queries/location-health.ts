import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ifMigrated } from "@/lib/schema-skew";

export interface LocationCheck {
  jobId: string;
  companyId: string;
  companyName: string;
  title: string;
  state: "pending" | "unavailable";
  revision: string | null;
  taskActive: boolean;
  taskStatus: "queued" | "running" | null;
  nextAttemptAt: Date | null;
}

export interface LocationChecks {
  total: number;
  pending: number;
  unavailable: number;
  rows: LocationCheck[];
}

type RawLocationCheck = Record<string, unknown> & Omit<LocationCheck, "nextAttemptAt"> & {
  nextAttemptAt: Date | string | null;
  total: number | string;
  pending: number | string;
  unavailable: number | string;
};

/** Only open Workday postings at companies this account actively follows. */
export async function locationChecks(userId: string, companyId?: string, limit = 8): Promise<LocationChecks> {
  return ifMigrated(async () => {
    const result = await db().execute<RawLocationCheck>(sql`
      select j.id as "jobId", c.id as "companyId", c.name as "companyName", j.title,
        j.location_resolution as state, j.location_revision as revision,
        (loc_task.id is not null) as "taskActive", loc_task.status as "taskStatus",
        loc_task.run_after as "nextAttemptAt",
        count(*) over ()::int as total,
        count(*) filter (where j.location_resolution = 'pending') over ()::int as pending,
        count(*) filter (where j.location_resolution = 'unavailable') over ()::int as unavailable
      from jobs j
      join career_sources s on s.id = j.source_id and s.company_id = j.company_id
        and s.type = 'workday' and s.status in ('active', 'failing')
      join companies c on c.id = j.company_id and c.status = 'active'
      join company_subscriptions cs on cs.company_id = c.id and cs.user_id = ${userId} and cs.status = 'active'
      left join lateral (
        select t.id, t.status, t.run_after from tasks t
        where t.type = 'fetch_locations' and t.status in ('queued', 'running')
          and t.dedupe_key = 'fetch_locations:' || j.id::text || ':' || j.location_revision
        order by case when t.status = 'running' then 0 else 1 end, t.run_after, t.created_at desc
        limit 1
      ) loc_task on true
      where j.status = 'open' and (j.shared or j.added_by = ${userId}::uuid)
        and j.location_resolution in ('pending', 'unavailable')
        ${companyId ? sql`and c.id = ${companyId}::uuid` : sql``}
      order by case when j.location_resolution = 'unavailable' then 0 else 1 end, c.name, j.title, j.id
      limit ${Math.max(1, Math.min(limit, 100))}`);
    const rows = result.rows.map(({ total: _total, pending: _pending, unavailable: _unavailable, ...row }) => ({
      ...row, nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : null,
    }));
    return {
      total: Number(result.rows[0]?.total ?? 0),
      pending: Number(result.rows[0]?.pending ?? 0),
      unavailable: Number(result.rows[0]?.unavailable ?? 0),
      rows,
    };
  }, () => ({ total: 0, pending: 0, unavailable: 0, rows: [] }));
}
