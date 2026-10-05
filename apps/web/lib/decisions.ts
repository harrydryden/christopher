/**
 * Recording a decision on a role, for the actions that make one: Roles (`decide`, `decideRoles`)
 * and Applications (Withdrawn is a skip). Deliberately not a "use server" module: everything here
 * takes the caller's transaction and an account id the caller has already authenticated, so none
 * of it may be a public endpoint.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { decisions, jobEvents, userJobs } from "@col/db/schema";
import { requestScores, lockAccountScoreInput, accountCanScore, type Db } from "@col/db";
import type { db } from "./db";
import { enqueue, enqueueMany } from "./enqueue";
import { UserFacingError } from "./validation";

export type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/**
 * The role lock: one account's view of one posting, `for update`. Everything that changes where a
 * role stands for an account — a decision, a stage set on Applications, the first application row
 * a CV build writes — takes it first, so those writes never interleave and one role never gets two
 * first applications. Taking it twice in one transaction is harmless.
 */
export async function lockRoleView(tx: Tx, userId: string, jobId: string) {
  const [view] = await tx
    .select({ jobId: userJobs.jobId, inTable: userJobs.inTable, archivedAt: userJobs.archivedAt })
    .from(userJobs)
    .where(and(eq(userJobs.userId, userId), eq(userJobs.jobId, jobId)))
    .for("update");
  return view ?? null;
}

/**
 * How many decisions pass before the filter-suggestion call is queued again (R-6.9 asks for a
 * weekly call; the scheduler owns that). A review session of thirty roles used to queue the model
 * on every one of them, deduped only by the account, so it became a per-decision call.
 */
export const SUGGEST_FILTERS_EVERY = 5;

/** This account's standing decisions: the count the every-fifth rule is about. */
export async function countStandingDecisions(tx: Tx, userId: string): Promise<number> {
  const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(decisions)
    .where(and(eq(decisions.userId, userId), eq(decisions.superseded, false)));
  return counted?.n ?? 0;
}

/**
 * Queue A8 when this transaction took the account's standing decisions across a multiple of five:
 * a group of seven from four to eleven crosses once and queues once, and a re-decision or an undo,
 * which cannot raise the count, never does. `before` is counted under the role lock, before any
 * supersede. Two concurrent decisions may both see the crossing; the account's dedupe key makes
 * that one task.
 */
export async function queueFilterSuggestionsOnCrossing(tx: Tx, userId: string, before: number): Promise<void> {
  const after = await countStandingDecisions(tx, userId);
  if (Math.floor(after / SUGGEST_FILTERS_EVERY) > Math.floor(before / SUGGEST_FILTERS_EVERY)) await enqueue("suggest_filters", { userId }, tx);
}

const idList = (jobIds: string[]) => sql.join(jobIds.map(id => sql`${id}::uuid`), sql`, `);
const nowIso = sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Dismissing a role is also the end of any application still open for it, the mirror of
 * Withdrawn on the applications table recording a skip: the two pages must not disagree about a
 * role the person has passed on. Only the newest application of each role moves, only while it
 * is live — an accepted or rejected outcome is history, and stands whatever is decided later.
 *
 * The entry it appends says it came from Roles and what the status was (`by`, `from`), so undoing
 * the dismissal can put the application back where it stood.
 */
export async function withdrawLiveApplications(tx: Tx, userId: string, jobIds: string[]): Promise<void> {
  if (!jobIds.length) return;
  await tx.execute(sql`update applications set status = 'withdrawn',
      history = history || jsonb_build_array(jsonb_build_object('status', 'withdrawn',
        'at', ${nowIso}, 'notes', 'Dismissed from Roles', 'by', 'roles_dismiss', 'from', status))
    where id in (
      select distinct on (job_id) id from applications
      where user_id = ${userId}::uuid and job_id in (${idList(jobIds)})
      order by job_id, created_at desc, id desc)
      and status not in ('accepted', 'rejected', 'withdrawn')`);
}

/**
 * Undoing a dismissal undoes what the dismissal did to the application too: the newest application
 * of each role goes back to the status it had, with an entry saying so. Only an application whose
 * last entry is that dismissal's own mark moves — a withdrawal recorded on Applications, or one
 * followed by anything else, stays exactly as the person left it.
 */
export async function restoreDismissedApplications(tx: Tx, userId: string, jobIds: string[]): Promise<void> {
  if (!jobIds.length) return;
  await tx.execute(sql`update applications set status = history -> -1 ->> 'from',
      history = history || jsonb_build_array(jsonb_build_object('status', history -> -1 ->> 'from',
        'at', ${nowIso}, 'notes', 'Dismissal undone on Roles', 'by', 'roles_undo'))
    where id in (
      select distinct on (job_id) id from applications
      where user_id = ${userId}::uuid and job_id in (${idList(jobIds)})
      order by job_id, created_at desc, id desc)
      and status = 'withdrawn'
      and history -> -1 ->> 'by' = 'roles_dismiss'
      and history -> -1 ->> 'from' in ('applying', 'applied', 'screening', 'interview', 'offer')`);
}

/**
 * Record (or edit) a decision on each of these roles with one shared reason, or undo them when
 * `decision` is null, inside the caller's transaction. Each supersedes the role's previous active
 * decision (undo keeps the audit record: superseded, never deleted), and a new one is inserted with
 * a denormalised snapshot so the learning corpus survives job or company deletion. Written
 * set-based, so a group leaves exactly what the same roles decided one at a time would — one active
 * decision row each, one `decided` event each, and the same tasks — and all or nothing: a role that
 * is not this account's writes nothing at all, and is refused with `notFound`.
 */
