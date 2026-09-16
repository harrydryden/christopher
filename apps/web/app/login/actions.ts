"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { normaliseEmail } from "@christopher/db";
import { authenticateWithPassword, emailProblem, registerWithPassword, requestPasswordReset, resetPasswordWithToken, sendVerificationEmail } from "@/lib/accounts";
import { clientAddress, endSession, startSession } from "@/lib/auth";
import { clearAttempts, isRateLimited, LIMITS, recordAttempt } from "@/lib/rate-limit";
import { sanitizeNextPath } from "@/lib/session";
import { passwordProblem } from "@christopher/core";

function withParams(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(path, "http://internal");
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

async function originFromHeaders(): Promise<string> {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || "localhost";
  return `${proto}://${host}`;
}

export async function login(formData: FormData): Promise<void> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNextPath(String(formData.get("next") ?? "/"));
  const back = (error: string) => redirect(withParams("/login", { error, next: next !== "/" ? next : undefined, email }));

  if (!process.env.SESSION_SECRET) back("not_configured");
  if (emailProblem(email) || !password) back("invalid");
  const address = await clientAddress();
  if (await isRateLimited(`login:email:${email}`, LIMITS.loginEmail) || await isRateLimited(`login:ip:${address}`, LIMITS.loginAddress)) back("rate_limited");

  const user = await authenticateWithPassword(email, password);
  if (!user) {
    await recordAttempt(`login:email:${email}`);
    await recordAttempt(`login:ip:${address}`);
    back("invalid");
    return;
  }
  await clearAttempts(`login:email:${email}`);
  await startSession(user.id);
  redirect(next);
}

export async function signup(formData: FormData): Promise<void> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = sanitizeNextPath(String(formData.get("next") ?? "/"));
  const back = (error: string) => redirect(withParams("/signup", { error, next: next !== "/" ? next : undefined, email, name }));

  if (!process.env.SESSION_SECRET) back("not_configured");
  if (process.env.SIGNUPS_DISABLED === "1") back("closed");
  if (emailProblem(email)) back("invalid_email");
  if (passwordProblem(password)) back("weak_password");
  const address = await clientAddress();
  if (await isRateLimited(`signup:ip:${address}`, LIMITS.signupAddress)) back("rate_limited");
  await recordAttempt(`signup:ip:${address}`);

  let userId: string;
  try {
    const { user } = await registerWithPassword({ email, name, password });
    userId = user.id;
    await sendVerificationEmail(user, await originFromHeaders());
  } catch (error) {
    if (error instanceof Error && /already exists/.test(error.message)) back("exists");
    throw error;
  }
  await startSession(userId!);
  redirect(next);
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}

export async function requestReset(formData: FormData): Promise<void> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  if (emailProblem(email)) redirect(withParams("/forgot-password", { error: "invalid" }));
  const address = await clientAddress();
  if (await isRateLimited(`reset:email:${email}`, LIMITS.resetEmail) || await isRateLimited(`reset:ip:${address}`, LIMITS.resetAddress)) {
    redirect(withParams("/forgot-password", { error: "rate_limited" }));
  }
  await recordAttempt(`reset:email:${email}`);
  await recordAttempt(`reset:ip:${address}`);
  await requestPasswordReset(email, await originFromHeaders());
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
