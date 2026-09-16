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
