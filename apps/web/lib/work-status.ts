import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { cvDrafts, tasks } from '@ava/db/schema';
import { CV_PROGRESS_STALE_MS } from './cv-build-state';
import { cache } from 'react';
import { db } from './db';
import { ifMigrated } from './schema-skew';

/**
 * Only work that can change this account's view counts: the daily run's fan-out task is not itself
 * news (each company it queues is), and a logo capture changes nothing a page lists, however long
 * the sweep takes.
 */
function companyWorkWhere(userId: string) {
  return and(
    inArray(tasks.type, ['discover', 'scan_company', 'reevaluate_gate', 'import_posting']),
    inArray(tasks.status, ['queued', 'running']),
    sql`coalesce(${tasks.payload}->>'logoOnly', 'false') <> 'true'`,
    // An import is one account's: another follower's paste must not spin this one's page. The
    // followed companies are one uncorrelated list, read once and hashed, rather than a probe of
    // the account's subscriptions for every queued task of the daily run.
    sql`((${tasks.type} = 'reevaluate_gate' and coalesce(${tasks.payload}->>'userId', ${userId}) = ${userId})
      or (${tasks.type} = 'import_posting' and ${tasks.payload}->>'userId' = ${userId})
      or (${tasks.type} <> 'import_posting'
          and ${tasks.payload}->>'companyId' in (select s.company_id::text from company_subscriptions s where s.user_id = ${userId})))`,
  );
}

/**
 * The companies pages' reading of that work: they show whether discovery is queued or running, so
 * the version moves with each task's status. Exported apart from the memoised reader so a test can
 * read its plan.
 */
export function companyWorkQuery(userId: string) {
  const entry = sql`${tasks.id}::text || ${tasks.status}`;
  return db().select({ n: sql<number>`count(*)::int`, version: sql<string>`md5(coalesce(string_agg(${entry}, ',' order by ${tasks.id}), ''))` })
    .from(tasks).where(companyWorkWhere(userId));
}

/** Once per request, however many components ask. */
export const getCompanyWorkStatus = cache(async function getCompanyWorkStatus(userId: string) {
  const [row] = await companyWorkQuery(userId);
  return { active: (row?.n ?? 0) > 0, version: row?.version ?? "" };
});

/**
 * The Roles page's reading, in one statement: pending exactly when `getCompanyWorkStatus` is, with a
 * version that is a fingerprint of what the page shows rather than of the work behind it. A scan
 * that finds nothing new for this account leaves it alone, so an open tab is not re-rendered for it;
 * one that admits, changes, scores, closes or reopens a role in the account's table moves it.
 *
 * Every column the table renders, and how a change to it is seen here:
 * - the account's views (gate, archive, fit): `user_jobs.updated_at`, and the count for one added;
 * - a blank score's reason ("scoring…", "budget spent"): `user_jobs.score_state_at`, which moves
 *   with the state where `updated_at` does not;
 * - the posting's own fields and description: `jobs.updated_at`;
 * - closing and reopening, which a scan writes without touching `updated_at`: the closed count;
 * - decisions and undos (tab membership, the decided line): the active decisions' count and newest;
 * - the suggestions strip above the table: the pending suggestions' count and newest.
 * Each part reads only this account's rows, so another account's work never moves it.
 */
export function rolesWorkQuery(userId: string) {
  const pending = db().select({ one: sql`1` }).from(tasks).where(companyWorkWhere(userId)).limit(1);
  return db().execute<{ active: boolean; version: string }>(sql`
    select exists (${pending}) as active,
      md5(concat_ws(':', t.n, t.closed, t.views_at, t.scores_at, t.postings_at, d.n, d.newest, s.n, s.newest)) as version
    from (
      select count(*) as n, count(*) filter (where j.status = 'closed') as closed,
        max(uj.updated_at) as views_at, max(uj.score_state_at) as scores_at, max(j.updated_at) as postings_at
      from user_jobs uj join jobs j on j.id = uj.job_id
      where uj.user_id = ${userId}::uuid
    ) t,
    (select count(*) as n, max(created_at) as newest from decisions where user_id = ${userId}::uuid and not superseded) d,
    (select count(*) as n, max(created_at) as newest from filter_suggestions
      where user_id = ${userId}::uuid and status = 'pending' and type <> 'hide_threshold') s`);
}

/** Once per request: the Roles page's notice and the poll it starts read the same thing. */
export const getRolesWorkStatus = cache(async function getRolesWorkStatus(userId: string) {
  const result = await rolesWorkQuery(userId);
  const row = result.rows[0];
  return { active: !!row?.active, version: row?.version ?? "" };
});

