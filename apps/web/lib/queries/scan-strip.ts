/**
 * The per-account figures behind the status strip, read in one statement: when a company this
 * account follows was last scanned, how many it follows, the roles still to review and the pending
 * company suggestions, beside the shared run's start and finish. The strip is in the layout, so it
 * runs on every full render, refresh and action response; four scalars in four statements took four
 * pool checkouts (of three) for it alone. The role and company counts use the expressions their own
 * pages count with (`roleStatusSql`, the pending status), so the strip and the page never disagree.
 */
import { roleStatusSql } from "@ava/db";
import { sql } from "drizzle-orm";
import { careerSources, companySubscriptions, companySuggestions, decisions, jobs, scanRuns, scans, userJobs } from "@ava/db/schema";
import { db } from "@/lib/db";

/**
 * When the most recent scan of any source of a company this account actively follows finished
 * without failing. Scans are shared, so this is the catalogue's scan seen through the account's
 * subscriptions; null until one has completed.
 *
 * One index probe per followed source (`scans_source_completed_idx` answers each `max` from its
 * newest entry), so the cost follows how many sources the account follows, not how many scans the
 * whole catalogue has kept: joining every retained scan cost 3 ms at 7,560 rows and grew daily.
 */
const lastCompletedScanAtSql = (userId: string) => sql<Date | string | null>`(
  select max(latest.at)
  from ${companySubscriptions} cs
  join ${careerSources} src on src.company_id = cs.company_id
  cross join lateral (
    select max(s.finished_at) as at from ${scans} s
    where s.source_id = src.id and s.finished_at is not null and s.status <> 'failed'
  ) latest
  where cs.user_id = ${userId} and cs.status = 'active'
)`;

/** Companies this account follows and has neither paused nor archived. */
const followingSql = (userId: string) => sql<number>`(
  select count(*)::int from ${companySubscriptions} cs where cs.user_id = ${userId} and cs.status = 'active'
)`;

/** The Matched tab's count: `fetchRoleCounts`' grouping, narrowed to the one status. */
const matchedSql = (userId: string) => sql<number>`(
  select count(*)::int from ${userJobs}
  inner join ${jobs} on ${jobs.id} = ${userJobs.jobId}
  left join ${decisions} on ${decisions.userId} = ${userId} and ${decisions.jobId} = ${jobs.id} and ${decisions.superseded} = false
  where ${userJobs.userId} = ${userId} and ${roleStatusSql} = 'auto-matched'
)`;

/** `suggestionCount(userId)`: company suggestions waiting for a yes or no. */
const pendingSuggestionsSql = (userId: string) => sql<number>`(
  select count(*)::int from ${companySuggestions} cg where cg.user_id = ${userId} and cg.status = 'pending'
)`;

export interface ScanStripRow {
  lastScanAt: Date | null;
  following: number;
  newRoleMatches: number;
  newCompanyMatches: number;
  /** The shared run the strip says is in progress or not: the newest by start, null before the first. */
  latestRun: { startedAt: Date; finishedAt: Date | null } | null;
}

const asDate = (value: Date | string | null | undefined) => (value ? new Date(value) : null);

export async function scanStripFacts(userId: string): Promise<ScanStripRow> {
  const result = await db().execute<{
    last_scan_at: Date | string | null; following: number; matched: number; suggestions: number;
    run_started_at: Date | string | null; run_finished_at: Date | string | null;
  }>(sql`
    select ${lastCompletedScanAtSql(userId)} as last_scan_at,
      ${followingSql(userId)} as following,
      ${matchedSql(userId)} as matched,
      ${pendingSuggestionsSql(userId)} as suggestions,
      run.started_at as run_started_at, run.finished_at as run_finished_at
    from (select 1) one
    left join lateral (select r.started_at, r.finished_at from ${scanRuns} r order by r.started_at desc limit 1) run on true`);
  const row = result.rows[0];
  const startedAt = asDate(row?.run_started_at);
  return {
    lastScanAt: asDate(row?.last_scan_at),
    following: Number(row?.following ?? 0),
    newRoleMatches: Number(row?.matched ?? 0),
    newCompanyMatches: Number(row?.suggestions ?? 0),
    latestRun: startedAt ? { startedAt, finishedAt: asDate(row?.run_finished_at) } : null,
  };
}
