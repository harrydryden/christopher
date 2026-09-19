"use server";

import { requireUser } from "@/lib/auth";

import { and, eq, inArray, sql } from "drizzle-orm";
import { companies, decisions, jobEvents, jobs, tagVocabulary, userJobs } from "@christopher/db/schema";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { enqueue, enqueueMany } from "@/lib/enqueue";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

/** Spec R-6.1: a reason is required for `skip`, and encouraged (never required) for `apply`. */
const SKIP_REASON_REQUIRED = "Give a reason when you dismiss a role: it is what the ranking learns from.";

const DecideSchema = z
  .object({
    jobId: zUuid(),
    decision: z.enum(["apply", "skip"]).nullable(),
    reason: z.string().max(4000).optional().default(""),
  })
  .refine((v) => v.decision !== "skip" || v.reason.trim().length > 0, { message: SKIP_REASON_REQUIRED, path: ["reason"] });

/**
 * Record (or edit) a decision on a role, or undo it when `decision` is null.
 * Always supersedes the previous active decision; a new decision is inserted with a
 * denormalised snapshot so the learning corpus survives job/company deletion.
 */
export async function decide(jobId: string, decision: "apply" | "skip" | null, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = DecideSchema.safeParse({ jobId, decision, reason });
  if (!parsed.success) return fail(parsed.error.issues.find((issue) => issue.path[0] === "reason")?.message ?? "Invalid request.");
  const input = parsed.data;
  const trimmedReason = input.reason.trim();

  let decisionId: string | null = null;

  try {
    await db().transaction(async (tx) => {
      const [locked] = await tx.select({ jobId: userJobs.jobId, inTable: userJobs.inTable, archivedAt: userJobs.archivedAt }).from(userJobs)
        .where(and(eq(userJobs.userId, user.id), eq(userJobs.jobId, input.jobId))).for("update");
      if (!locked) throw new UserFacingError("Role not found.");
      const existingRows = await tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.userId, user.id), eq(decisions.jobId, input.jobId), eq(decisions.superseded, false)))
        .limit(1);
      const existing = existingRows[0] ?? null;

      if (input.decision === null) {
        if (existing) await tx.update(decisions).set({ superseded: true }).where(eq(decisions.id, existing.id));
        if (!locked.inTable && !locked.archivedAt) {
          await tx.update(userJobs).set({ archivedAt: new Date(), updatedAt: new Date() }).where(and(eq(userJobs.userId, user.id), eq(userJobs.jobId, input.jobId)));
          await tx.insert(jobEvents).values({ jobId: input.jobId, userId: user.id, type: "updated", payload: { action: "archived", actor: "system", reason: "No longer matches your criteria" } });
        }
        await tx.insert(jobEvents).values({ jobId: input.jobId, userId: user.id, type: "decided", payload: { decision: null } });
        await enqueue("synthesize_profile", { userId: user.id, force: true }, tx);
        await enqueue("suggest_filters", { userId: user.id }, tx);
        return;
      }

      await tx.update(userJobs).set({ archivedAt: null, updatedAt: new Date() }).where(and(eq(userJobs.userId, user.id), eq(userJobs.jobId, input.jobId)));
      if (existing) {
        await tx.update(decisions).set({ superseded: true }).where(eq(decisions.id, existing.id));
      }

      const jobRows = await tx.select({ job: jobs, fitScore: userJobs.fitScore }).from(jobs)
        .innerJoin(userJobs, and(eq(userJobs.jobId, jobs.id), eq(userJobs.userId, user.id)))
        .where(eq(jobs.id, input.jobId)).limit(1);
      const row = jobRows[0];
      if (!row) throw new UserFacingError("Role not found.");
      const job = row.job;
      const companyRows = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, job.companyId)).limit(1);
      const companyName = companyRows[0]?.name ?? "";

      const inserted = await tx
        .insert(decisions)
        .values({
          userId: user.id,
          jobId: input.jobId,
          decision: input.decision,
          reason: trimmedReason,
          jobTitle: job.title,
          companyName,
          jobLocation: job.location,
          jobDepartment: job.department,
          descriptionSnippet: job.descriptionText ? job.descriptionText.slice(0, 300) : null,
          fitScoreAtDecision: row.fitScore,
        })
        .returning({ id: decisions.id });
      decisionId = inserted[0]?.id ?? null;

      await tx.insert(jobEvents).values({
        jobId: input.jobId,
        userId: user.id,
        type: "decided",
        payload: { decision: input.decision, reason: trimmedReason },
      });
      if (input.decision === "apply") await enqueue("score_job", { userId: user.id, jobId: input.jobId }, tx);
      if (input.decision === "skip") await withdrawLiveApplications(tx, user.id, [input.jobId]);
      if (decisionId && trimmedReason) await enqueue("tag_reason", { decisionId }, tx);
      await enqueue("synthesize_profile", { userId: user.id, force: false }, tx);
      await enqueue("suggest_filters", { userId: user.id }, tx);
    });
  } catch (err) {
    return actionError(err, "Could not save your decision. Please try again.");
  }


  revalidatePath("/", "layout");
  return ok();
}

