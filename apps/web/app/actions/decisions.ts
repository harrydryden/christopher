"use server";

import { requireUser } from "@/lib/auth";

import { and, eq, inArray, sql } from "drizzle-orm";
import { companies, decisions, jobEvents, jobs, tagVocabulary, userJobs } from "@christopher/db/schema";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
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
