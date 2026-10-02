import { sql } from "drizzle-orm";
import type { Db } from "./client";

/**
 * Transaction-scoped fences for inputs that have no stable row to lock (the newest profile,
 * Library and decision digest can all gain a new row). Call these at transaction entry, before
 * any role, draft, settings or profile lock. A publisher holds shared locks while it checks and
 * writes; an input writer holds the exclusive lock until its mutation and follow-up task commit.
 * The global model fence always precedes the account fence.
 */
export async function lockScoreModelInput(db: Db, mode: "shared" | "exclusive"): Promise<void> {
  if (mode === "shared") await db.execute(sql`select pg_advisory_xact_lock_shared(874301, 1)`);
  else await db.execute(sql`select pg_advisory_xact_lock(874301, 1)`);
}

export async function lockAccountScoreInput(db: Db, userId: string, mode: "shared" | "exclusive"): Promise<void> {
  if (mode === "shared") await db.execute(sql`select pg_advisory_xact_lock_shared(874302, hashtext(${userId}))`);
  else await db.execute(sql`select pg_advisory_xact_lock(874302, hashtext(${userId}))`);
}

/** Automated rescoring is model work; an unconfirmed member may save text without starting it. */
export async function accountCanScore(db: Db, userId: string): Promise<boolean> {
  const found = await db.execute<{ allowed: boolean }>(sql`select (role = 'admin' or email_verified_at is not null) as allowed
    from users where id = ${userId}::uuid`);
  return found.rows[0]?.allowed === true;
}
