"use server";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MAX_ACCOUNT_AI_BUDGET_USD, passwordProblem } from "@col/core";
import { companySubscriptions, cvDrafts, users, sessions, type UserRole } from "@col/db/schema";
import { grantAdminCvGift, isPlaceholderEmail } from "@col/db";
import { changePassword as changeStoredPassword, deleteAccount, issueResetLink, sendVerificationEmail } from "@/lib/accounts";
import { emailLinkOrigin } from "@/lib/origin";
import { clientAddress, endOtherSessions, getCurrentUser, requireAdmin, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { clearAttempts, LIMITS, reserveRateLimits } from "@/lib/rate-limit";
import { setUserSetting } from "@/lib/settings";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

export async function changePassword(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const current = await getCurrentUser();
  if (!current) throw new UserFacingError("Unauthorised");
  const next = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  if (next !== confirm) return fail("The two passwords do not match.");
  // The cheap checks first, so a typo in the new password costs no attempt.
  const problem = passwordProblem(next);
  if (problem) return fail(problem);
  // Only a current password is worth guessing; an account that never had one has nothing to find.
  const attemptKey = `password-change:user:${current.user.id}`;
  if (current.user.passwordHash && !(await reserveRateLimits([{ key: attemptKey, limit: LIMITS.passwordChange }]))) {
    return fail("Too many attempts. Try again in 15 minutes.");
  }
  try {
    // Every other browser signed in with the old password is signed out in the same commit.
    await changeStoredPassword(current.user, String(form.get("currentPassword") ?? ""), next, current.sessionId);
  } catch (error) {
    return actionError(error, "Could not change the password. Please try again.");
  }
  await clearAttempts(attemptKey);
  revalidatePath("/account");
  return ok();
}

export async function signOutEverywhere(): Promise<void> {
  const current = await getCurrentUser();
  if (!current) throw new UserFacingError("Unauthorised");
  await endOtherSessions(current.user.id, current.sessionId);
  revalidatePath("/account");
}

/**
 * Send the confirmation link again. Throttled like the public forms: a throwaway account registered
 * to somebody else's address could otherwise mail them without limit and spend the sending quota
 * every other account's resets depend on. The address shares its budget with the public
 * confirmation and reset forms, so no path adds to what that mailbox receives.
 */
export async function resendVerification(): Promise<void> {
  const user = await requireUser();
  // Nothing would be sent, so no capacity is spent.
  if (user.emailVerifiedAt || isPlaceholderEmail(user.email)) return;
  const reserved = await reserveRateLimits([
    { key: `verify:user:${user.id}`, limit: LIMITS.resetEmail },
    { key: `reset:email:${user.email}`, limit: LIMITS.resetEmail },
    { key: `reset:ip:${await clientAddress()}`, limit: LIMITS.resetAddress },
  ]);
  if (!reserved) redirect("/account?verify=rate_limited");
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
/** Administrators: remove an account. `deleteAccount` holds the lock that keeps one administrator. */
export async function deleteUser(userId: string): Promise<void> {
  const admin = await requireAdmin();
  await deleteAccount(admin.id, zUuid().parse(userId));
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
export async function listAccounts(page = 1, perPage = 50) {
  await requireAdmin();
  const size = Math.max(1, Math.min(perPage, 200));
  return db().select({
    id: users.id, email: users.email, name: users.name, role: users.role, claimedAt: users.claimedAt, emailVerifiedAt: users.emailVerifiedAt,
    createdAt: users.createdAt, lastLoginAt: users.lastLoginAt,
    // `${users}.id`, not `${users.id}`: a column interpolated into a select-list expression is
    // rendered without its table, and an unqualified "id" binds to the subquery's own table.
    sessions: sql<number>`(select count(*) from ${sessions} s where s.user_id = ${users}.id and s.expires_at > now())::int`,
    cvsProduced: sql<number>`(select count(*) from ${cvDrafts} cv where cv.user_id = ${users}.id and cv.status = 'ready')::int`,
    companies: sql<number>`(select count(*) from ${companySubscriptions} sub where sub.user_id = ${users}.id and sub.status <> 'archived')::int`,
  }).from(users).orderBy(asc(users.createdAt), asc(users.id)).limit(size).offset((Math.max(1, page) - 1) * size);
}

/** How many accounts there are, for the pages above. */
export async function accountCount(): Promise<number> {
  await requireAdmin();
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
}

export type GiftCreditsResult = { ok: true; alreadyApplied: boolean } | { ok: false; error: string; code?: "conflict" };

/** Gift CV credits without a payment; the ledger stores both the operator and their reason. */
export async function giftAccountCvCredits(form: FormData): Promise<GiftCreditsResult> {
  const actor = await requireAdmin();
  const target = zUuid().safeParse(String(form.get("userId") ?? ""));
  const request = zUuid().safeParse(String(form.get("requestId") ?? ""));
  const rawUnits = String(form.get("credits") ?? "").trim();
  const units = Number(rawUnits);
  const reason = String(form.get("reason") ?? "").trim();
  if (!target.success || !request.success || !/^[1-9][0-9]*$/.test(rawUnits) || !Number.isInteger(units) || units > 100 || !reason || reason.length > 300) {
    return { ok: false, error: "Enter 1 to 100 whole credits, a reason of up to 300 characters, and retry the form." };
  }
  try {
    const result = await db().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:users'))`);
      // The role-changing action locks administrator rows in id order; use that order here too.
      const accounts = await tx.select({ id: users.id, role: users.role, claimedAt: users.claimedAt }).from(users)
        .where(inArray(users.id, [actor.id, target.data])).orderBy(asc(users.id)).for("share");
      const operator = accounts.find(account => account.id === actor.id);
      if (operator?.role !== "admin" || !operator.claimedAt) throw new UserFacingError("You are no longer an administrator.");
      const account = accounts.find(account => account.id === target.data);
      if (!account) return null;
      return grantAdminCvGift(tx, { actorId: actor.id, userId: account.id, units, requestId: request.data, reason });
    });
    if (!result) return { ok: false, error: "This account no longer exists. No credits were gifted." };
    revalidatePath("/admin");
    revalidatePath("/account");
    return { ok: true, alreadyApplied: result.alreadyApplied };
  } catch (error) {
    if (error instanceof UserFacingError) return { ok: false, error: error.message };
    if (error instanceof Error && error.message === "This gift request was already used with different details.") {
      return { ok: false, code: "conflict", error: "This request was already used with different gift details. Check the account and start a new gift if needed." };
    }
    return { ok: false, error: "Could not confirm the gift. Retry with the same details in this tab; it will not be applied twice." };
  }
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