export async function recordDecisions(tx: Tx, userId: string, jobIds: string[], decision: "apply" | "skip" | null, reason: string, notFound = "A selected role no longer exists.", options: { queueFollowUps?: boolean } = {}): Promise<Array<{ jobId: string; id: string }>> {
  const queueFollowUps = options.queueFollowUps !== false;
  if (queueFollowUps) await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
  const canScore = queueFollowUps && await accountCanScore(tx as unknown as Db, userId);
  const ids = [...new Set(jobIds)].sort();
  const now = new Date();

  // One locking read in a stable order, like the archive: the whole group or none of it. The same
  // row lock `lockRoleView` takes, so taking it again under a caller that already holds it is harmless.
  const rows = await tx.select({ jobId: userJobs.jobId, inTable: userJobs.inTable, archivedAt: userJobs.archivedAt }).from(userJobs)
    .where(and(eq(userJobs.userId, userId), inArray(userJobs.jobId, ids))).orderBy(userJobs.jobId).for("update");
  if (rows.length !== ids.length) throw new UserFacingError(notFound);
  const before = await countStandingDecisions(tx, userId);

  const superseded = await tx.update(decisions).set({ superseded: true })
    .where(and(eq(decisions.userId, userId), inArray(decisions.jobId, ids), eq(decisions.superseded, false)))
    .returning({ jobId: decisions.jobId, decision: decisions.decision });

  if (decision === null) {
    // What undoing each dismissal puts back.
    const unskipped = superseded.filter(row => row.decision === "skip" && row.jobId).map(row => row.jobId!);
    await restoreDismissedApplications(tx, userId, unskipped);
    // A skipped role is left out of scoring (its score has no reader); undone, it needs one again.
    // The handler decides whether it is still in the table.
    await requestScores(tx as unknown as Db, unskipped.map(jobId => ({ userId, jobId })), now, { priority: 1 });
    // A role the gate no longer admits was only in the table because a decision held it: the
    // gate's archive, stamped as such, so the view comes back by itself once the gate admits it.
    const drops = rows.filter(row => !row.inTable && !row.archivedAt).map(row => row.jobId);
    if (drops.length) {
      await tx.update(userJobs).set({ archivedAt: now, gateArchivedAt: now, updatedAt: now })
        .where(and(eq(userJobs.userId, userId), inArray(userJobs.jobId, drops)));
      await tx.insert(jobEvents).values(drops.map(jobId => ({
        jobId, userId, type: "updated" as const,
        payload: { action: "archived", actor: "system", reason: "No longer matches your criteria" },
      })));
    }
    await tx.insert(jobEvents).values(ids.map(jobId => ({ jobId, userId, type: "decided" as const, payload: { decision: null } })));
    if (canScore) {
      await enqueue("synthesize_profile", { userId, force: true }, tx);
      await enqueue("rescore_all", { userId, onlyInTable: true }, tx);
    }
    return [];
  }

  await tx.update(userJobs).set({ archivedAt: null, updatedAt: now })
    .where(and(eq(userJobs.userId, userId), inArray(userJobs.jobId, ids)));

  const inserted = await tx.execute<{ id: string; job_id: string }>(sql`
    insert into decisions (user_id, job_id, decision, reason, job_title, company_name, job_location, job_department, description_snippet, fit_score_at_decision)
    select ${userId}::uuid, j.id, ${decision}, ${reason}, j.title, coalesce(c.name, j.company_label, ''),
           case j.location_resolution
             when 'pending' then case
               when j.location_fetched_at is null or coalesce(loc.names, nullif(j.location, '')) is null then 'Locations awaiting verification'
               else concat('Previously verified locations: ', coalesce(loc.names, nullif(j.location, '')), ' — Locations awaiting verification')
             end
             when 'unavailable' then case
               when j.location_fetched_at is null or coalesce(loc.names, nullif(j.location, '')) is null then 'Locations could not be verified'
               else concat('Previously verified locations: ', coalesce(loc.names, nullif(j.location, '')), ' — Locations could not be verified')
             end
             else coalesce(loc.names, j.location)
           end,
           j.department,
           left(j.description_text, 300), v.fit_score
    from jobs j
    join user_jobs v on v.job_id = j.id and v.user_id = ${userId}::uuid
    left join companies c on c.id = j.company_id
    left join lateral (
      select string_agg(place.name, '; ' order by place.position) as names
      from jsonb_array_elements_text(j.locations) with ordinality as place(name, position)
    ) loc on true
    where j.id in (${idList(ids)})
    returning id, job_id`);
  const insertedRows = [...inserted.rows];
  if (insertedRows.length !== ids.length) throw new UserFacingError(notFound);

  const payload = JSON.stringify({ decision, reason });
  await tx.execute(sql`insert into job_events (job_id, user_id, type, payload)
    select v.job_id, ${userId}::uuid, 'decided', ${payload}::jsonb
    from user_jobs v
    where v.user_id = ${userId}::uuid and v.job_id in (${idList(ids)})`);

  if (decision === "apply" && queueFollowUps) await requestScores(tx as unknown as Db, ids.map(jobId => ({ userId, jobId })), now, { priority: 1 });
  if (decision === "skip") await withdrawLiveApplications(tx, userId, ids);
  if (canScore) {
    if (reason) await enqueueMany("tag_reason", insertedRows.map(row => ({ decisionId: row.id })), tx);
    await enqueue("synthesize_profile", { userId, force: false }, tx);
    await enqueue("rescore_all", { userId, onlyInTable: true }, tx);
    await queueFilterSuggestionsOnCrossing(tx, userId, before);
  }
  return insertedRows.map(row => ({ jobId: row.job_id, id: row.id }));
}
