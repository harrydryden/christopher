import { enqueueStandard, type Db } from "@col/db";
import { sql } from "drizzle-orm";
import { MAX_DESCRIPTION_RETRY_ATTEMPTS } from "./description-retry";

/** Repair a lost queue deferral without starting a second detail read or changing retry budgets. */
export async function queueDueDescriptionChecks(db: Db, now: Date, limit = 40): Promise<number> {
  return db.transaction(async tx => {
    const due = await tx.execute<{ id: string }>(sql`select j.id from jobs j
      join career_sources cs on cs.id = j.source_id and cs.company_id = j.company_id
      join companies c on c.id = j.company_id
      where j.status = 'open' and j.url is not null and j.description_next_attempt_at <= ${now}
        and j.description_retry_attempts > 0 and j.description_retry_attempts < ${MAX_DESCRIPTION_RETRY_ATTEMPTS}
        and j.description_last_error is not null and c.status = 'active'
        and cs.status in ('active', 'failing')
        and exists (select 1 from company_subscriptions s where s.company_id = j.company_id
          and s.status = 'active' and (j.shared or s.user_id = j.added_by))
        and not exists (select 1 from tasks t where t.type = 'fetch_description'
          and t.payload->>'jobId' = j.id::text and t.status in ('queued', 'running'))
        and not exists (select 1 from tasks t where t.type = 'fetch_description'
          and t.payload->>'jobId' = j.id::text and t.status = 'failed'
          and t.finished_at >= j.description_attempted_at)
      order by j.description_next_attempt_at, j.id limit ${limit} for update of j skip locked`);
    let queued = 0;
    for (const row of due.rows) {
      const id = await enqueueStandard(tx as unknown as Db, "fetch_description", { jobId: row.id });
      if (id) queued++;
    }
    return queued;
  });
}
