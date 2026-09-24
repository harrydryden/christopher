/**
 * Account lifecycle: registration, password sign-in, Google sign-in and linking, email
 * confirmation, password changes and resets. Pure database work; sessions and cookies are lib/auth.
 *
 * Two things are sensitive and wait for proof that the person owns the address: the administrator
 * role and taking over the migrated owner's data. Proof is a Google sign-in Google has verified, the
 * confirmation link completed with the account's password, or a reset link used to set a password.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { adminEmailsFrom, completeAccountClaim, createUser, isEntitledEmail, isPlaceholderEmail, normaliseEmail, promoteIfEntitled, type CreateUserResult } from "@ava/db";
import { authAccounts, authTokens, cvVersions, sessions, users, type User } from "@ava/db/schema";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "@ava/core";
import { consumeAuthToken, issueAuthToken, peekAuthToken } from "./auth-tokens";
import { db } from "./db";
import { sendEmail } from "./email";
import type { GoogleProfile } from "./google";
import { getSystemSettings } from "./settings";
import { UserFacingError } from "./validation";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let defaultAdminWarned = false;

/**
 * Addresses that become administrators once proven, and the only ones that may take over migrated
 * data. Unset, they fall back to the built-in owner address, which keeps a live deployment from
 * being locked out; in production that is said in the log, once per instance, because it hands
 * administration of every account to one fixed outside mailbox.
 */
export function adminEmails(): string[] {
  if (process.env.NODE_ENV === "production" && !defaultAdminWarned && !(process.env.ADMIN_EMAILS ?? "").split(",").some((e) => e.trim())) {
    defaultAdminWarned = true;
    console.warn(JSON.stringify({ event: "admin_emails_default", hint: "ADMIN_EMAILS is unset, so the built-in default administrator address applies. Set it to this deployment's administrators." }));
  }
  return adminEmailsFrom(process.env);
}

export function isAdminEmail(email: string): boolean {
  return isEntitledEmail(email, adminEmails());
}

export function emailProblem(email: string): string | null {
  const value = normaliseEmail(email);
  if (!value || value.length > 254 || !EMAIL_RE.test(value) || value.endsWith(".invalid") || isPlaceholderEmail(value)) return "Enter a valid email address.";
  return null;
}

/** Administrator addresses may always register; everyone else only while an administrator has opened registration. */
export async function registrationAllowed(email: string): Promise<boolean> {
  if (isAdminEmail(email)) return true;
  return (await getSystemSettings()).registrationOpen;
}

/** A hash to verify against when no account matches, so a wrong email costs the same time as a wrong password. */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword("decoy-password-for-constant-time-checks");
  return decoyHash;
}

export async function registerWithPassword(input: { email: string; password: string; name?: string }): Promise<CreateUserResult> {
  const emailError = emailProblem(input.email);
  if (emailError) throw new Error(emailError);
  const passwordError = passwordProblem(input.password);
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await hashPassword(input.password);
  return createUser(db(), { email: input.email, name: input.name?.trim().slice(0, 200) || null, passwordHash }, { adminEmails: adminEmails() });
}

export type PasswordSignIn = { status: "ok"; user: User } | { status: "unconfirmed" } | { status: "invalid" };

/** Check a password. An unclaimed row (an administrator address that has not confirmed yet) cannot sign in even with the right password. */
export async function authenticateWithPassword(email: string, password: string): Promise<PasswordSignIn> {
  const [user] = await db().select().from(users).where(eq(users.email, normaliseEmail(email))).limit(1);
  const hash = user?.passwordHash ?? (await decoy());
  const ok = await verifyPassword(password, hash);
  if (!user || !user.passwordHash || !ok) return { status: "invalid" };
  if (!user.claimedAt) return { status: "unconfirmed" };
  let current = user;
  if (needsRehash(user.passwordHash)) {
    const [rehashed] = await db().update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, user.id)).returning();
    current = rehashed ?? current;
  }
  return { status: "ok", user: await promoteIfEntitled(db(), current, adminEmails()) };
}

