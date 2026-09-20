import { and, eq, inArray, sql } from 'drizzle-orm';
import { cvDrafts, tasks } from '@christopher/db/schema';
import { cache } from 'react';
import { db } from './db';
/** Once per request, however many components ask. Only work that can change this account's view counts. */
export const getCompanyWorkStatus = cache(async function getCompanyWorkStatus(userId: string) {
  const [row] = await db().select({ n: sql<number>`count(*)::int`, version: sql<string>`md5(coalesce(string_agg(${tasks.id}::text || ${tasks.status}, ',' order by ${tasks.id}), ''))` })
    .from(tasks).where(and(
      inArray(tasks.type, ['discover', 'scan_company', 'run_daily', 'reevaluate_gate', 'import_posting']),
      inArray(tasks.status, ['queued', 'running']),
      // An import is one account's: another follower's paste must not spin this one's page.
      sql`(${tasks.type} = 'run_daily'
        or (${tasks.type} = 'reevaluate_gate' and coalesce(${tasks.payload}->>'userId', ${userId}) = ${userId})
        or (${tasks.type} = 'import_posting' and ${tasks.payload}->>'userId' = ${userId})
        or (${tasks.type} <> 'import_posting'
            and exists (select 1 from company_subscriptions s where s.user_id = ${userId} and s.company_id::text = ${tasks.payload}->>'companyId')))`,
    ));
  return { active: (row?.n ?? 0) > 0, version: row?.version ?? "" };
});

/**
 * The account's CV builds in flight, for a page that lists CVs rather than watching one.
 *
 * `/api/work-status?cv=<id>` answers for a single build in all the detail its page renders; this
 * is the account-wide reading the applications table needs, where several rows can be building at
 * once and the cell only says Queued, Building… or Ready. The version carries each draft's own
 * state and the state of the queue row behind it, so a cell moves from Queued to Building… to
 * Ready without a reload — and nothing narrower, because a build's milestones live in columns a
 * deployment ahead of the worker's migration may not have yet.
 */
export const getCvWorkStatus = cache(async function getCvWorkStatus(userId: string) {
  const [row] = await db()
    .select({
      n: sql<number>`count(distinct ${cvDrafts.id})::int`,
      version: sql<string>`md5(coalesce(string_agg(${cvDrafts.id}::text || ${cvDrafts.status} || coalesce(${tasks.status}, '-'), ',' order by ${cvDrafts.id}, ${tasks.id}), ''))`,
    })
    .from(cvDrafts)
    // Payload is the stable relationship: a quiz continuation deliberately has a distinct dedupe
    // key so it cannot collide with the task whose worker just paused.
    .leftJoin(tasks, and(eq(tasks.type, 'generate_cv'), sql`${tasks.payload}->>'draftId' = ${cvDrafts.id}::text`))
    .where(and(eq(cvDrafts.userId, userId), inArray(cvDrafts.status, ['queued', 'generating'])));
  return { active: (row?.n ?? 0) > 0, version: row?.version ?? "" };
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
