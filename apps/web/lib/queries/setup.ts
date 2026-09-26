/**
 * The facts behind the setup checklist, read for one account.
 *
 * Every step is derived from a row that already exists — a confirmed address, a stored `gate`, a
 * seed profile, followed companies, a saved Library — so setup has no state of its own beyond the
 * `setupDismissedAt` marker read here with the rest. The shaping (labels, links, "2 of 5 done") is
 * in `lib/setup.ts`, which touches no database.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { resolveUserSettings } from "@ava/core";
import { companySubscriptions, cvLibraries, userSettings, users } from "@ava/db/schema";
import { needsEmailConfirmation } from "@/lib/auth";
import { db } from "@/lib/db";
import { CHOOSE_GATE_SENTENCE, type SetupFacts } from "@/lib/setup";
import { UserFacingError } from "@/lib/validation";

/** The account's own setting rows the checklist reads. Read from `user_settings` alone: a stray
 * `gate` in the administrator's table is not this account choosing its filters. */
const SETUP_KEYS = ["gate", "seedProfile", "setupDismissedAt"];

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

/**
 * Every fact the checklist needs, for one account, in one statement. `Setup` streams on every full
 * render of the Roles page even once setup is finished, and its four scalars were four pool
 * checkouts; they are independent reads, so they are subqueries of one row now.
 */
export async function setupStatus(userId: string): Promise<SetupFacts> {
  const [row] = await db()
    .select({
      role: users.role,
      emailVerifiedAt: users.emailVerifiedAt,
      settings: sql<Array<{ key: string; value: unknown }>>`(
        select coalesce(json_agg(json_build_object('key', ${userSettings.key}, 'value', ${userSettings.value})), '[]'::json)
        from ${userSettings}
        where ${userSettings.userId} = ${userId} and ${inArray(userSettings.key, SETUP_KEYS)}
      )`,
      followed: sql<number>`(
        select count(*)::int from ${companySubscriptions}
        where ${companySubscriptions.userId} = ${userId} and ${companySubscriptions.status} <> 'archived'
      )`,
      // The count alone, so a long Library is never pulled across to answer "is it filled?".
      experiences: sql<number | null>`(
        select (select count(*)::int from jsonb_array_elements(${cvLibraries.content} -> 'entries') entry where entry ->> 'kind' = 'experience')
        from ${cvLibraries} where ${cvLibraries.userId} = ${userId} order by ${cvLibraries.version} desc limit 1
      )`,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // No account row means nothing else of it exists either (every other row cascades from it).
  const rows = row?.settings ?? [];
  const settings = resolveUserSettings(rows);
  return {
    emailConfirmed: !!row && !needsEmailConfirmation(row),
    gateChosen: rows.some((entry) => entry.key === "gate"),
    seedProfileWritten: settings.seedProfile.trim().length > 0,
    companiesFollowed: Number(row?.followed ?? 0),
    libraryFilled: Number(row?.experiences ?? 0) > 0,
    dismissedAt: settings.setupDismissedAt,
  };
}
