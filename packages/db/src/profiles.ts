import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { preferenceProfiles } from "./schema";

type ProfileInput = Omit<typeof preferenceProfiles.$inferInsert, "id" | "version" | "userId">;

/** Append an immutable version of one account's profile, rejecting writes based on an obsolete one. */
export async function appendProfile(db: Db, userId: string, expectedVersion: number, input: ProfileInput) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`christopher:profiles:${userId}`}))`);
    const [latest] = await tx.select().from(preferenceProfiles).where(eq(preferenceProfiles.userId, userId)).orderBy(desc(preferenceProfiles.version)).limit(1);
    if ((latest?.version ?? 0) !== expectedVersion) throw new Error("The preference profile changed. Reload before saving.");
    const [profile] = await tx.insert(preferenceProfiles).values({ ...input, userId, version: expectedVersion + 1 }).returning();
    return profile!;
  });
}

export async function latestProfileFor(db: Db, userId: string) {
  const [row] = await db.select().from(preferenceProfiles).where(and(eq(preferenceProfiles.userId, userId))).orderBy(desc(preferenceProfiles.version)).limit(1);
  return row ?? null;
}