/**
 * The account's CV builds in flight, for a page that lists CVs rather than watching one.
 *
 * `/api/cv/[id]/progress` answers for a single build in all the detail its page renders; this
 * is the account-wide reading the applications table needs, where several rows can be building at
 * once and each cell says what its build is doing ("Building · checking batch 3 of 5"). The version
 * carries each draft's own state, the state of the queue row behind it, and the name of the newest
 * motion in its ledger — the name only, not its figures, so the table is rendered again once per
 * motion rather than once per batch or per tick.
 *
 * The ledger is read under a guard: a release serving ahead of the worker's migration falls back
 * to the draft and the queue alone, as this reading was before the ledger existed.
 *
 * `improving` names the ready CVs among them whose optional improvement is still running.
 */
export const getCvWorkStatus = cache(async function getCvWorkStatus(userId: string) {
  // A ready CV whose improvement pass is still running counts too (`cvLedgerLive`): its queue row
  // is still at work, or its ledger opened a motion within the stale window. The table keeps
  // polling while it runs, and the version moves when the pass ends, so an adopted revision reaches
  // the row without a reload.
  const activeTask = sql`exists (select 1 from tasks a where a.payload->>'draftId' = ${cvDrafts.id}::text and a.status in ('queued', 'running'))`;
  const openMotion = sql`exists (select 1 from cv_build_steps o where o.draft_id = ${cvDrafts.id} and o.user_id = ${userId} and o.status = 'running'
    and o.started_at > now() - make_interval(secs => ${CV_PROGRESS_STALE_MS / 1000}))`;
  const building = inArray(cvDrafts.status, ['queued', 'generating']);
  const inFlight = and(eq(cvDrafts.userId, userId), or(building, and(eq(cvDrafts.status, 'ready'), isNull(cvDrafts.archivedAt), or(activeTask, openMotion))));
  const inFlightBehind = and(eq(cvDrafts.userId, userId), or(building, and(eq(cvDrafts.status, 'ready'), isNull(cvDrafts.archivedAt), activeTask)));
  // Payload is the stable relationship: a quiz continuation deliberately has a distinct dedupe
  // key so it cannot collide with the task whose worker just paused.
  const task = and(eq(tasks.type, 'generate_cv'), sql`${tasks.payload}->>'draftId' = ${cvDrafts.id}::text`);
  return ifMigrated(async () => {
    const [row] = await db()
      .select({
        n: sql<number>`count(distinct ${cvDrafts.id})::int`,
        improving: sql<string[]>`coalesce(array_agg(distinct ${cvDrafts.id}::text) filter (where ${cvDrafts.status} = 'ready'), '{}')`,
        // The motion the row's label names (`withBuildProgress`): the newest one still running, else
        // the newest; a budget admission is never named, so the label does not flicker through it.
        version: sql<string>`md5(coalesce(string_agg(${cvDrafts.id}::text || ${cvDrafts.status} || coalesce(${tasks.status}, '-') || coalesce((
          select s.motion from cv_build_steps s where s.draft_id = ${cvDrafts.id} and s.user_id = ${userId} and s.motion <> 'admit_budget'
          order by (s.status = 'running') desc, s.seq desc limit 1
        ), '-'), ',' order by ${cvDrafts.id}, ${tasks.id}), ''))`,
      })
      .from(cvDrafts)
      .leftJoin(tasks, task)
      .where(inFlight);
    return { active: (row?.n ?? 0) > 0, version: row?.version ?? "", improving: row?.improving ?? [] };
  }, async () => {
    // Before the ledger's migration: the draft and the queue alone.
    const [row] = await db()
      .select({
        n: sql<number>`count(distinct ${cvDrafts.id})::int`,
        improving: sql<string[]>`coalesce(array_agg(distinct ${cvDrafts.id}::text) filter (where ${cvDrafts.status} = 'ready'), '{}')`,
        version: sql<string>`md5(coalesce(string_agg(${cvDrafts.id}::text || ${cvDrafts.status} || coalesce(${tasks.status}, '-'), ',' order by ${cvDrafts.id}, ${tasks.id}), ''))`,
      })
      .from(cvDrafts)
      .leftJoin(tasks, task)
      .where(inFlightBehind);
    return { active: (row?.n ?? 0) > 0, version: row?.version ?? "", improving: row?.improving ?? [] };
  });
});

/**
 * Everything this account is waiting on, as one answer for the poll. The two halves stay separate
 * above so a page can still ask only about its companies; what a poll needs is whether anything at
 * all is still moving, and one string that changes when any of it does.
 */
export async function getAccountWorkStatus(userId: string) {
  const [company, cv] = await Promise.all([getCompanyWorkStatus(userId), getCvWorkStatus(userId)]);
  return { active: company.active || cv.active, version: `${company.version}:${cv.version}` };
}
