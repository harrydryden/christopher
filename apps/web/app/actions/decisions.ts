"use server";

import { and, eq } from "drizzle-orm";
import { companies, decisions, jobEvents, jobs } from "@christopher/db/schema";
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
      const existingRows = await tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.jobId, input.jobId), eq(decisions.superseded, false)))
        .limit(1);
      const existing = existingRows[0] ?? null;

      if (input.decision === null) {
        if (existing) await tx.delete(decisions).where(eq(decisions.id, existing.id));
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
