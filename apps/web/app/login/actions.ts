"use server";

import { redirect } from "next/navigation";
import { normaliseEmail } from "@christopher/db";
import { authenticateWithPassword, emailProblem, registerWithPassword, registrationAllowed, requestPasswordReset, resetPasswordWithToken, sendVerificationEmail } from "@/lib/accounts";
import { clientAddress, endSession, startSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { emailLinkOrigin, withParams } from "@/lib/origin";
import { clearAttempts, LIMITS, releaseRateLimitReservations, reserveRateLimits } from "@/lib/rate-limit";
import { sanitizeNextPath } from "@/lib/session";
import { passwordProblem } from "@christopher/core";
import { users } from "@christopher/db/schema";
import { eq } from "drizzle-orm";

export async function login(formData: FormData): Promise<void> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNextPath(String(formData.get("next") ?? "/"));
  const back = (error: string) => redirect(withParams("/login", { error, next: next !== "/" ? next : undefined, email }));

  if (!process.env.SESSION_SECRET) back("not_configured");
  if (emailProblem(email) || !password) back("invalid");
  const address = await clientAddress();
  const emailKey = `login:email:${email}`;
  const addressKey = `login:ip:${address}`;
  const reservation = await reserveRateLimits([
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

  if (!process.env.SESSION_SECRET) back("not_configured");
  if (emailProblem(email)) back("invalid_email");
  if (!(await registrationAllowed(email))) back("closed");
  if (passwordProblem(password)) back("weak_password");
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
  const [user] = await db().select().from(users).where(eq(users.email, email)).limit(1);
  // Silent about whether the address is known, like the reset form.
  if (user && !user.emailVerifiedAt) await sendVerificationEmail(user, await emailLinkOrigin());
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
  await requestPasswordReset(email, await emailLinkOrigin());
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
