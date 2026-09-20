/**
 * The facts behind the setup checklist, read for one account.
 *
 * Every step is derived from a row that already exists — a confirmed address, a stored `gate`, a
 * seed profile, followed companies, a saved Library — so setup has no state of its own beyond the
 * `setupDismissedAt` marker read here with the rest. The shaping (labels, links, "2 of 5 done") is
 * in `lib/setup.ts`, which touches no database.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { resolveUserSettings } from "@christopher/core";
import { companySubscriptions, cvLibraries, userSettings, users } from "@christopher/db/schema";
import { needsEmailConfirmation } from "@/lib/auth";
import { db } from "@/lib/db";
import { CHOOSE_GATE_SENTENCE, type SetupFacts } from "@/lib/setup";
import { UserFacingError } from "@/lib/validation";

/** The account's own setting rows the checklist reads. Read from `user_settings` alone: a stray
 * `gate` in the administrator's table is not this account choosing its filters. */
const SETUP_KEYS = ["gate", "seedProfile", "setupDismissedAt"];

async function setupSettingRows(userId: string) {
  return db()
    .select({ key: userSettings.key, value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId), inArray(userSettings.key, SETUP_KEYS)));
}

/** Whether this account has ever saved its keyword and location gate. */
export async function hasChosenGate(userId: string): Promise<boolean> {
  const [row] = await db()
    .select({ key: userSettings.key })
    .from(userSettings)
    .where(and(eq(userSettings.userId, userId), eq(userSettings.key, "gate")))
    .limit(1);
  return !!row;
}

/**
 * The rule behind "filters first": nothing that starts a scan may run for an account that has never
 * chosen its gate, so the first scan is never run against a default nobody picked. Adding a role by
 * its URL is deliberately exempt — it bypasses the gate by design.
 */
export async function requireChosenGate(userId: string): Promise<void> {
  if (!(await hasChosenGate(userId))) throw new UserFacingError(CHOOSE_GATE_SENTENCE);
}

/** Every fact the checklist needs, for one account, in one round of reads. */
export async function setupStatus(userId: string): Promise<SetupFacts> {
  const [rows, account, followed, library] = await Promise.all([
    setupSettingRows(userId),
    db().select({ role: users.role, emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, userId)).limit(1),
    db()
      .select({ n: sql<number>`count(*)::int` })
      .from(companySubscriptions)
      .where(and(eq(companySubscriptions.userId, userId), ne(companySubscriptions.status, "archived"))),
    db()
      .select({
        // The count alone, so a long Library is never pulled across to answer "is it filled?".
        experiences: sql<number>`(select count(*)::int from jsonb_array_elements(${cvLibraries.content} -> 'entries') entry where entry ->> 'kind' = 'experience')`,
      })
      .from(cvLibraries)
      .where(eq(cvLibraries.userId, userId))
      .orderBy(desc(cvLibraries.version))
      .limit(1),
  ]);
  const settings = resolveUserSettings(rows);
  const user = account[0];
  return {
    emailConfirmed: !!user && !needsEmailConfirmation(user),
    gateChosen: rows.some((row) => row.key === "gate"),
    seedProfileWritten: settings.seedProfile.trim().length > 0,
    companiesFollowed: followed[0]?.n ?? 0,
    libraryFilled: (library[0]?.experiences ?? 0) > 0,
    dismissedAt: settings.setupDismissedAt,
  };
}
