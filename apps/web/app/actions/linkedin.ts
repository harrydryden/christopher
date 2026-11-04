"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, sql } from "drizzle-orm";
import { authAccounts, sessions, users } from "@col/db/schema";
import { normaliseEmail } from "@col/db";
import { verifyPassword } from "@col/core";
import { clientAddress, getCurrentUser, startSessionFromProof } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { linkedinConfigured } from "@/lib/linkedin";
import { beginLinkedInEmailProofIn, completeLinkedInEmailProofIn, completeLinkedInLinkIn, createLinkedInAccountIn, LINKEDIN_COOKIE, readLinkedInPending } from "@/lib/linkedin-auth";
import { emailLinkOrigin } from "@/lib/origin";
import { LIMITS, reserveRateLimits } from "@/lib/rate-limit";
import { actionError, fail, UserFacingError, type ActionResult } from "@/lib/validation";
import { emailProblem } from "@/lib/accounts";

async function pendingCookie() { return (await cookies()).get(LINKEDIN_COOKIE)?.value; }

export async function getLinkedInPendingView(): Promise<{ status: "link_required" | "verify_email" | "create_account" | "recovery_required" | "expired"; email?: string }> {
  const row = await readLinkedInPending(db(), await pendingCookie());
  if (!row?.pendingKind) return { status: "expired" };
  const email = row.appEmailVerifiedAt && row.chosenEmail ? row.chosenEmail : row.providerEmailVerified ? row.providerEmail : null;
  return { status: row.pendingKind, ...(email ? { email } : {}) };
}

/** An existing account is proved by a fresh password check or a fresh alternate-provider session. */
export async function completeLinkedInLink(form: FormData): Promise<ActionResult> {
  const current = await getCurrentUser();
  if (!current) throw new UserFacingError("Unauthorised");
  const password = String(form.get("password") ?? "");
  let passwordProven = false;
  if (password) {
    const address = await clientAddress();
    if (!await reserveRateLimits([
      { key: `linkedin:link:pair:${current.user.id}:${address}`, limit: LIMITS.loginEmailAddress },
      { key: `linkedin:link:account:${current.user.id}`, limit: LIMITS.loginEmail },
      { key: `linkedin:link:ip:${address}`, limit: LIMITS.loginAddress },
    ])) return fail("Too many attempts. Try again later.");
    passwordProven = !!current.user.passwordHash && await verifyPassword(password, current.user.passwordHash);
    if (!passwordProven) return fail("That password is not right.");
  }
  try {
    const result = await completeLinkedInLinkIn(db(), { cookie: await pendingCookie(), userId: current.user.id, sessionId: current.sessionId, passwordHashProven: passwordProven ? current.user.passwordHash! : undefined });
    (await cookies()).delete(LINKEDIN_COOKIE);
    return { ok: true, message: "LinkedIn is linked to this account.", nextSnapshot: { href: result.next } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("intended account")) return fail("Sign in to the account this LinkedIn link was started for.");
    if (message.includes("Verify the account email")) return fail("Confirm this account's email before linking LinkedIn.");
    if (message.includes("Sign in again")) return fail("Sign in again with this account's password or Google before linking LinkedIn.");
    if (message.includes("linked elsewhere")) return fail("This LinkedIn identity is already linked to another account.");
    return fail("The LinkedIn link expired or could not be completed. Start it again.");
  }
}