/**
 * Sign in with a Google identity. A known Google account signs in. Otherwise Google must have
 * verified the address; then a row waiting for confirmation is completed (its unproven password
 * dropped), an existing account is linked (an unverified password account is taken over the same
 * way, since nobody proved that address before), and anything else creates an account, subject to
 * the registration policy.
 */
export async function signInWithGoogle(profile: GoogleProfile): Promise<{ user: User; created: boolean }> {
  const email = normaliseEmail(profile.email);
  const [linked] = await db()
    .select({ user: users })
    .from(authAccounts)
    .innerJoin(users, eq(users.id, authAccounts.userId))
    .where(and(eq(authAccounts.provider, "google"), eq(authAccounts.providerAccountId, profile.sub)))
    .limit(1);
  if (linked) return { user: await promoteIfEntitled(db(), linked.user, adminEmails()), created: false };
  if (!profile.emailVerified) throw new Error("Google has not verified this email address, so it cannot be used to sign in.");
  if (emailProblem(email)) throw new Error("Google returned an unusable email address.");

  const [existing] = await db().select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    const unproven = !existing.emailVerifiedAt && !!existing.passwordHash;
    await db().transaction(async (tx) => {
      if (unproven) {
        await tx.update(users).set({ passwordHash: null }).where(eq(users.id, existing.id));
        await tx.delete(sessions).where(eq(sessions.userId, existing.id));
      }
      await tx.insert(authAccounts).values({ userId: existing.id, provider: "google", providerAccountId: profile.sub, email, name: profile.name ?? null }).onConflictDoNothing();
    });
    const user = await completeAccountClaim(db(), existing.id, { adminEmails: adminEmails() });
    if (!user) throw new Error("This account cannot sign in.");
    return { user, created: false };
  }
  if (!(await registrationAllowed(email))) throw new Error("Registration is closed on this deployment.");
  const { user } = await createUser(db(), { email, name: profile.name ?? null, emailVerified: true }, { adminEmails: adminEmails() });
  await db().insert(authAccounts).values({ userId: user.id, provider: "google", providerAccountId: profile.sub, email, name: profile.name ?? null }).onConflictDoNothing();
  return { user, created: true };
}

export async function linkedProviders(userId: string) {
  return db().select().from(authAccounts).where(eq(authAccounts.userId, userId));
}

/**
 * Set or change the password. The current one is required whenever the account already has one.
 *
 * The new hash, the end of every outstanding reset and confirmation link, and (given the session to
 * keep) the end of every other session land in one transaction: a reset link requested by whoever
 * briefly had the mailbox must not outlive the change, and no browser signed in with the old
 * password survives a change that half-happened.
 */
export async function changePassword(user: User, currentPassword: string, nextPassword: string, keepSessionId?: string): Promise<void> {
  if (user.passwordHash) {
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new Error("The current password is not right.");
  }
  const problem = passwordProblem(nextPassword);
  if (problem) throw new Error(problem);
  const passwordHash = await hashPassword(nextPassword);
  await db().transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await tx.update(authTokens).set({ usedAt: new Date() }).where(and(eq(authTokens.userId, user.id), isNull(authTokens.usedAt)));
    if (keepSessionId) await tx.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, keepSessionId)));
  });
}

/** Always quiet about whether an address is registered. A row waiting for confirmation may reset too: the link proves the address. */
export async function requestPasswordReset(email: string, origin: string | null): Promise<void> {
  const [user] = await db().select().from(users).where(eq(users.email, normaliseEmail(email))).limit(1);
  if (!user || isPlaceholderEmail(user.email) || !origin) return;
  const token = await issueAuthToken(user.id, "password_reset");
  await sendEmail({
    to: user.email,
    subject: "Reset your AVA password",
    text: `Someone asked to reset the password for this AVA account.\n\nSet a new password here (the link works once, for an hour):\n${origin}/reset-password?token=${token}\n\nIf that was not you, ignore this message; nothing has changed.`,
  });
}

/** The link proves the address, so this also completes a pending confirmation and whatever it entitles. */
export async function resetPasswordWithToken(token: string, password: string): Promise<User | null> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const consumed = await consumeAuthToken(token, "password_reset");
  if (!consumed) return null;
  await db().update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, consumed.userId));
  const user = await completeAccountClaim(db(), consumed.userId, { adminEmails: adminEmails() });
  if (!user) return null;
  // Whoever held the old password is signed out everywhere.
  await db().delete(sessions).where(eq(sessions.userId, user.id));
  return user;
}

