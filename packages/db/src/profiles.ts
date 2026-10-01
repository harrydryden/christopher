import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { preferenceProfiles } from "./schema";
import { accountCanScore, lockAccountScoreInput } from "./score-fence";
import { enqueueStandard } from "./tasks";

type ProfileInput = Omit<typeof preferenceProfiles.$inferInsert, "id" | "version" | "userId">;

export class ProfileVersionConflictError extends Error {
  constructor() {
    super("The preference profile changed. Reload before saving.");
    this.name = "ProfileVersionConflictError";
  }
}

/** Append an immutable version of one account's profile, rejecting writes based on an obsolete one. */
export async function appendProfile(db: Db, userId: string, expectedVersion: number, input: ProfileInput) {
  return db.transaction(async (tx) => {
    await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ava:profiles:${userId}`}))`);
    const [latest] = await tx.select().from(preferenceProfiles).where(eq(preferenceProfiles.userId, userId)).orderBy(desc(preferenceProfiles.version)).limit(1);
    if ((latest?.version ?? 0) !== expectedVersion) throw new ProfileVersionConflictError();
    const [profile] = await tx.insert(preferenceProfiles).values({ ...input, userId, version: expectedVersion + 1 }).returning();
    if (latest?.markdown !== input.markdown && await accountCanScore(tx as unknown as Db, userId))
      await enqueueStandard(tx as unknown as Db, "rescore_all", { userId, onlyInTable: true });
    return profile!;
  });
}

export async function latestProfileFor(db: Db, userId: string) {
  const [row] = await db.select().from(preferenceProfiles).where(and(eq(preferenceProfiles.userId, userId))).orderBy(desc(preferenceProfiles.version)).limit(1);
  return row ?? null;
}