export async function saveDecisionTags(decisionId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(decisionId);
  const tags = [...new Set(formData.getAll("tags").map(String))];
  if (tags.length > 30) throw new UserFacingError("Choose at most 30 tags.");
  const accepted = tags.length ? await db().select({ tag: tagVocabulary.tag }).from(tagVocabulary)
    .where(and(eq(tagVocabulary.userId, user.id), inArray(tagVocabulary.tag, tags), eq(tagVocabulary.accepted, true))) : [];
  if (accepted.length !== tags.length) throw new UserFacingError("Choose accepted reason tags from the list.");
  const updated = await db().update(decisions).set({ tags, tagsEdited: true })
    .where(and(eq(decisions.id, id), eq(decisions.userId, user.id), eq(decisions.superseded, false))).returning({ id: decisions.id });
  if (!updated.length) throw new UserFacingError("This decision has changed. Reload before editing its tags.");
  await enqueue("synthesize_profile", { userId: user.id, force: true });
  revalidatePath("/learning");
  revalidatePath("/", "layout");
}

/** Archive is a user preference, independent of source status and future scans. */
export async function archiveRoles(jobIds: string[], archived: boolean): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = z.array(zUuid()).min(1).max(500).safeParse(jobIds);
  if (!parsed.success || typeof archived !== "boolean") return fail("Select between 1 and 500 roles.");
  try {
    await db().transaction(async tx => {
      const ids = [...new Set(parsed.data)];
      const now = new Date();
      // One locking read, one pre-check, one update and one insert, whatever the size of the selection.
      const rows = await tx.select({ jobId: userJobs.jobId, inTable: userJobs.inTable }).from(userJobs)
        .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, ids))).orderBy(userJobs.jobId).for("update");
      if (rows.length !== ids.length) throw new UserFacingError("A selected role no longer exists.");

      // Restoring a role the gate no longer admits is only allowed where a decision holds it.
      const needsDecision = rows.filter(row => !row.inTable).map(row => row.jobId);
      if (!archived && needsDecision.length) {
        const held = await tx.select({ jobId: decisions.jobId }).from(decisions)
          .where(and(eq(decisions.userId, user.id), inArray(decisions.jobId, needsDecision), eq(decisions.superseded, false)));
        if (new Set(held.map(row => row.jobId)).size !== needsDecision.length) {
          throw new UserFacingError("This role no longer matches your criteria. Review it and shortlist it to bring it back, or update your matching preferences.");
        }
      }

      await tx.update(userJobs).set({ archivedAt: archived ? now : null, updatedAt: now })
        .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, ids)));

      const payload = JSON.stringify({ action: archived ? "archived" : "restored", actor: "user" });
      await tx.execute(sql`insert into job_events (job_id, user_id, type, payload)
        select v.job_id, ${user.id}::uuid, 'updated', ${payload}::jsonb
        from user_jobs v
        where v.user_id = ${user.id}::uuid and v.job_id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`);
    });
  } catch (error) { return actionError(error, "Could not update the archive."); }
  revalidatePath("/", "layout");
  return ok();
}

/** Spec R-6.1: the same limit the group toolbar enforces; the archive takes 500 because it writes far less. */
const MAX_GROUP_DECISION = 100;

const DecideGroupSchema = z
  .object({
    jobIds: z.array(zUuid()).min(1).max(MAX_GROUP_DECISION),
    decision: z.enum(["apply", "skip"]).nullable(),
    reason: z.string().max(4000).optional().default(""),
  })
  .refine((v) => v.decision !== "skip" || v.reason.trim().length > 0, { message: SKIP_REASON_REQUIRED, path: ["reason"] });

/**
 * Decide a group of roles at once with one shared reason, or undo the group when `decision` is null.
 * The result is exactly what the same roles decided one at a time would leave behind — one active
 * decision row each superseding the previous one, one `decided` event each, and the same tasks —
 * written set-based in a single transaction. All or nothing: a role that is not this account's, or
 * a group skip without a reason, writes nothing at all rather than leaving part of the group saved.
 */