export async function sendVerificationEmail(user: User, origin: string | null): Promise<{ delivered: boolean }> {
  if (user.emailVerifiedAt || !origin) return { delivered: false };
  const token = await issueAuthToken(user.id, "email_verification");
  return sendEmail({
    to: user.email,
    subject: "Confirm your email for AVA",
    text: `Confirm this address for your AVA account (the link works once, for a day, and asks for your password):\n${origin}/auth/verify?token=${token}\n\nIf you did not create an account, ignore this message.`,
  });
}

export interface VerificationPreview {
  userId: string;
  email: string;
  hasPassword: boolean;
  /** The account cannot sign in until this confirmation completes. */
  pending: boolean;
}

/** What a confirmation link refers to, without spending it. */
export async function previewVerification(token: string): Promise<VerificationPreview | null> {
  const found = await peekAuthToken(token, "email_verification");
  if (!found) return null;
  const [user] = await db().select().from(users).where(eq(users.id, found.userId)).limit(1);
  if (!user || isPlaceholderEmail(user.email)) return null;
  return { userId: user.id, email: user.email, hasPassword: !!user.passwordHash, pending: !user.claimedAt };
}

export type EmailConfirmation = { status: "done"; user: User } | { status: "invalid" } | { status: "password" };

/**
 * Complete a confirmation link. The mailbox alone is not enough: the person confirming must be the
 * one who set the password, so either a session for that account or the password is required. That
 * is what stops a stranger registering your address and having you confirm it for them.
 */
export async function confirmEmailWithToken(token: string, proof: { sessionUserId?: string | null; password?: string }): Promise<EmailConfirmation> {
  const preview = await previewVerification(token);
  if (!preview) return { status: "invalid" };
  if (proof.sessionUserId !== preview.userId) {
    const [user] = await db().select().from(users).where(eq(users.id, preview.userId)).limit(1);
    const hash = user?.passwordHash ?? (await decoy());
    const ok = await verifyPassword(proof.password ?? "", hash);
    if (!user?.passwordHash || !ok) return { status: "password" };
  }
  const consumed = await consumeAuthToken(token, "email_verification");
  if (!consumed || consumed.userId !== preview.userId) return { status: "invalid" };
  const user = await completeAccountClaim(db(), consumed.userId, { adminEmails: adminEmails() });
  return user ? { status: "done", user } : { status: "invalid" };
}

/** A reset link an administrator can hand to someone when email delivery is not set up. Works once, for an hour. */
export async function issueResetLink(userId: string, origin: string): Promise<string> {
  const token = await issueAuthToken(userId, "password_reset");
  return `${origin}/reset-password?token=${token}`;
}

/**
 * Remove an account on an administrator's behalf. Two administrators removing each other at once,
 * or one removing the account that made them an administrator moments earlier, must not leave the
 * deployment with nobody who can sign in as one. So the whole thing runs under one lock on the
 * accounts, and the caller is re-read inside it: while the caller is a claimed administrator and
 * is not the target, at least one claimed administrator survives the commit. The action checks the
 * caller's right to be here; this re-checks it against the race.
 */
export async function deleteAccount(callerId: string, targetId: string): Promise<void> {
  if (callerId === targetId) throw new UserFacingError("You cannot delete your own account here.");
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
    const [caller] = await tx.select({ role: users.role, claimedAt: users.claimedAt }).from(users).where(eq(users.id, callerId));
    if (caller?.role !== "admin" || !caller.claimedAt) throw new UserFacingError("You are no longer an administrator.");
    await tx.delete(sessions).where(eq(sessions.userId, targetId));
    // The account's CV rows cascade; the per-day version numbers are keyed by role rather than by
    // account, so they are removed by the account prefix of that key.
    await tx.execute(sql`delete from ${cvVersions} where ${cvVersions.roleKey} like ${`${targetId}:%`}`);
    await tx.delete(users).where(eq(users.id, targetId));
  });
}
