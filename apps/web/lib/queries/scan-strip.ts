/**
 * The per-account figures behind the status strip that are not already counted elsewhere: when a
 * company this account follows was last scanned, and how many it follows. The role and company
 * match counts come from the queries their own pages use, so the strip and the page never disagree.
 */
import { and, eq, sql } from "drizzle-orm";
import { careerSources, companySubscriptions, scans } from "@ava/db/schema";
import { db } from "@/lib/db";

/**
 * When the most recent scan of any source of a company this account actively follows finished
 * without failing. Scans are shared, so this is the catalogue's scan seen through the account's
 * subscriptions; null until one has completed.
 *
 * One index probe per followed source (`scans_source_completed_idx` answers each `max` from its
 * newest entry), so the cost follows how many sources the account follows, not how many scans the
 * whole catalogue has kept: joining every retained scan cost 3 ms at 7,560 rows and grew daily.
 */
export const lastCompletedScanAtSql = (userId: string) => sql<Date | string | null>`(
  select max(latest.at)
  from ${companySubscriptions} cs
  join ${careerSources} src on src.company_id = cs.company_id
  cross join lateral (
    select max(s.finished_at) as at from ${scans} s
    where s.source_id = src.id and s.finished_at is not null and s.status <> 'failed'
  ) latest
  where cs.user_id = ${userId} and cs.status = 'active'
)`;

export async function lastCompletedScanAt(userId: string): Promise<Date | null> {
  const [row] = await db().select({ at: lastCompletedScanAtSql(userId) }).from(sql`(select 1) one`);
  const at = row?.at;
  return at ? new Date(at) : null;
}

/** Companies this account follows and has neither paused nor archived. */
export async function followingCount(userId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(companySubscriptions)
    .where(and(eq(companySubscriptions.userId, userId), eq(companySubscriptions.status, "active")));
  return row?.n ?? 0;
}
