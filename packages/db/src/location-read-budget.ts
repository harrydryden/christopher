import { sql } from "drizzle-orm";
import type { Db } from "./client";

export const WORKDAY_LOCATION_READS_PER_HOUR = 50;
const WINDOW_MS = 60 * 60_000;

/**
 * Reserve exactly one Workday detail request before the network call. Concurrent workers contend
 * on this source's budget row; a denied task keeps its durable queue row and resumes next window.
 * Reservations count attempts, including failed HTTP reads, and are never refunded.
 */
export async function reserveLocationRead(
  db: Pick<Db, "execute">,
  sourceId: string,
  now: Date,
): Promise<{ allowed: true } | { allowed: false; retryAt: Date }> {
  const granted = await db.execute<{ windowStartedAt: Date }>(sql`
    insert into workday_location_read_budgets as b (source_id, window_started_at, request_count)
    values (${sourceId}::uuid, ${now}::timestamptz, 1)
    on conflict (source_id) do update set
      window_started_at = case when b.window_started_at <= ${now}::timestamptz - interval '1 hour'
        then ${now}::timestamptz else b.window_started_at end,
      request_count = case when b.window_started_at <= ${now}::timestamptz - interval '1 hour'
        then 1 else b.request_count + 1 end
    where b.window_started_at <= ${now}::timestamptz - interval '1 hour'
      or b.request_count < ${WORKDAY_LOCATION_READS_PER_HOUR}
    returning window_started_at as "windowStartedAt"`);
  if (granted.rows.length) return { allowed: true };
  const current = await db.execute<{ windowStartedAt: Date }>(sql`
    select window_started_at as "windowStartedAt" from workday_location_read_budgets
    where source_id = ${sourceId}::uuid`);
  const windowStartedAt = current.rows[0]?.windowStartedAt;
  // The row could be deleted concurrently with its source. The task will re-check source
  // existence when it runs; a short delay avoids a hot retry loop meanwhile.
  const windowEnd = windowStartedAt ? new Date(windowStartedAt).getTime() + WINDOW_MS : 0;
  return { allowed: false, retryAt: new Date(windowEnd > now.getTime() ? windowEnd : now.getTime() + 1000) };
}
