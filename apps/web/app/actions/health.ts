"use server";

import { requireAdmin, requireUser, requireVerifiedUser } from "@/lib/auth";

import { and, asc, eq, sql } from "drizzle-orm";
import { requestLocationEnrichment, type Db } from "@col/db";
import { careerSources, companies, companySubscriptions, discoveryRuns, jobs, tasks } from "@col/db/schema";
import { markSourceConfirmed, useDiscoveryCandidate } from "./companies";
import { db } from "@/lib/db";
import { fail, isUserFacingError, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";
import { refuseOn, revalidate } from "@/lib/action-helpers";

/** A unique violation, however the driver wraps it: another row already holds this dedupe key. */
function isDuplicateKey(error: unknown): boolean {
  const code = (value: unknown) => (typeof value === "object" && value !== null ? (value as { code?: unknown }).code : undefined);
  return code(error) === "23505" || code((error as { cause?: unknown } | null)?.cause) === "23505";
}

/**
 * The queue is shared by every account, so only an administrator restarts its failures — and only
 * failures. A double-submitted form or a stale page must not reset a task that has been claimed
 * since, which would discard its run and start another beside it. Attempts keep counting and the
 * task gets three more, so a retried task never reissues an attempt number (and with it the fence
 * token) of a run that may still be unwinding. When the same work is already queued or running
 * again, there is nothing to retry, and the page says so.
 */
export async function retryTask(taskId: string): Promise<void> {
  await requireAdmin();
  const parsed = zUuid().safeParse(taskId);
  if (!parsed.success) return;
  const id = parsed.data;
  let duplicate = false;
  try {
    const [retried] = await db()
      .update(tasks)
      .set({ status: "queued", maxAttempts: sql`${tasks.attempts} + 3`, error: null, lockedAt: null, lockedBy: null, startedAt: null, finishedAt: null, runAfter: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.status, "failed"), sql`not exists (select 1 from tasks again
        where again.dedupe_key = ${tasks.dedupeKey} and again.id <> ${tasks.id} and again.status in ('queued', 'running'))`))
      .returning({ id: tasks.id });
    if (!retried) {
      // Not failed any more (already retried, or running) is an answer; a live twin is a refusal.
      const [twin] = await db().select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.status, "failed")))
        .limit(1);
      duplicate = !!twin;
    }
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    duplicate = true;
  }
  revalidate("/health", "/admin/health");
  if (duplicate) refuseOn("/admin/health", "This task is already queued or running again, so there is nothing to retry.");
}

/** A follower can retry a location read only for an open role on a current Workday source. */
export async function retryLocationCheck(jobId: string): Promise<void> {
  const user = await requireVerifiedUser();
  const id = zUuid().parse(jobId);
  const outcome = await db().transaction(async tx => {
    const [job] = await tx.select({
      id: jobs.id, companyId: jobs.companyId, sourceId: jobs.sourceId, status: jobs.status,
      shared: jobs.shared, addedBy: jobs.addedBy,
      resolution: jobs.locationResolution, revision: jobs.locationRevision,
      label: jobs.locationLabel, externalKey: jobs.externalKey, url: jobs.url, title: jobs.title,
    }).from(jobs).where(eq(jobs.id, id)).for("update");
    if (!job || !job.sourceId || !job.companyId || !job.url) throw new UserFacingError("This role is no longer available for a location check.");
    const [scope] = await tx.select({ companyStatus: companies.status, followStatus: companySubscriptions.status, sourceCompanyId: careerSources.companyId, sourceStatus: careerSources.status, sourceType: careerSources.type })
      .from(companies)
      .innerJoin(companySubscriptions, and(eq(companySubscriptions.companyId, companies.id), eq(companySubscriptions.userId, user.id)))
      .innerJoin(careerSources, eq(careerSources.id, job.sourceId))
      .where(eq(companies.id, job.companyId)).limit(1);
    if (!scope || scope.followStatus !== "active" || scope.companyStatus !== "active" || scope.sourceCompanyId !== job.companyId || scope.sourceType !== "workday" ||
        (scope.sourceStatus !== "active" && scope.sourceStatus !== "failing") || job.status !== "open" ||
        (!job.shared && job.addedBy !== user.id) ||
        (job.resolution !== "pending" && job.resolution !== "unavailable"))
      throw new UserFacingError("This location check is no longer available. Refresh Health for its current status.");
    if (!job.label) throw new UserFacingError("This location check needs a fresh company scan. Open the company and choose Rescan.");
    const [active] = await tx.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.type, "fetch_locations"), sql`${tasks.payload}->>'jobId' = ${id}`,
      ...(job.revision ? [sql`${tasks.payload}->>'locationRevision' = ${job.revision}`] : []),
      sql`${tasks.status} in ('queued', 'running')`,
    )).limit(1);
    if (!active) {
      if (job.resolution === "unavailable") await tx.update(jobs).set({ locationResolution: "pending", locationError: null }).where(eq(jobs.id, id));
      await requestLocationEnrichment(tx as unknown as Db, {
        id, sourceId: job.sourceId, externalKey: job.externalKey, url: job.url,
        title: job.title, locationLabel: job.label, locationResolution: "pending", locationRevision: job.revision,
      }, new Date());
    }
    return job.companyId;
  }).catch(error => {
    if (isUserFacingError(error)) refuseOn("/health", error.message);
    throw error;
  });
  revalidate("/health", "/companies", `/companies/${outcome}`);
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
  revalidate("/health", "/companies", `/companies/${companyId}`);
}

/** Health's inline forms keep an expected stale-source or permissions refusal beside the choice. */
export async function confirmHealthSource(sourceId: string, _previous: ActionResult, _data: FormData): Promise<ActionResult> {
  try {
    await markSourceConfirmed(sourceId);
    revalidate("/health");
    return { ok: true };
  } catch (error) {
    if (isUserFacingError(error)) return fail(error.message);
    throw error;
  }
}

export async function useHealthCandidate(runId: string, index: number, _previous: ActionResult, _data: FormData): Promise<ActionResult> {
  try {
    await useDiscoveryCandidate(runId, index);
    revalidate("/health");
    return { ok: true };
  } catch (error) {
    if (isUserFacingError(error)) return fail(error.message);
    throw error;
  }
}

export async function keepHealthCurrentSource(runId: string, _previous: ActionResult, _data: FormData): Promise<ActionResult> {
  try {
    await keepCurrentSource(runId);
    revalidate("/health");
    return { ok: true };
  } catch (error) {
    if (isUserFacingError(error)) return fail(error.message);
    throw error;
  }
}
