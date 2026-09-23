"use server";

import { and, asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MAX_ACCOUNT_AI_BUDGET_USD } from "@ava/core";
import { companySubscriptions, cvDrafts, users, sessions, type UserRole } from "@ava/db/schema";
import { isPlaceholderEmail } from "@ava/db";
import { changePassword as changeStoredPassword, issueResetLink, sendVerificationEmail } from "@/lib/accounts";
import { emailLinkOrigin } from "@/lib/origin";
import { endAllSessions, endOtherSessions, getCurrentUser, requireAdmin, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { setUserSetting } from "@/lib/settings";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

export async function changePassword(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const current = await getCurrentUser();
  if (!current) throw new UserFacingError("Unauthorised");
  const next = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (next !== confirm) return fail("The two passwords do not match.");
  try {
    await changeStoredPassword(current.user, String(form.get("currentPassword") ?? ""), next);
  } catch (error) {
    return actionError(error, "Could not change the password. Please try again.");
  }
  // Every other browser signed in with the old password is signed out.
  await endOtherSessions(current.user.id, current.sessionId);
  revalidatePath("/account");
  return ok();
}

export async function signOutEverywhere(): Promise<void> {
  const current = await getCurrentUser();
  if (!current) throw new UserFacingError("Unauthorised");
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

/**
 * Administrators: promote or demote an account.
 *
 * Every demotion locks the current administrator rows, including when an administrator demotes
 * somebody else. Otherwise two administrators can submit opposing demotions at the same time,
 * each observe the other, and leave the deployment with no administrator at all.
 */
export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  await requireAdmin();
  const id = zUuid().parse(userId);
  if (role !== "admin" && role !== "member") throw new UserFacingError("Unknown role.");
  await db().transaction(async (tx) => {
    if (role !== "admin") {
      const administrators = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.role, "admin"), sql`${users.claimedAt} is not null`))
        .orderBy(asc(users.id))
        .for("update");
      if (administrators.some((row) => row.id === id) && administrators.length === 1) {
        throw new UserFacingError("You are the only administrator. Make someone else an administrator first.");
      }
    }
    await tx.update(users).set({ role }).where(eq(users.id, id));
  });
  revalidatePath("/admin");
}

/** Administrators: remove another account and everything it owns. Shared companies and postings stay. */
export async function deleteUser(userId: string): Promise<void> {
  const admin = await requireAdmin();
  const id = zUuid().parse(userId);
  if (id === admin.id) throw new UserFacingError("You cannot delete your own account here.");
  await endAllSessions(id);
  await db().delete(users).where(eq(users.id, id));
  revalidatePath("/admin");
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

/**
 * Every account, with what it has made and what it follows. "CVs" counts finished builds, whether
 * or not they were later archived; "companies" counts the boards the account still follows, which
 * is what an archived subscription stops being.
 */
export async function listAccounts() {
  await requireAdmin();
  return db().select({
    id: users.id, email: users.email, name: users.name, role: users.role, claimedAt: users.claimedAt, emailVerifiedAt: users.emailVerifiedAt,
    createdAt: users.createdAt, lastLoginAt: users.lastLoginAt,
    // `${users}.id`, not `${users.id}`: a column interpolated into a select-list expression is
    // rendered without its table, and an unqualified "id" binds to the subquery's own table.
    sessions: sql<number>`(select count(*) from ${sessions} s where s.user_id = ${users}.id and s.expires_at > now())::int`,
    cvsProduced: sql<number>`(select count(*) from ${cvDrafts} cv where cv.user_id = ${users}.id and cv.status = 'ready')::int`,
    companies: sql<number>`(select count(*) from ${companySubscriptions} sub where sub.user_id = ${users}.id and sub.status <> 'archived')::int`,
  }).from(users).orderBy(asc(users.createdAt));
}

/** A budget is money, so it is bounded on the way in as well as on the way out of settings. */
const AiBudgetSchema = z.coerce.number().min(0).max(MAX_ACCOUNT_AI_BUDGET_USD);

/**
 * Administrators: set one account's monthly AI budget. It is the same stored key the account sets
 * for itself on Settings, and it is the only budget there is, so this is the whole of what that
 * account may spend in a month.
 */
export async function setAccountAiBudget(userId: string, formData: FormData): Promise<void> {
  await requireAdmin();
  const id = zUuid().parse(userId);
  const entered = String(formData.get("aiBudgetUsd") ?? "").trim();
  const parsed = entered ? AiBudgetSchema.safeParse(entered) : null;
  if (!parsed?.success) throw new UserFacingError(`A monthly AI budget is a number between $0 and $${MAX_ACCOUNT_AI_BUDGET_USD}.`);
  await setUserSetting(id, "aiBudgetUsd", Math.round(parsed.data * 100) / 100);
  revalidatePath("/admin");
}

/**
 * Administrators: start this account's budget month again from now. Nothing is deleted — the spend
 * window moves, so the call log stays complete.
 */
export async function resetAccountAiSpend(userId: string): Promise<void> {
  await requireAdmin();
  const id = zUuid().parse(userId);
  await setUserSetting(id, "aiBudgetResetAt", new Date().toISOString());
  revalidatePath("/admin");
}