export async function decideRoles(jobIds: string[], decision: "apply" | "skip" | null, reason: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = DecideGroupSchema.safeParse({ jobIds, decision, reason });
  if (!parsed.success) {
    const reasonIssue = parsed.error.issues.find((issue) => issue.path[0] === "reason");
    return fail(reasonIssue?.message ?? `Select between 1 and ${MAX_GROUP_DECISION} roles.`);
  }
  const input = parsed.data;
  const trimmedReason = input.reason.trim();

  try {
    await db().transaction(async tx => {
      const ids = [...new Set(input.jobIds)].sort();
      const idList = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
      const now = new Date();

      // One locking read in a stable order, like archiveRoles: the whole group or none of it.
      const rows = await tx.select({ jobId: userJobs.jobId, inTable: userJobs.inTable, archivedAt: userJobs.archivedAt }).from(userJobs)
        .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, ids))).orderBy(userJobs.jobId).for("update");
      if (rows.length !== ids.length) throw new UserFacingError("A selected role no longer exists.");

      // Undo keeps the audit record: the previous decision is superseded, never deleted.
      await tx.update(decisions).set({ superseded: true })
        .where(and(eq(decisions.userId, user.id), inArray(decisions.jobId, ids), eq(decisions.superseded, false)));

      if (input.decision === null) {
        // A role the gate no longer admits was only in the table because a decision held it.
        const drops = rows.filter(row => !row.inTable && !row.archivedAt).map(row => row.jobId);
        if (drops.length) {
          await tx.update(userJobs).set({ archivedAt: now, updatedAt: now })
            .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, drops)));
          await tx.insert(jobEvents).values(drops.map(jobId => ({
            jobId, userId: user.id, type: "updated" as const,
            payload: { action: "archived", actor: "system", reason: "No longer matches your criteria" },
          })));
        }
        await tx.insert(jobEvents).values(ids.map(jobId => ({ jobId, userId: user.id, type: "decided" as const, payload: { decision: null } })));
        await enqueue("synthesize_profile", { userId: user.id, force: true }, tx);
        await enqueue("suggest_filters", { userId: user.id }, tx);
        return;
      }

      await tx.update(userJobs).set({ archivedAt: null, updatedAt: now })
        .where(and(eq(userJobs.userId, user.id), inArray(userJobs.jobId, ids)));

      // One insert … select writes the whole group with its denormalised snapshot, so the learning
      // corpus survives job or company deletion exactly as a single decision's does.
      const inserted = await tx.execute<{ id: string; job_id: string }>(sql`
        insert into decisions (user_id, job_id, decision, reason, job_title, company_name, job_location, job_department, description_snippet, fit_score_at_decision)
        select ${user.id}::uuid, j.id, ${input.decision}, ${trimmedReason}, j.title, coalesce(c.name, ''), j.location, j.department,
               left(j.description_text, 300), v.fit_score
        from jobs j
        join user_jobs v on v.job_id = j.id and v.user_id = ${user.id}::uuid
        left join companies c on c.id = j.company_id
        where j.id in (${idList})
        returning id, job_id`);
      const insertedRows = [...inserted.rows];
      if (insertedRows.length !== ids.length) throw new UserFacingError("A selected role no longer exists.");

      const payload = JSON.stringify({ decision: input.decision, reason: trimmedReason });
      await tx.execute(sql`insert into job_events (job_id, user_id, type, payload)
        select v.job_id, ${user.id}::uuid, 'decided', ${payload}::jsonb
        from user_jobs v
        where v.user_id = ${user.id}::uuid and v.job_id in (${idList})`);

      if (input.decision === "apply") await enqueueMany("score_job", ids.map(jobId => ({ userId: user.id, jobId })), tx);
      if (input.decision === "skip") await withdrawLiveApplications(tx, user.id, ids);
      if (trimmedReason) await enqueueMany("tag_reason", insertedRows.map(row => ({ decisionId: row.id })), tx);
      await enqueue("synthesize_profile", { userId: user.id, force: false }, tx);
      await enqueue("suggest_filters", { userId: user.id }, tx);
    });
  } catch (error) {
    return actionError(error, "Could not save your decisions. Please try again.");
  }

  revalidatePath("/", "layout");
  return ok();
}

/**
 * Dismissing a role is also the end of any application still open for it, the mirror of
 * Withdrawn on the applications table recording a skip: the two pages must not disagree about a
 * role the person has passed on. Only the newest application of each role moves, only while it
 * is live — an accepted or rejected outcome is history, and stands whatever is decided later.
 */
async function withdrawLiveApplications(tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }, userId: string, jobIds: string[]): Promise<void> {
  if (!jobIds.length) return;
  const idList = sql.join(jobIds.map(id => sql`${id}::uuid`), sql`, `);
  await tx.execute(sql`update applications set status = 'withdrawn',
      history = history || jsonb_build_array(jsonb_build_object('status', 'withdrawn',
        'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'notes', 'Dismissed from Roles'))
    where id in (
      select distinct on (job_id) id from applications
      where user_id = ${userId}::uuid and job_id in (${idList})
      order by job_id, created_at desc, id desc)
      and status not in ('accepted', 'rejected', 'withdrawn')`);
}
