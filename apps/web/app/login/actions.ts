"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { normaliseEmail } from "@ava/db";
import { authenticateWithPassword, emailProblem, registerWithPassword, registrationAllowed, requestPasswordReset, resetPasswordWithToken, sendVerificationEmail } from "@/lib/accounts";
import { clientAddress, endSession, startSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { emailLinkOrigin, withParams } from "@/lib/origin";
import { clearAttempts, LIMITS, releaseRateLimitReservations, reserveRateLimits } from "@/lib/rate-limit";
import { sanitizeNextPath, sessionSecret } from "@/lib/session";
import { passwordProblem } from "@ava/core";
import { users } from "@ava/db/schema";
import { eq } from "drizzle-orm";

export async function login(formData: FormData): Promise<void> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNextPath(String(formData.get("next") ?? "/"));
  const back = (error: string) => redirect(withParams("/login", { error, next: next !== "/" ? next : undefined, email }));

  if (!sessionSecret()) back("not_configured");
  if (emailProblem(email) || !password) back("invalid");
  const address = await clientAddress();
  const pairKey = `login:email-ip:${email}:${address}`;
  const emailKey = `login:email:${email}`;
  const addressKey = `login:ip:${address}`;
  const reservation = await reserveRateLimits([
    { key: pairKey, limit: LIMITS.loginEmailAddress },
    { key: emailKey, limit: LIMITS.loginEmail },
    { key: addressKey, limit: LIMITS.loginAddress },
  ]);
  if (!reservation) back("rate_limited");

  const result = await authenticateWithPassword(email, password);
  if (result.status !== "ok") {
    back(result.status === "unconfirmed" ? "unconfirmed" : "invalid");
    return;
  }
  // A successful password clears this account's failures. The address is shared, so remove only
  // this request's reservation and preserve failures from other concurrent sign-in attempts.
  await releaseRateLimitReservations(reservation!.filter(({ key }) => key === addressKey));
  await clearAttempts(pairKey);
  await clearAttempts(emailKey);
  await startSession(result.user.id);
  redirect(next);
}

export async function signup(formData: FormData): Promise<void> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNextPath(String(formData.get("next") ?? "/"));
  const back = (error: string) => redirect(withParams("/signup", { error, next: next !== "/" ? next : undefined, email, name }));

  if (!sessionSecret()) back("not_configured");
  if (emailProblem(email)) back("invalid_email");
  // The password first: checked after the registration rule, a weak password told an administrator
  // address (which may always register) apart from every other address while registration is closed.
  if (passwordProblem(password)) back("weak_password");
  if (!(await registrationAllowed(email))) back("closed");
  const address = await clientAddress();
  if (!(await reserveRateLimits([{ key: `signup:ip:${address}`, limit: LIMITS.signupAddress }]))) back("rate_limited");

  let userId: string;
  let pending: boolean;
  try {
    const result = await registerWithPassword({ email, name, password });
    userId = result.user.id;
    pending = result.pending;
    await sendVerificationEmail(result.user, await emailLinkOrigin());
  } catch (error) {
    if (error instanceof Error && /already exists/.test(error.message)) back("exists");
    throw error;
  }
  // An administrator address signs in only once its confirmation link has been completed.
  if (pending!) redirect(withParams("/signup", { pending: "1", email }));
  await startSession(userId!);
  redirect(next);
}

/** Send a fresh confirmation link to an address whose registration is waiting on one. */
export async function resendConfirmation(formData: FormData): Promise<void> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  if (emailProblem(email)) redirect(withParams("/signup", { error: "invalid_email" }));
  const address = await clientAddress();
  if (!(await reserveRateLimits([
    { key: `reset:email:${email}`, limit: LIMITS.resetEmail },
    { key: `reset:ip:${address}`, limit: LIMITS.resetAddress },
  ]))) {
    redirect(withParams("/signup", { pending: "1", email, error: "rate_limited" }));
  }
  // Silent about whether the address is known, like the reset form, and as quick either way: the
  // lookup and the send happen after the answer, so its timing says nothing about the address.
  const origin = await emailLinkOrigin();
  after(async () => {
    try {
      const [user] = await db().select().from(users).where(eq(users.email, email)).limit(1);
      if (user && !user.emailVerifiedAt) await sendVerificationEmail(user, origin);
    } catch (error) {
      console.error(JSON.stringify({ event: "confirmation_email_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  });
  redirect(withParams("/signup", { pending: "1", email, sent: "1" }));
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}

export async function requestReset(formData: FormData): Promise<void> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  if (emailProblem(email)) redirect(withParams("/forgot-password", { error: "invalid" }));
  const address = await clientAddress();
  if (!(await reserveRateLimits([
    { key: `reset:email:${email}`, limit: LIMITS.resetEmail },
    { key: `reset:ip:${address}`, limit: LIMITS.resetAddress },
  ]))) {
    redirect(withParams("/forgot-password", { error: "rate_limited" }));
  }
  // A known address used to cost a token and a round trip to the email provider before the answer,
  // an unknown one a single read: the reset now runs after the answer, so both take the same time.
  const origin = await emailLinkOrigin();
  after(async () => {
    try {
      await requestPasswordReset(email, origin);
    } catch (error) {
      console.error(JSON.stringify({ event: "reset_email_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  });
  redirect(withParams("/forgot-password", { sent: "1" }));
}

export async function resetPassword(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const back = (error: string) => redirect(withParams("/reset-password", { token, error }));
  if (!token) back("invalid_token");
  if (passwordProblem(password)) back("weak_password");
  if (password !== confirm) back("mismatch");
  const user = await resetPasswordWithToken(token, password);
  if (!user) back("invalid_token");
  await startSession(user!.id);
  redirect("/account?reset=1");
}
