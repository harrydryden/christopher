"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requestScores, type Db } from "@ava/db";
import { decisions, jobs, userJobs } from "@ava/db/schema";
import { requireVerifiedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidate } from "@/lib/action-helpers";
import { actionError, fail, ok, zUuid, type ActionResult } from "@/lib/validation";

/** Retry one failed score without changing the previous score or the person's decision. */
export async function retryFailedScore(jobId: string): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  const parsed = zUuid().safeParse(jobId);
  if (!parsed.success) return fail("Role not found.");
  try {
    const result = await db().transaction(async tx => {
      // This account's view is the authority and the lock serialises retries with decisions,
      // archive and worker admission. A stale panel cannot overwrite a completed score.
      const [view] = await tx.select({
        scoreState: userJobs.scoreState, inTable: userJobs.inTable, archivedAt: userJobs.archivedAt,
      }).from(userJobs).where(and(eq(userJobs.userId, user.id), eq(userJobs.jobId, parsed.data))).for("update");
      if (!view) return "missing" as const;
      const [job] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, parsed.data));
      const [choice] = await tx.select({ decision: decisions.decision }).from(decisions)
        .where(and(eq(decisions.userId, user.id), eq(decisions.jobId, parsed.data), eq(decisions.superseded, false)));
      if (job?.status !== "open" || view.archivedAt || choice?.decision === "skip" ||
          (!view.inTable && choice?.decision !== "apply")) return "ineligible" as const;
      if (view.scoreState === "requested" || view.scoreState === "queued") return "pending" as const;
      if (view.scoreState !== "failed") return "changed" as const;
      await requestScores(tx as unknown as Db, [{ userId: user.id, jobId: parsed.data }], new Date(),
        { priority: 1, onlyUnscored: false });
      return "requested" as const;
    });
    if (result === "missing") return fail("Role not found.");
    if (result === "ineligible") return fail("This role is no longer eligible for scoring. You can still review it manually.");
    if (result === "changed") return fail("This score has changed. Refresh the role to see its current status.");
    revalidate("/");
    revalidatePath("/companies/[id]", "page");
    return ok();
  } catch (error) {
    return actionError(error, "Could not request a score retry. Please try again.");
  }
}
