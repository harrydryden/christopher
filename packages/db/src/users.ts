import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { tagVocabulary, users } from "./schema";

/** The owner account the multi-user migration creates for a deployment that already held data. */
export const BOOTSTRAP_USER_ID = "00000000-0000-4000-8000-000000000001";
export const BOOTSTRAP_EMAIL = "owner@christopher.invalid";

export const SEED_TAGS: Array<{ tag: string; description: string }> = [
  { tag: "seniority:too_junior", description: "Role is below the target seniority band" },
  { tag: "seniority:too_senior", description: "Role is above the target seniority band" },
  { tag: "location:not_commutable", description: "Location is too far to commute" },
  { tag: "location:wrong_country", description: "Location is in the wrong country" },
  { tag: "domain:uninterested", description: "Subject domain does not appeal" },
  { tag: "domain:interested", description: "Subject domain appeals" },
  { tag: "role_type:not_operations", description: "Not the kind of operations work wanted" },
  { tag: "company:stage", description: "Company stage is wrong" },
  { tag: "company:sector", description: "Company sector is wrong" },
  { tag: "comp:too_low", description: "Compensation below the floor" },
  { tag: "title:mismatch", description: "Title does not match the work wanted" },
  { tag: "timing", description: "Wrong timing" },
  { tag: "already_applied", description: "Already applied to this or a similar role" },
];

type Writer = Pick<Db, "select" | "insert" | "update" | "execute">;

/** Every account starts with the controlled reason vocabulary; the model may propose more later. */
export async function seedTagVocabulary(db: Writer, userId: string): Promise<void> {
  await db.insert(tagVocabulary).values(SEED_TAGS.map((t) => ({ ...t, userId, createdBy: "seed" as const }))).onConflictDoNothing();
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  passwordHash?: string | null;
  role?: "admin" | "member";
  emailVerified?: boolean;
}

/**
 * Create an account, or claim the migrated owner account when this is the first registration
 * (or the registering address is entitled to it). The first account ever created is an admin.
 */
export async function createUser(db: Db, input: CreateUserInput, options: { adminEmails?: string[]; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const email = normaliseEmail(input.email);
  const adminEmails = (options.adminEmails ?? []).map(normaliseEmail);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:users'))`);
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) throw new Error("An account with this email already exists.");
    const [bootstrap] = await tx.select().from(users).where(eq(users.id, BOOTSTRAP_USER_ID)).limit(1);
    const canClaim = bootstrap && !bootstrap.claimedAt && (adminEmails.length === 0 || adminEmails.includes(email));
    const [counted] = await tx.select({ count: sql<number>`count(*)::int` }).from(users);
    const count = counted?.count ?? 0;
    const role: "admin" | "member" = input.role ?? (adminEmails.includes(email) || count === 0 || !!canClaim ? "admin" : "member");
    const values = {
      email,
      name: input.name ?? null,
      passwordHash: input.passwordHash ?? null,
      role,
      emailVerifiedAt: input.emailVerified ? now : null,
      claimedAt: now,
    };
    if (canClaim) {
      const [claimed] = await tx.update(users).set({ ...values, lastLoginAt: now }).where(eq(users.id, BOOTSTRAP_USER_ID)).returning();
      await seedTagVocabulary(tx, claimed!.id);
      return { user: claimed!, claimedBootstrap: true };
    }
    const [created] = await tx.insert(users).values({ ...values, createdAt: now, lastLoginAt: now }).returning();
    await seedTagVocabulary(tx, created!.id);
    return { user: created!, claimedBootstrap: false };
  });
}

/** Accounts that can sign in (the unclaimed bootstrap owner has nothing to run for yet). */
export async function listUserIds(db: Writer): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users).where(sql`${users.claimedAt} is not null`);
  return rows.map(r => r.id);
}
