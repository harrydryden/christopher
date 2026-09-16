"use server";

import { and, asc, eq, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { users, sessions, type UserRole } from "@christopher/db/schema";
import { isPlaceholderEmail } from "@christopher/db";
import { changePassword as changeStoredPassword, issueResetLink, sendVerificationEmail } from "@/lib/accounts";
import { emailLinkOrigin } from "@/lib/origin";
import { endAllSessions, endOtherSessions, getCurrentUser, requireAdmin, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { fail, ok, zUuid, type ActionResult } from "@/lib/validation";

export async function changePassword(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const current = await getCurrentUser();
  if (!current) throw new Error("Unauthorised");
  const next = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (next !== confirm) return fail("The two passwords do not match.");
  try {
    await changeStoredPassword(current.user, String(form.get("currentPassword") ?? ""), next);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not change the password.");
  }
  // Every other browser signed in with the old password is signed out.
  await endOtherSessions(current.user.id, current.sessionId);
  revalidatePath("/account");
  return ok();
}

export async function signOutEverywhere(): Promise<void> {
  const current = await getCurrentUser();
  if (!current) throw new Error("Unauthorised");
  await endOtherSessions(current.user.id, current.sessionId);
  revalidatePath("/account");
}

export async function resendVerification(): Promise<void> {
  const user = await requireUser();
  await sendVerificationEmail(user, await emailLinkOrigin());
  revalidatePath("/account");
}

export async function updateProfile(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const name = String(form.get("name") ?? "").trim().slice(0, 200);
  await db().update(users).set({ name: name || null }).where(eq(users.id, user.id));
  revalidatePath("/account");
  revalidatePath("/", "layout");
  return ok();
}

/** Administrators: promote or demote another account. The last administrator cannot demote themselves. */
export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  const admin = await requireAdmin();
  const id = zUuid().parse(userId);
  if (role !== "admin" && role !== "member") throw new Error("Unknown role.");
  if (id === admin.id && role !== "admin") {
    const [others] = await db().select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.role, "admin"), ne(users.id, admin.id), sql`${users.claimedAt} is not null`));
    if (!others?.n) throw new Error("You are the only administrator. Make someone else an administrator first.");
  }
  await db().update(users).set({ role }).where(eq(users.id, id));
  revalidatePath("/account");
}

/** Administrators: remove another account and everything it owns. Shared companies and postings stay. */
export async function deleteUser(userId: string): Promise<void> {
  const admin = await requireAdmin();
  const id = zUuid().parse(userId);
  if (id === admin.id) throw new Error("You cannot delete your own account here.");
  await endAllSessions(id);
  await db().delete(users).where(eq(users.id, id));
  revalidatePath("/account");
}

/** Administrators: a single-use reset link to hand to someone when email delivery is not set up. It also completes a pending confirmation. */
export async function createResetLink(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  const id = zUuid().parse(String(form.get("userId") ?? ""));
  const [target] = await db().select({ email: users.email }).from(users).where(eq(users.id, id));
  if (!target || isPlaceholderEmail(target.email)) return fail("No such account.");
  const origin = await emailLinkOrigin();
  if (!origin) return fail("Set APP_URL to this deployment's public origin so links can be built.");
  return { ok: true, message: await issueResetLink(id, origin) };
}

export async function listAccounts() {
  await requireAdmin();
  return db().select({
    id: users.id, email: users.email, name: users.name, role: users.role, claimedAt: users.claimedAt, emailVerifiedAt: users.emailVerifiedAt,
    createdAt: users.createdAt, lastLoginAt: users.lastLoginAt,
    sessions: sql<number>`(select count(*) from ${sessions} s where s.user_id = ${users.id} and s.expires_at > now())::int`,
  }).from(users).orderBy(asc(users.createdAt));
}
