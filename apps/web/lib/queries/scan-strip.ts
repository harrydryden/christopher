/**
 * The per-account figures behind the status strip that are not already counted elsewhere: when a
 * company this account follows was last scanned, and how many it follows. The role and company
 * match counts come from the queries their own pages use, so the strip and the page never disagree.
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { careerSources, companySubscriptions, scans } from "@ava/db/schema";
import { db } from "@/lib/db";

/**
 * When the most recent scan of any source of a company this account actively follows finished
 * without failing. Scans are shared, so this is the catalogue's scan seen through the account's
 * subscriptions; null until one has completed.
 */
export async function lastCompletedScanAt(userId: string): Promise<Date | null> {
  const [row] = await db()
    .select({ at: sql<Date | string | null>`max(${scans.finishedAt})` })
    .from(scans)
    .innerJoin(careerSources, eq(careerSources.id, scans.sourceId))
    .innerJoin(companySubscriptions, eq(companySubscriptions.companyId, careerSources.companyId))
    .where(and(
      eq(companySubscriptions.userId, userId),
      eq(companySubscriptions.status, "active"),
      isNotNull(scans.finishedAt),
      ne(scans.status, "failed"),
    ));
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
