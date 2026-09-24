import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { companies, companySubscriptions } from "./schema";

type Writer = Pick<Db, "select" | "insert" | "update" | "execute">;

/**
 * A company's shared status follows its followers: active while anyone follows it actively,
 * paused while every follower has paused it, archived when nobody follows it. The scheduler and
 * the scan handler read the column; every subscription change calls this.
 */
export async function syncCompanyStatus(db: Writer, companyId: string): Promise<"active" | "paused" | "archived"> {
  const [row] = await db.execute<{ status: "active" | "paused" | "archived" }>(sql`
    select case
      when exists (select 1 from company_subscriptions s where s.company_id = ${companyId} and s.status = 'active') then 'active'
      when exists (select 1 from company_subscriptions s where s.company_id = ${companyId} and s.status = 'paused') then 'paused'
      else 'archived' end as status`).then(r => r.rows);
  const status = row?.status ?? "archived";
  await db.update(companies)
    .set({ status, archivedAt: status === "archived" ? sql`coalesce(${companies.archivedAt}, now())` : null })
    .where(eq(companies.id, companyId));
  return status;
}

/** Follow a company. Idempotent: an existing subscription is reactivated rather than duplicated. */
export async function subscribeToCompany(db: Writer, userId: string, companyId: string): Promise<{ created: boolean; reactivated: boolean }> {
  const [existing] = await db.select({ id: companySubscriptions.id, status: companySubscriptions.status }).from(companySubscriptions)
    .where(and(eq(companySubscriptions.userId, userId), eq(companySubscriptions.companyId, companyId))).limit(1);
  let created = false;
  let reactivated = false;
  if (!existing) {
    const inserted = await db.insert(companySubscriptions).values({ userId, companyId }).onConflictDoNothing().returning({ id: companySubscriptions.id });
    created = inserted.length > 0;
  } else if (existing.status !== "active") {
    await db.update(companySubscriptions).set({ status: "active", archivedAt: null }).where(eq(companySubscriptions.id, existing.id));
    reactivated = true;
  }
  await syncCompanyStatus(db, companyId);
  return { created, reactivated };
}

export async function setSubscriptionStatus(db: Writer, userId: string, companyId: string, status: "active" | "paused" | "archived"): Promise<boolean> {
  const updated = await db.update(companySubscriptions)
    .set({ status, archivedAt: status === "archived" ? new Date() : null })
    .where(and(eq(companySubscriptions.userId, userId), eq(companySubscriptions.companyId, companyId)))
    .returning({ id: companySubscriptions.id });
  if (!updated.length) return false;
  await syncCompanyStatus(db, companyId);
  return true;
}

/** Company ids one account follows, optionally limited to some subscription statuses. */
export async function subscribedCompanyIds(db: Writer, userId: string, statuses: Array<"active" | "paused" | "archived"> = ["active", "paused"]): Promise<string[]> {
  const rows = await db.select({ companyId: companySubscriptions.companyId }).from(companySubscriptions)
    .where(and(eq(companySubscriptions.userId, userId), inArray(companySubscriptions.status, statuses)));
  return rows.map(r => r.companyId);
}

/** The job event a retired role carries: a closure, and the reason it was not a scan's. */
export const SOURCE_RETIRED_REASON = "source_retired";

/**
 * Close the open roles of sources nobody scans any more: a source disabled (by a person, or
 * superseded when discovery confirmed another), and every source of a company nobody follows.
 * Nothing will ever reconcile those roles again, so left open they would read as live for ever,
 * and a company followed again would admit months-old "open" roles.
 *
 * This is not a scan's closure and does not pretend to be one: no listing was read. It is the
 * lifecycle of the source, caused by a person or by discovery. `closed_at` is the last time a
 * scan saw the role, and the `closed` event says why (`reason: source_retired`). Only roles a
 * scan observed are retired; a role a follower pasted was never that source's to lose. A source
 * that comes back into use reopens what it still lists on its next scan, as any closed role is.
 *
 * Without a scope it sweeps the whole catalogue (the daily run does); an action that disables one
 * source passes that `sourceId`.
 */
export async function retireSourceRoles(db: Writer, scope: { sourceId?: string; companyId?: string } = {}, now = new Date()): Promise<number> {
  const sourceId = scope.sourceId ?? null;
  const companyId = scope.companyId ?? null;
  const result = await db.execute(sql`with retired as (
      update jobs j set status = 'closed', closed_at = j.last_seen_at, updated_at = ${now}
      from career_sources cs join companies c on c.id = cs.company_id
      where cs.id = j.source_id and j.status = 'open' and j.origin = 'scan'
        and (cs.status = 'disabled' or c.status = 'archived')
        and (${sourceId}::uuid is null or cs.id = ${sourceId}::uuid)
        and (${companyId}::uuid is null or c.id = ${companyId}::uuid)
      returning j.id, j.source_id
    )
    insert into job_events (job_id, type, payload)
    select id, 'closed', jsonb_build_object('reason', ${SOURCE_RETIRED_REASON}::text, 'sourceId', source_id) from retired
    returning job_id`);
  return result.rows.length;
}