export async function beginLinkedInEmailVerification(form: FormData): Promise<ActionResult> {
  const email = normaliseEmail(String(form.get("email") ?? ""));
  if (emailProblem(email)) return fail("Enter a valid email address.");
  const address = await clientAddress();
  if (!await reserveRateLimits([
    { key: `linkedin:email:pair:${email}:${address}`, limit: LIMITS.resetEmail },
    { key: `reset:email:${email}`, limit: LIMITS.resetEmail },
    { key: `reset:ip:${address}`, limit: LIMITS.resetAddress },
  ])) return fail("Too many attempts. Try again later.");
  try {
    const { token } = await beginLinkedInEmailProofIn(db(), { cookie: await pendingCookie(), email });
    const origin = await emailLinkOrigin();
    if (!origin) return fail("Email verification is unavailable at the moment.");
    const url = `${origin}/auth/linkedin/continue?proof=${encodeURIComponent(token)}`;
    const result = await sendEmail({ to: email, subject: "Confirm your email for Course of Life", text: `Confirm this address for your LinkedIn sign-in. Open the link in the same browser, then press Confirm; the link expires in one hour:\n${url}\n\nIf this was not you, ignore this message.` });
    return result.delivered ? { ok: true, message: "Check your email for a confirmation link." } : fail("The confirmation email could not be delivered. Try again later.");
  } catch (error) {
    return actionError(error, "Could not start email verification. Restart LinkedIn sign-in.", "linkedin_email_start_failed");
  }
}

export async function completeLinkedInEmailVerification(form: FormData): Promise<ActionResult> {
  const token = String(form.get("proof") ?? "");
  try {
    const result = await completeLinkedInEmailProofIn(db(), { cookie: await pendingCookie(), token });
    return { ok: true, message: result.kind === "link_required" ? "This address already has an account. Sign in to it, then explicitly link LinkedIn." :
      result.kind === "create_account" ? "Email confirmed. Choose Continue to create your account." : "Use the existing account recovery route for this address." };
  } catch {
    return fail("That verification link is invalid or expired. Request a new one in the same browser.");
  }
}

export async function createLinkedInAccount(): Promise<ActionResult> {
  if (!linkedinConfigured()) return fail("LinkedIn sign-in is unavailable.");
  let result: Awaited<ReturnType<typeof createLinkedInAccountIn>>;
  try {
    result = await createLinkedInAccountIn(db(), await pendingCookie());
  } catch (error) {
    return actionError(error, "Could not create the account. Restart LinkedIn sign-in or use an existing account.", "linkedin_account_create_failed");
  }
  if (result.kind === "link_required") return { ok: true, message: "That address now has an account. Sign in to it and explicitly link LinkedIn." };
  const sessionId = await startSessionFromProof({ userId: result.user.id, proof: { provider: "linkedin", subject: result.subject } });
  if (!sessionId) return fail("Sign-in changed while completing this account. Sign in again.");
  (await cookies()).delete(LINKEDIN_COOKIE);
  redirect(result.next);
}

/** Disconnect only after a fresh alternate-method sign-in, and only while another usable method remains. */
export async function unlinkLinkedIn(): Promise<ActionResult> {
  const session = await getCurrentUser();
  if (!session) throw new UserFacingError("Unauthorised");
  const current = session.user;
  const now = new Date();
  try {
    return await db().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
      const [user] = await tx.select().from(users).where(eq(users.id, current.id)).for("update").limit(1);
      const [active] = await tx.select().from(sessions).where(and(eq(sessions.id, session.sessionId), eq(sessions.userId, current.id), gt(sessions.expiresAt, now))).limit(1);
      const google = await tx.select({ id: authAccounts.id }).from(authAccounts).where(and(eq(authAccounts.userId, current.id), eq(authAccounts.provider, "google"))).limit(1);
      const hasPassword = !!user?.passwordHash;
      const hasGoogle = !!google.length && !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
      if (!user?.emailVerifiedAt || (!hasPassword && !hasGoogle)) return fail("Add and verify another sign-in method before disconnecting LinkedIn.");
      const fresh = !!active && now.getTime() - active.createdAt.getTime() <= 5 * 60_000 &&
        ((active.authProvider === "password" && hasPassword) || (active.authProvider === "google" && hasGoogle));
      if (!fresh) return fail("Sign in again with your password or Google before disconnecting LinkedIn.");
      await tx.delete(authAccounts).where(and(eq(authAccounts.userId, current.id), eq(authAccounts.provider, "linkedin")));
      await tx.delete(sessions).where(and(eq(sessions.userId, current.id), eq(sessions.authProvider, "linkedin")));
      return { ok: true as const, message: "LinkedIn has been disconnected." };
    });
  } catch (error) {
    return actionError(error, "Could not disconnect LinkedIn. Try again.", "linkedin_unlink_failed");
  }
}
