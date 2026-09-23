/**
 * Recording a decision on a role, for the actions that make one: Roles (`decide`, `decideRoles`)
 * and Applications (Withdrawn is a skip). Deliberately not a "use server" module: everything here
 * takes the caller's transaction and an account id the caller has already authenticated, so none
 * of it may be a public endpoint.
 */
import { and, eq, sql } from "drizzle-orm";
import { companies, decisions, jobEvents, jobs, userJobs } from "@ava/db/schema";
import type { db } from "./db";
import { enqueue } from "./enqueue";
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
 * Record (or edit) one decision on a role, or undo it when `decision` is null, inside the caller's
 * transaction. It always supersedes the previous active decision; a new one is inserted with a
 * denormalised snapshot so the learning corpus survives job or company deletion.
 */
export async function recordDecision(tx: Tx, userId: string, jobId: string, decision: "apply" | "skip" | null, reason: string): Promise<{ decisionId: string | null }> {
  const locked = await lockRoleView(tx, userId, jobId);
  if (!locked) throw new UserFacingError("Role not found.");
  const before = await countStandingDecisions(tx, userId);
  const [existing] = await tx
    .select({ id: decisions.id, decision: decisions.decision })
    .from(decisions)
    .where(and(eq(decisions.userId, userId), eq(decisions.jobId, jobId), eq(decisions.superseded, false)))
    .limit(1);

  if (decision === null) {
    if (existing) await tx.update(decisions).set({ superseded: true }).where(eq(decisions.id, existing.id));
    if (existing?.decision === "skip") await restoreDismissedApplications(tx, userId, [jobId]);
    if (!locked.inTable && !locked.archivedAt) {
      await tx.update(userJobs).set({ archivedAt: new Date(), updatedAt: new Date() }).where(and(eq(userJobs.userId, userId), eq(userJobs.jobId, jobId)));
      await tx.insert(jobEvents).values({ jobId, userId, type: "updated", payload: { action: "archived", actor: "system", reason: "No longer matches your criteria" } });
    }
    await tx.insert(jobEvents).values({ jobId, userId, type: "decided", payload: { decision: null } });
    await enqueue("synthesize_profile", { userId, force: true }, tx);
    return { decisionId: null };
  }

  await tx.update(userJobs).set({ archivedAt: null, updatedAt: new Date() }).where(and(eq(userJobs.userId, userId), eq(userJobs.jobId, jobId)));
  if (existing) await tx.update(decisions).set({ superseded: true }).where(eq(decisions.id, existing.id));

  const [row] = await tx.select({ job: jobs, fitScore: userJobs.fitScore }).from(jobs)
    .innerJoin(userJobs, and(eq(userJobs.jobId, jobs.id), eq(userJobs.userId, userId)))
    .where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw new UserFacingError("Role not found.");
  const job = row.job;
  const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, job.companyId)).limit(1);

  const [inserted] = await tx
    .insert(decisions)
    .values({
      userId,
      jobId,
      decision,
      reason,
      jobTitle: job.title,
      companyName: company?.name ?? "",
      jobLocation: job.location,
      jobDepartment: job.department,
      descriptionSnippet: job.descriptionText ? job.descriptionText.slice(0, 300) : null,
      fitScoreAtDecision: row.fitScore,
    })
    .returning({ id: decisions.id });
  const decisionId = inserted?.id ?? null;

  await tx.insert(jobEvents).values({ jobId, userId, type: "decided", payload: { decision, reason } });
  if (decision === "apply") await enqueue("score_job", { userId, jobId }, tx);
  if (decision === "skip") await withdrawLiveApplications(tx, userId, [jobId]);
  if (decisionId && reason) await enqueue("tag_reason", { decisionId }, tx);
  await enqueue("synthesize_profile", { userId, force: false }, tx);
  await queueFilterSuggestionsOnCrossing(tx, userId, before);
  return { decisionId };
}
