"use server";

import { requireAdmin, requireUser } from "@/lib/auth";

import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { careerSources, companySubscriptions, discoveryRuns, tasks } from "@ava/db/schema";
import { db } from "@/lib/db";
import { UserFacingError, zUuid } from "@/lib/validation";

/** The queue is shared by every account, so only an administrator restarts its failures. */
export async function retryTask(taskId: string): Promise<void> {
  await requireAdmin();
  const id = zUuid().parse(taskId);
  await db()
    .update(tasks)
    .set({ status: "queued", attempts: 0, error: null, lockedAt: null, lockedBy: null, startedAt: null, finishedAt: null })
    .where(eq(tasks.id, id));
  revalidatePath("/health");
}

/**
 * Keep the source that is already scanning, and put the proposal to bed.
 *
 * A re-discovery proposal is a `discovery_runs` row left at `needs_confirmation` while a source is
 * already working — what an ATS migration looks like from here. Accepting one is
 * `useDiscoveryCandidate`; declining one has to end the run as well, or Health asks the same
 * question on every visit. It ends the same way accepting does, through the two columns that
 * already exist: the run resolves onto the source in use, and that source is marked confirmed,
 * because a follower has now stood behind it. No new state and no new column.
 *
 * Every follower of the company may judge it, which is why this needs only a signed-in account
 * with a subscription it has not archived: it starts no scan, no discovery and no model call, and
 * it changes nothing about what is scanned. Accepting a candidate instead is an administrator's
 * once a source is working (`useDiscoveryCandidate`).
 */
export async function keepCurrentSource(runId: string): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(runId);
  const companyId = await db().transaction(async (tx) => {
    const [run] = await tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, id)).for("update");
    if (!run) throw new UserFacingError("Discovery run not found.");
    const [subscription] = await tx
      .select({ status: companySubscriptions.status })
      .from(companySubscriptions)
      .where(and(eq(companySubscriptions.userId, user.id), eq(companySubscriptions.companyId, run.companyId)))
      .limit(1);
    if (!subscription) throw new UserFacingError("You do not follow this company.");
    if (subscription.status === "archived") throw new UserFacingError("Resume following this company first.");
    // Another follower may have answered it already; that is an answer, not a conflict.
    if (run.status !== "needs_confirmation") return run.companyId;
    const [keep] = await tx
      .select({ id: careerSources.id })
      .from(careerSources)
      .where(and(eq(careerSources.companyId, run.companyId), eq(careerSources.status, "active")))
      .orderBy(asc(careerSources.createdAt))
      .limit(1);
    if (!keep) throw new UserFacingError("There is no working source to keep. Pick one of the candidates instead.");
    await tx.update(careerSources).set({ confirmedByUser: true }).where(eq(careerSources.id, keep.id));
    await tx
      .update(discoveryRuns)
      .set({ status: "resolved", chosenSourceId: keep.id, finishedAt: new Date() })
      .where(eq(discoveryRuns.id, id));
    return run.companyId;
  });
  revalidatePath("/health");
  revalidatePath("/companies");
  revalidatePath(`/companies/${companyId}`);
}
