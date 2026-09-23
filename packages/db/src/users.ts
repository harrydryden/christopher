import type { User, UserRole } from "./schema";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { tagVocabulary, users } from "./schema";

/** The owner account the multi-user migration creates for a deployment that already held data. */
export const BOOTSTRAP_USER_ID = "00000000-0000-4000-8000-000000000001";
/**
 * Keeps the product's former name on purpose: migration 0020 wrote this address into existing
 * rows, and it is how those rows are recognised, so it must not follow the rename.
 */
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

/** Addresses that own this deployment unless ADMIN_EMAILS says otherwise. */
export const DEFAULT_ADMIN_EMAILS = ["harryddryden@gmail.com"];

/** ADMIN_EMAILS from the environment, or the built-in owner address when it is unset or blank. */
export function adminEmailsFrom(env: Record<string, string | undefined> = process.env): string[] {
  const listed = (env.ADMIN_EMAILS ?? "").split(",").map((e) => normaliseEmail(e)).filter(Boolean);
  return listed.length ? listed : DEFAULT_ADMIN_EMAILS;
}

/** Whether this address is one of the administrator addresses. */
export function isEntitledEmail(email: string, adminEmails: string[] = adminEmailsFrom()): boolean {
  return adminEmails.map(normaliseEmail).includes(normaliseEmail(email));
}

/** The migrated owner row keeps its placeholder address until an administrator address registers. */
export function isPlaceholderEmail(email: string): boolean {
  return normaliseEmail(email) === BOOTSTRAP_EMAIL;
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  passwordHash?: string | null;
  /** Explicit role for seeding and tests; the interface never passes one. */
  role?: UserRole;
  /** The address is already proven (Google verified it). Password sign-ups pass false. */
  emailVerified?: boolean;
}

export interface CreateUserResult {
  user: User;
  /** The row is the migrated owner, now assigned to this address. */
  claimedBootstrap: boolean;
  /** The address must be confirmed before the account can sign in. */
  pending: boolean;
}

/**
 * Register an address. Who gets what:
 * - An administrator address (ADMIN_EMAILS, by default the deployment owner) becomes an
 *   administrator and, while the migrated owner row is unclaimed, takes that row over with all of
 *   its companies, roles, decisions, library and CVs. Neither happens until the address is proven:
 *   at once for a Google sign-in Google has verified, otherwise when the confirmation link is
 *   completed with the account's password or a reset link is used. Until then the row is unclaimed
 *   and cannot sign in, so registering someone else's address gains nothing.
 * - Any other address becomes a member with a fresh, empty workspace, signed in straight away.
 * - Registering an address whose row is still unclaimed replaces its password and name only.
 */
export async function createUser(db: Db, input: CreateUserInput, options: { adminEmails?: string[]; now?: Date } = {}): Promise<CreateUserResult> {
  const now = options.now ?? new Date();
  const email = normaliseEmail(input.email);
  if (isPlaceholderEmail(email)) throw new Error("This address cannot be used for an account.");
  const entitled = isEntitledEmail(email, options.adminEmails ?? adminEmailsFrom());
  const verified = !!input.emailVerified;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
    const [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing?.claimedAt) throw new Error("An account with this email already exists.");
    const [bootstrap] = existing ? [] : await tx.select().from(users).where(eq(users.id, BOOTSTRAP_USER_ID)).limit(1);
    const takeover = !existing && entitled && bootstrap && !bootstrap.claimedAt && isPlaceholderEmail(bootstrap.email) ? bootstrap : null;
    const target = existing ?? takeover;
    // Entitlement waits for proof of the address; everyone else is a plain member from the start.
    const grantNow = verified || !entitled;
    const values = {
      email,
      name: input.name ?? target?.name ?? null,
      passwordHash: input.passwordHash ?? null,
      role: (grantNow ? (input.role ?? (entitled ? "admin" : "member")) : "member") as UserRole,
      emailVerifiedAt: verified ? now : null,
      claimedAt: grantNow ? now : null,
      lastLoginAt: now,
    };
    if (target) {
      const [updated] = await tx.update(users).set(values).where(eq(users.id, target.id)).returning();
      await seedTagVocabulary(tx, updated!.id);
      return { user: updated!, claimedBootstrap: updated!.id === BOOTSTRAP_USER_ID, pending: !values.claimedAt };
    }
    const [created] = await tx.insert(users).values({ ...values, createdAt: now }).returning();
    await seedTagVocabulary(tx, created!.id);
    return { user: created!, claimedBootstrap: false, pending: !values.claimedAt };
  });
}

/**
 * The address has just been proven by its owner (confirmation link completed with the password,
 * a reset link used, or a verified Google sign-in): mark it verified, claim the row so it can sign
 * in, and grant the administrator role when the address is entitled to it.
 */
export async function completeAccountClaim(db: Db, userId: string, options: { adminEmails?: string[]; now?: Date } = {}): Promise<User | null> {
  const now = options.now ?? new Date();
  const adminEmails = options.adminEmails ?? adminEmailsFrom();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || isPlaceholderEmail(user.email)) return null;
    const [updated] = await tx
      .update(users)
      .set({
        emailVerifiedAt: user.emailVerifiedAt ?? now,
        claimedAt: user.claimedAt ?? now,
        role: isEntitledEmail(user.email, adminEmails) ? "admin" : user.role,
        lastLoginAt: now,
      })
      .where(eq(users.id, userId))
      .returning();
    return updated ?? null;
  });
}

/** An entitled, verified account that is still a member (the address was listed later) becomes an administrator on sign-in. */
export async function promoteIfEntitled(db: Writer, user: User, adminEmails: string[] = adminEmailsFrom()): Promise<User> {
  if (user.role === "admin" || !user.emailVerifiedAt || !user.claimedAt || !isEntitledEmail(user.email, adminEmails)) return user;
  const [updated] = await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id)).returning();
  return updated ?? user;
}

/** Accounts that can sign in (unclaimed rows have nothing to run for yet). */
export async function listUserIds(db: Writer): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users).where(sql`${users.claimedAt} is not null`);
  return rows.map(r => r.id);
}
