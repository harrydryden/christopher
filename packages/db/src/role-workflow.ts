import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { applications, cvDrafts, userJobs, decisions, jobs } from "./schema";
import type { RoleStage, RoleStatus } from "@christopher/core";
/** Requires the `user_jobs` row and the active-decision LEFT JOIN. Shared by tables, totals and exports. */
export const roleStatusSql = sql<RoleStatus>`case
  when ${userJobs.archivedAt} is not null then 'archived'
  when ${decisions.decision} = 'apply' then 'user-shortlisted'
  when ${decisions.decision} = 'skip' then 'user-dismissed'
  when ${userJobs.inTable} then 'auto-matched'
  else 'archived' end`;

/**
 * One account's newest `applications` row per posting, as a subquery to LEFT JOIN on:
 * `leftJoin(latest, eq(latest.jobId, jobs.id))`, where `latest = latestApplicationFor(userId)`.
 *
 * `distinct on (job_id)` with the newest first is the whole point: a role applied for, rejected
 * and applied for again has several rows, and only the last of them says where it stands. Rows
 * with no `job_id` — an application recorded before the link existed, or one whose CV was deleted
 * — are excluded rather than joined on null. Built without a `Db`: it is an expression, not a
 * query, so the caller's connection and transaction stay the caller's.
 */
export function latestApplicationFor(userId: string) {
  return new QueryBuilder()
    .selectDistinctOn([applications.jobId], {
      jobId: applications.jobId,
      id: applications.id,
      status: applications.status,
      appliedOn: applications.appliedOn,
      cvId: applications.cvId,
      createdAt: applications.createdAt,
    })
    .from(applications)
    .where(and(eq(applications.userId, userId), isNotNull(applications.jobId)))
    .orderBy(applications.jobId, desc(applications.createdAt), desc(applications.id))
    .as("latest_application");
}

/** The shape `roleStageSql` joins against: what `latestApplicationFor` returns. */
export type LatestApplication = ReturnType<typeof latestApplicationFor>;

/**
 * Whether this account has a live CV for the role in hand — the difference between Shortlisted and
 * Applying. Correlated on `jobs.id`, so it needs the `jobs` join and nothing else; an archived
 * predecessor does not count, because the role is only being applied for while a current CV exists.
 */
export function hasCvSql(userId: string) {
  return sql<boolean>`exists (select 1 from ${cvDrafts} c
    where c.user_id = ${userId} and c.job_id = ${jobs.id} and c.archived_at is null)`;
}

/**
 * The role's stage for one account, in SQL, with the same precedence as `roleStage()` in
 * @christopher/core: the application decides when there is one (it is the furthest anything has
 * got, so it outranks the decision behind it), then archive or skip is Dismissed, then an apply
 * decision is Applying or Shortlisted depending on whether a CV exists, then the gate.
 *
 * Requires the same `user_jobs` row and active-decision LEFT JOIN as `roleStatusSql`, plus
 * `leftJoin(latest, eq(latest.jobId, jobs.id))` for the subquery passed in.
 */
export function roleStageSql(latest: LatestApplication, userId: string) {
  return sql<RoleStage>`case
    when ${latest.status} is not null then case ${latest.status}
      when 'applying' then 'applying'
      when 'applied' then 'applied'
      when 'screening' then 'in_process'
      when 'interview' then 'in_process'
      when 'offer' then 'in_process'
      when 'accepted' then 'accepted'
      when 'rejected' then 'rejected'
      when 'withdrawn' then 'dismissed'
      /* A status this build does not know is still an application on record: keep the role in
         the pipeline rather than hiding it under Dismissed. */
      else 'applied' end
    when ${userJobs.archivedAt} is not null then 'dismissed'
    when ${decisions.decision} = 'skip' then 'dismissed'
    when ${decisions.decision} = 'apply' then case when ${hasCvSql(userId)} then 'applying' else 'shortlisted' end
    when ${userJobs.inTable} then 'matched'
    else 'dismissed' end`;
}
