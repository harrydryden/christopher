"use server";

import { requireSession } from "@/lib/auth";

import { and, eq, inArray } from "drizzle-orm";
import { companies, decisions, jobEvents, jobs, tagVocabulary } from "@christopher/db/schema";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { fail, ok, zUuid, type ActionResult } from "@/lib/validation";

const DecideSchema = z.object({
  jobId: zUuid(),
  decision: z.enum(["apply", "skip"]).nullable(),
  reason: z.string().max(4000).optional().default(""),
});

/**
 * Record (or edit) a decision on a role, or undo it when `decision` is null.
 * Always supersedes the previous active decision; a new decision is inserted with a
 * denormalised snapshot so the learning corpus survives job/company deletion.
 */
export async function decide(jobId: string, decision: "apply" | "skip" | null, reason: string): Promise<ActionResult> {
  await requireSession();
  const parsed = DecideSchema.safeParse({ jobId, decision, reason });
  if (!parsed.success) return fail("Invalid request.");
  const input = parsed.data;
  const trimmedReason = input.reason.trim();
  if (input.decision === "skip" && trimmedReason === "") {
    return fail("A reason is required to skip.");
  }

  let decisionId: string | null = null;

  try {
    await db().transaction(async (tx) => {
      const [locked] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, input.jobId)).for("update");
      if (!locked) throw new Error("Role not found.");
      const existingRows = await tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.jobId, input.jobId), eq(decisions.superseded, false)))
        .limit(1);
      const existing = existingRows[0] ?? null;

      if (input.decision === null) {
        if (existing) await tx.update(decisions).set({ superseded: true }).where(eq(decisions.id, existing.id));
        await tx.insert(jobEvents).values({ jobId: input.jobId, type: "decided", payload: { decision: null } });
        return;
      }

      if (existing) {
        await tx.update(decisions).set({ superseded: true }).where(eq(decisions.id, existing.id));
      }

      const jobRows = await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).limit(1);
      const job = jobRows[0];
      if (!job) throw new Error("Role not found.");
      const companyRows = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, job.companyId)).limit(1);
      const companyName = companyRows[0]?.name ?? "";

      const inserted = await tx
        .insert(decisions)
        .values({
          jobId: input.jobId,
          decision: input.decision,
          reason: trimmedReason,
          jobTitle: job.title,
          companyName,
          jobLocation: job.location,
          jobDepartment: job.department,
          descriptionSnippet: job.descriptionText ? job.descriptionText.slice(0, 300) : null,
          fitScoreAtDecision: job.fitScore,
        })
        .returning({ id: decisions.id });
      decisionId = inserted[0]?.id ?? null;

      await tx.insert(jobEvents).values({
        jobId: input.jobId,
        type: "decided",
        payload: { decision: input.decision, reason: trimmedReason },
      });
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Failed to save decision.");
  }

  if (decisionId) await enqueue("tag_reason", { decisionId });
  await enqueue("synthesize_profile", { force: false });

  revalidatePath("/");
  return ok();
}

export async function saveDecisionTags(decisionId: string, formData: FormData): Promise<void> {
  await requireSession();
  const id = zUuid().parse(decisionId);
  const tags = [...new Set(formData.getAll("tags").map(String))];
  if (tags.length > 30) throw new Error("Choose at most 30 tags.");
  const accepted = tags.length ? await db().select({ tag: tagVocabulary.tag }).from(tagVocabulary)
    .where(and(inArray(tagVocabulary.tag, tags), eq(tagVocabulary.accepted, true))) : [];
  if (accepted.length !== tags.length) throw new Error("Choose accepted reason tags from the list.");
  const updated = await db().update(decisions).set({ tags, tagsEdited: true })
    .where(and(eq(decisions.id, id), eq(decisions.superseded, false))).returning({ id: decisions.id });
  if (!updated.length) throw new Error("This decision has changed. Reload before editing its tags.");
  await enqueue("synthesize_profile", { force: true });
  revalidatePath("/learning");
  revalidatePath("/");
}

/** Archive is a user preference, independent of source status and future scans. */
export async function archiveRoles(jobIds: string[], archived: boolean): Promise<ActionResult> {
  await requireSession();
  const parsed = z.array(zUuid()).min(1).max(500).safeParse(jobIds);
  if (!parsed.success || typeof archived !== "boolean") return fail("Select between 1 and 500 roles.");
  await db().update(jobs).set({ archivedAt: archived ? new Date() : null }).where(inArray(jobs.id, [...new Set(parsed.data)]));
  revalidatePath("/");
  return ok();
}

export async function decideRoles(jobIds: string[], decision: "apply" | "skip" | null, reason: string): Promise<ActionResult> {
  await requireSession();
  const ids = z.array(zUuid()).min(1).max(100).safeParse(jobIds);
  const input = DecideSchema.omit({ jobId: true }).safeParse({ decision, reason });
  if (!ids.success || !input.success) return fail("Select between 1 and 100 roles.");
  if (decision === "skip" && !reason.trim()) return fail("A reason is required to skip.");
  // Each decision is independently durable; report a failure without claiming the whole batch succeeded.
  for (const id of [...new Set(ids.data)].sort()) {
    const result = await decide(id, decision, reason);
    if (!result.ok) return fail(`Stopped at a role that could not be saved: ${result.error}. Earlier changes were saved.`);
  }
  return ok();
}
