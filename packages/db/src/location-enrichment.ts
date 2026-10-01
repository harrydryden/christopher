import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client";
import { jobs } from "./schema";
import { enqueueStandard } from "./tasks";

export interface LocationRevisionInput {
  sourceId: string;
  externalKey: string;
  url: string;
  title: string;
  locationLabel: string;
}

/** The observation changes with meaningful listing fields or a seven-day freshness bucket. */
export function locationRevisionFor(job: LocationRevisionInput, now: Date): string {
  return createHash("sha1").update(JSON.stringify([
    job.sourceId, job.externalKey, job.url, job.title, job.locationLabel,
    Math.floor(now.getTime() / (7 * 86_400_000)),
  ])).digest("hex");
}

export interface LocationEnrichmentCandidate extends LocationRevisionInput {
  id: string;
  locationResolution: "pending" | "resolved" | "unavailable" | null;
  locationRevision: string | null;
}

/** Queue one pending Workday role, including rows backfilled before revisions existed. */
export async function requestLocationEnrichment(db: Db, job: LocationEnrichmentCandidate, now: Date): Promise<string | null> {
  if (job.locationResolution !== "pending") return null;
  return db.transaction(async (tx) => {
    let revision = job.locationRevision;
    if (!revision) {
      revision = locationRevisionFor(job, now);
      const [updated] = await tx.update(jobs).set({ locationRevision: revision })
        .where(and(eq(jobs.id, job.id), eq(jobs.locationResolution, "pending"), isNull(jobs.locationRevision)))
        .returning({ id: jobs.id });
      if (!updated) return null;
    }
    return enqueueStandard(tx, "fetch_locations", { jobId: job.id, locationRevision: revision });
  });
}
