import { archiveNonMatches, reserveLocationRead, schema, type Task } from "@ava/db";
import { ats, type SourceSpec, type TaskPayloads } from "@ava/core";
import { and, eq, inArray, ne } from "drizzle-orm";
import { makeFetchContext, type WorkerDeps } from "../context";
import { loadUserSettingsMany } from "../settings";
import { refreshFollowers } from "./description";
import { TaskDeferred } from "../queue";

function specFor(source: typeof schema.careerSources.$inferSelect): SourceSpec {
  return { type: source.type, url: source.url, apiUrl: source.apiUrl ?? undefined,
    atsSlug: source.atsSlug ?? undefined, atsSite: source.atsSite ?? undefined };
}

function sameSource(a: typeof schema.careerSources.$inferSelect, b: typeof schema.careerSources.$inferSelect): boolean {
  return a.type === b.type && a.url === b.url && a.apiUrl === b.apiUrl
    && a.atsSlug === b.atsSlug && a.atsSite === b.atsSite
    && (b.status === "active" || b.status === "failing");
}

/** One paced, validated Workday detail request; the revision fences every resulting write. */
export async function handleFetchLocations(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { jobId, locationRevision } = (task.payload ?? {}) as TaskPayloads["fetch_locations"];
  if (!jobId || !locationRevision) return { skipped: "location task has no job or revision" };
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job || job.status !== "open" || job.locationRevision !== locationRevision
      || !job.locationLabel || !["pending", "unavailable"].includes(job.locationResolution ?? "")) {
    return { skipped: "location revision is no longer pending" };
  }
  const [source] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.id, job.sourceId)).limit(1);
  if (!source || source.type !== "workday" || !["active", "failing"].includes(source.status))
    return { skipped: "Workday source is no longer active" };

  // Preserve every queued candidate, but bound this source's actual detail traffic. Waiting is
  // not a failed attempt: the queue returns its claim and wakes it in the next allowance window.
  const allowance = await reserveLocationRead(deps.db, source.id, deps.now());
  if (!allowance.allowed) return new TaskDeferred(allowance.retryAt,
    { reason: "Waiting for this Workday source's location lookup allowance", sourceId: source.id });

  let detail: Awaited<ReturnType<typeof ats.fetchWorkdayLocations>>;
  try {
    detail = await ats.fetchWorkdayLocations(specFor(source), { url: job.url, locationLabel: job.locationLabel }, makeFetchContext(deps));
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await deps.db.transaction(async tx => {
      await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
      const [currentSource] = await tx.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id)).for("update").limit(1);
      if (!currentSource || !sameSource(source, currentSource)) return;
      const [current] = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update").limit(1);
      if (current?.sourceId !== source.id || current.locationRevision !== locationRevision || current.status !== "open"
          || !["pending", "unavailable"].includes(current.locationResolution ?? "")) return;
      await tx.update(schema.jobs).set({ locationResolution: "unavailable",
        locationError: message, updatedAt: deps.now() }).where(eq(schema.jobs.id, jobId));
    });
    throw error;
  }

  const outcome = await deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    const [currentSource] = await tx.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id)).for("update").limit(1);
    if (!currentSource || !sameSource(source, currentSource)) return { skipped: "Workday source changed during detail fetch" };
    // The scan also takes the source before gate share locks, then writes jobs and views. Keep that
    // order so a settings save or scan cannot deadlock with this shared follower refresh.
    const followers = await tx.select({ userId: schema.companySubscriptions.userId }).from(schema.companySubscriptions)
      .where(and(eq(schema.companySubscriptions.companyId, job.companyId), ne(schema.companySubscriptions.status, "archived")));
    const allSettings = await loadUserSettingsMany(tx as unknown as WorkerDeps["db"],
      followers.map(follower => follower.userId), { lockGates: true });
    const [current] = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update").limit(1);
    if (!current || current.sourceId !== source.id || current.locationRevision !== locationRevision || current.status !== "open"
        || !["pending", "unavailable"].includes(current.locationResolution ?? "")) {
      return { skipped: "newer location evidence won" };
    }
    const eligible = followers.map(follower => follower.userId).filter(id => current.shared || id === current.addedBy);
    const settings = new Map([...allSettings].filter(([id]) => eligible.includes(id)));
    const at = deps.now();
    const scoreInputsChanged = current.location !== detail.location;
    await tx.update(schema.jobs).set({ location: detail.location, locations: detail.locations,
      locationResolution: "resolved", locationFetchedAt: at, locationError: null, updatedAt: at })
      .where(eq(schema.jobs.id, jobId));
    if (scoreInputsChanged && eligible.length) await tx.update(schema.userJobs).set({ fitScore: null, scoredAt: null, updatedAt: at })
      .where(and(eq(schema.userJobs.jobId, jobId), inArray(schema.userJobs.userId, eligible)));
    await refreshFollowers(deps, tx as unknown as WorkerDeps["db"], at,
      { ...current, location: detail.location, locations: detail.locations, locationResolution: "resolved", locationFetchedAt: at },
      settings, scoreInputsChanged, { preserveHidden: true });
    await archiveNonMatches(tx as unknown as WorkerDeps["db"], { jobId });
    if (deps.signal?.aborted) throw deps.signal.reason ?? new Error("Location task stopped during publication");
    return { jobId, resolved: true, locations: detail.locations.length, followers: eligible.length };
  });
  return outcome;
}
