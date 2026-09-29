/**
 * The facts behind the setup checklist, read for one account.
 *
 * Every step is derived from a row that already exists — a confirmed address, a stored `gate`, a
 * followed companies and a complete successful scan — so setup has no state of its own beyond the
 * `setupDismissedAt` marker read here with the rest. The shaping (labels, links, "2 of 4 done") is
 * in `lib/setup.ts`, which touches no database.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { resolveUserSettings } from "@ava/core";
import { companySubscriptions, cvLibraries, userSettings, users } from "@ava/db/schema";
import { needsEmailConfirmation } from "@/lib/auth";
import { db } from "@/lib/db";
import { CHOOSE_GATE_SENTENCE, type MonitoringFacts, type SetupFacts } from "@/lib/setup";
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
        select (select count(*)::int from jsonb_array_elements(${cvLibraries.content} -> 'entries') entry
          where entry ->> 'kind' = 'experience' and coalesce(entry ->> 'status', 'active') = 'active'
          and length(trim(coalesce(entry ->> 'details', ''))) > 0
          and jsonb_array_length(coalesce(entry -> 'confirmedResponsibilities', '[]'::jsonb)) > 0)
        from ${cvLibraries} where ${cvLibraries.userId} = ${userId} order by ${cvLibraries.version} desc limit 1
      )`,
      // A company is counted once, irrespective of the number of sources. A successful shared
      // source is already useful when followed: gate membership is evaluated on follow/save.
      monitoring: sql<MonitoringFacts>`(
        select json_build_object(
          'activeCompanies', count(*)::int,
          'successfulCompanies', count(*) filter (where source.last_ok is not null)::int,
          'attentionCompanies', count(*) filter (where source.needs_attention or (source.sources = 0 and not work.pending))::int,
          'pendingCompanies', count(*) filter (where work.pending)::int,
          'lastSuccessAt', max(source.last_ok))
        from company_subscriptions cs
        cross join lateral (
          select exists(select 1 from tasks t where t.payload->>'companyId' = cs.company_id::text
            and t.type in ('discover', 'scan_company') and t.status in ('queued', 'running')) as pending
        ) work
        cross join lateral (
          select count(*)::int as sources, max(src.last_ok_scan_at) as last_ok,
            coalesce(bool_or(src.status in ('needs_confirmation', 'blocked', 'failing')
              or latest.status in ('failed', 'partial', 'suspect_empty')), false) as needs_attention
          from career_sources src
          left join lateral (select s.status from scans s where s.source_id = src.id
            and s.finished_at is not null order by s.started_at desc, s.id desc limit 1) latest on true
          where src.company_id = cs.company_id and src.status <> 'disabled'
        ) source
        where cs.user_id = ${userId} and cs.status = 'active'
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
    monitoring: row?.monitoring ?? { activeCompanies: 0, successfulCompanies: 0, attentionCompanies: 0, pendingCompanies: 0, lastSuccessAt: null },
  };
}
