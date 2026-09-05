import { desc, sql } from "drizzle-orm";
import type { Db } from "./client";
import { preferenceProfiles } from "./schema";

type ProfileInput = Omit<typeof preferenceProfiles.$inferInsert, "id" | "version">;

/** Append an immutable version, rejecting writes based on an obsolete profile. */
export async function appendProfile(db: Db, expectedVersion: number, input: ProfileInput) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:profiles'))`);
    const [latest] = await tx.select().from(preferenceProfiles).orderBy(desc(preferenceProfiles.version)).limit(1);
    if ((latest?.version ?? 0) !== expectedVersion) throw new Error("The preference profile changed. Reload before saving.");
    const [profile] = await tx.insert(preferenceProfiles).values({ ...input, version: expectedVersion + 1 }).returning();
    return profile!;
  });
}
