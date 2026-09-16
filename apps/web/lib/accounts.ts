/**
 * Account lifecycle: registration, password sign-in, Google sign-in and linking, password
 * changes and resets, email verification. Pure database work; sessions and cookies are lib/auth.
 */
import { and, eq } from "drizzle-orm";
import { createUser, normaliseEmail } from "@christopher/db";
import { authAccounts, sessions, users, type User } from "@christopher/db/schema";
import { hashPassword, passwordProblem, verifyPassword } from "@christopher/core";
import { consumeAuthToken, issueAuthToken } from "./auth-tokens";
import { db } from "./db";
import { sendEmail } from "./email";
import type { GoogleProfile } from "./google";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Addresses that become administrators on sign-up, and the only ones that may claim migrated data. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => normaliseEmail(e)).filter(Boolean);
}

export function emailProblem(email: string): string | null {
  const value = normaliseEmail(email);
  if (!value || value.length > 254 || !EMAIL_RE.test(value)) return "Enter a valid email address.";
  return null;
}

/** A hash to verify against when no account matches, so a wrong email costs the same time as a wrong password. */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword("decoy-password-for-constant-time-checks");
  return decoyHash;
}

export async function registerWithPassword(input: { email: string; password: string; name?: string }): Promise<{ user: User; claimedBootstrap: boolean }> {
  const emailError = emailProblem(input.email);
  if (emailError) throw new Error(emailError);
  const passwordError = passwordProblem(input.password);
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await hashPassword(input.password);
  return createUser(db(), { email: input.email, name: input.name?.trim().slice(0, 200) || null, passwordHash }, { adminEmails: adminEmails() });
}

export async function authenticateWithPassword(email: string, password: string): Promise<User | null> {
  const [user] = await db().select().from(users).where(eq(users.email, normaliseEmail(email))).limit(1);
  const hash = user?.passwordHash ?? (await decoy());
  const ok = await verifyPassword(password, hash);
  if (!user || !user.passwordHash || !user.claimedAt || !ok) return null;
  return user;
}

/**
 * Sign in with a Google identity. A known Google account signs in; a verified Google email that
 * matches an existing account links to it; anything else creates an account (or claims the
 * migrated owner). A password account whose email was never verified is taken over by the
 * proven Google owner: its password and sessions are dropped, since nobody proved that address.
 */
export async function signInWithGoogle(profile: GoogleProfile): Promise<{ user: User; created: boolean }> {
  const email = normaliseEmail(profile.email);
  const [linked] = await db()
    .select({ user: users })
    .from(authAccounts)
    .innerJoin(users, eq(users.id, authAccounts.userId))
    .where(and(eq(authAccounts.provider, "google"), eq(authAccounts.providerAccountId, profile.sub)))
    .limit(1);
  if (linked) return { user: linked.user, created: false };
  if (!profile.emailVerified) throw new Error("Google has not verified this email address, so it cannot be used to sign in.");

  const [existing] = await db().select().from(users).where(eq(users.email, email)).limit(1);
  if (existing && existing.claimedAt) {
    await db().transaction(async (tx) => {
      if (!existing.emailVerifiedAt) {
        await tx.update(users).set({ emailVerifiedAt: new Date(), ...(existing.passwordHash ? { passwordHash: null } : {}) }).where(eq(users.id, existing.id));
        if (existing.passwordHash) await tx.delete(sessions).where(eq(sessions.userId, existing.id));
      }
      await tx.insert(authAccounts).values({ userId: existing.id, provider: "google", providerAccountId: profile.sub, email, name: profile.name ?? null }).onConflictDoNothing();
    });
    return { user: { ...existing, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() }, created: false };
  }
  const { user } = await createUser(db(), { email, name: profile.name ?? null, emailVerified: true }, { adminEmails: adminEmails() });
  await db().insert(authAccounts).values({ userId: user.id, provider: "google", providerAccountId: profile.sub, email, name: profile.name ?? null }).onConflictDoNothing();
  return { user, created: true };
}

export async function linkedProviders(userId: string) {
  return db().select().from(authAccounts).where(eq(authAccounts.userId, userId));
}

/** Set or change the password. The current one is required whenever the account already has one. */
export async function changePassword(user: User, currentPassword: string, nextPassword: string): Promise<void> {
  if (user.passwordHash) {
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new Error("The current password is not right.");
  }
  const problem = passwordProblem(nextPassword);
  if (problem) throw new Error(problem);
  await db().update(users).set({ passwordHash: await hashPassword(nextPassword) }).where(eq(users.id, user.id));
}

/** Always quiet about whether an address is registered. */
export async function requestPasswordReset(email: string, origin: string): Promise<void> {
  const [user] = await db().select().from(users).where(eq(users.email, normaliseEmail(email))).limit(1);
  if (!user || !user.claimedAt) return;
  const token = await issueAuthToken(user.id, "password_reset");
  await sendEmail({
    to: user.email,
    subject: "Reset your Christopher password",
    text: `Someone asked to reset the password for this Christopher account.\n\nSet a new password here (the link works once, for an hour):\n${origin}/reset-password?token=${token}\n\nIf that was not you, ignore this message; nothing has changed.`,
  });
}

export async function resetPasswordWithToken(token: string, password: string): Promise<User | null> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const consumed = await consumeAuthToken(token, "password_reset");
  if (!consumed) return null;
  const passwordHash = await hashPassword(password);
  const [user] = await db().update(users).set({ passwordHash, emailVerifiedAt: new Date() }).where(eq(users.id, consumed.userId)).returning();
  if (!user) return null;
  // Whoever held the old password is signed out everywhere.
  await db().delete(sessions).where(eq(sessions.userId, user.id));
  return user;
}

export async function sendVerificationEmail(user: User, origin: string): Promise<{ delivered: boolean }> {
  if (user.emailVerifiedAt) return { delivered: false };
  const token = await issueAuthToken(user.id, "email_verification");
  return sendEmail({
    to: user.email,
    subject: "Confirm your email for Christopher",
    text: `Confirm this address for your Christopher account (the link works once, for a day):\n${origin}/auth/verify?token=${token}\n\nIf you did not create an account, ignore this message.`,
  });
}

export async function verifyEmailWithToken(token: string): Promise<User | null> {
  const consumed = await consumeAuthToken(token, "email_verification");
  if (!consumed) return null;
  const [user] = await db().update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, consumed.userId)).returning();
  return user ?? null;
}
