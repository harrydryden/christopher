import { and, eq, inArray, sql } from 'drizzle-orm';
import { cvDrafts, tasks } from '@ava/db/schema';
import { cache } from 'react';
import { db } from './db';
/**
 * Only work that can change this account's view counts: the daily run's fan-out task is not itself
 * news (each company it queues is), and a logo capture changes nothing a page lists, however long
 * the sweep takes. Exported apart from the memoised reader so a test can read its plan.
 */
export function companyWorkQuery(userId: string) {
  return db().select({ n: sql<number>`count(*)::int`, version: sql<string>`md5(coalesce(string_agg(${tasks.id}::text || ${tasks.status}, ',' order by ${tasks.id}), ''))` })
    .from(tasks).where(and(
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
    ));
}

/** Once per request, however many components ask. */
export const getCompanyWorkStatus = cache(async function getCompanyWorkStatus(userId: string) {
  const [row] = await companyWorkQuery(userId);
  return { active: (row?.n ?? 0) > 0, version: row?.version ?? "" };
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
 */
export const getCvWorkStatus = cache(async function getCvWorkStatus(userId: string) {
  const inFlight = and(eq(cvDrafts.userId, userId), inArray(cvDrafts.status, ['queued', 'generating']));
  // Payload is the stable relationship: a quiz continuation deliberately has a distinct dedupe
  // key so it cannot collide with the task whose worker just paused.
  const task = and(eq(tasks.type, 'generate_cv'), sql`${tasks.payload}->>'draftId' = ${cvDrafts.id}::text`);
  try {
    const [row] = await db()
      .select({
        n: sql<number>`count(distinct ${cvDrafts.id})::int`,
        version: sql<string>`md5(coalesce(string_agg(${cvDrafts.id}::text || ${cvDrafts.status} || coalesce(${tasks.status}, '-') || coalesce((
          select s.motion from cv_build_steps s where s.draft_id = ${cvDrafts.id} and s.user_id = ${userId} order by s.seq desc limit 1
        ), '-'), ',' order by ${cvDrafts.id}, ${tasks.id}), ''))`,
      })
      .from(cvDrafts)
      .leftJoin(tasks, task)
      .where(inFlight);
    return { active: (row?.n ?? 0) > 0, version: row?.version ?? "" };
  } catch {
    const [row] = await db()
      .select({
        n: sql<number>`count(distinct ${cvDrafts.id})::int`,
        version: sql<string>`md5(coalesce(string_agg(${cvDrafts.id}::text || ${cvDrafts.status} || coalesce(${tasks.status}, '-'), ',' order by ${cvDrafts.id}, ${tasks.id}), ''))`,
      })
      .from(cvDrafts)
      .leftJoin(tasks, task)
      .where(inFlight);
    return { active: (row?.n ?? 0) > 0, version: row?.version ?? "" };
  }
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
