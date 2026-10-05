/** Durable HTTP listing pages for a scan_company task that yields between bounded page batches. */
import { createHash } from "node:crypto";
import { schema, type CareerSource, type Db } from "@col/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";

export const HTML_GENERATION_MAX_AGE_MS = 2 * 60 * 60_000;
// Parsed JSON expands several times in V8, then final reconciliation and snapshotting copy it.
// Three megabytes leaves headroom for three worker slots inside the worker's memory budget.
export const HTML_GENERATION_MAX_BYTES = 3_000_000;
export const HTML_GENERATION_MAX_PAGES = 600;
export const HTML_GENERATION_MAX_RESTARTS = 2;

/** The URL and every parser input, rather than just the two URLs checked by ordinary scans. */
export function htmlSourceFingerprint(source: CareerSource): string {
  return createHash("sha256").update(JSON.stringify([
    source.companyId, source.type, source.url, source.apiUrl, source.atsSlug,
    source.atsSite, source.recipe, source.status,
  ])).digest("hex");
}

export class HtmlCheckpointChanged extends Error {
  constructor(message: string) { super(message); this.name = "HtmlCheckpointChanged"; }
}

type Generation = typeof schema.htmlScanGenerations.$inferSelect;
export type StoredHtmlPage = typeof schema.htmlScanPages.$inferSelect;
export interface HtmlCheckpoint { generation: Generation; pages: StoredHtmlPage[]; expired: boolean; }
export interface HtmlScanMetrics { requests: number; fetchedBytes: number; revalidated: number; activeDurationMs: number; }

async function lockAndCheckSource(db: Db, source: CareerSource): Promise<void> {
  const [current] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id)).for("update");
  if (!current || !["active", "failing"].includes(current.status) || htmlSourceFingerprint(current) !== htmlSourceFingerprint(source)) {
    throw new HtmlCheckpointChanged("Career source changed during listing traversal; reload the source before continuing");
  }
}

export async function loadHtmlCheckpoint(deps: WorkerDeps, taskId: string, source: CareerSource): Promise<HtmlCheckpoint> {
  return deps.db.transaction(async tx => {
    const db = tx as unknown as Db;
    await deps.assertOwnership?.(db);
    await lockAndCheckSource(db, source);
    const fingerprint = htmlSourceFingerprint(source);
    await db.insert(schema.htmlScanGenerations).values({
      taskId, sourceId: source.id, sourceFingerprint: fingerprint, nextUrl: source.url,
      startedAt: deps.now(), updatedAt: deps.now(),
      expiresAt: new Date(deps.now().getTime() + HTML_GENERATION_MAX_AGE_MS),
    }).onConflictDoNothing();
    const [generation] = await db.select().from(schema.htmlScanGenerations)
      .where(and(eq(schema.htmlScanGenerations.taskId, taskId), eq(schema.htmlScanGenerations.sourceId, source.id))).for("update");
    if (!generation) throw new Error("Could not create HTML scan checkpoint");
    if (generation.sourceFingerprint !== fingerprint) {
      // The task itself is still valid, but no page of the previous source configuration may be
      // reconciled with the new one. Keep the original deadline and consume a restart allowance.
      await db.delete(schema.htmlScanPages).where(eq(schema.htmlScanPages.generationId, generation.id));
      const [reset] = await db.update(schema.htmlScanGenerations).set({ sourceFingerprint: fingerprint,
        nextUrl: source.url, bytesStored: 0, minAdvertised: 0, publishedPageCount: 0, restarts: generation.restarts + 1,
        metricsComplete: false, updatedAt: deps.now() })
        .where(eq(schema.htmlScanGenerations.id, generation.id)).returning();
      return { generation: reset!, pages: [], expired: reset!.expiresAt <= deps.now() || reset!.restarts > HTML_GENERATION_MAX_RESTARTS };
    }
    const pages = await db.select().from(schema.htmlScanPages)
      .where(eq(schema.htmlScanPages.generationId, generation.id)).orderBy(schema.htmlScanPages.pageIndex);
    return { generation, pages, expired: generation.expiresAt <= deps.now() };
  });
}

/** A changed first or boundary page invalidates the entire generation. Age and restart limits persist. */
export async function restartHtmlCheckpoint(deps: WorkerDeps, checkpoint: HtmlCheckpoint, source: CareerSource): Promise<HtmlCheckpoint> {
  return deps.db.transaction(async tx => {
    const db = tx as unknown as Db;
    await deps.assertOwnership?.(db);
    await lockAndCheckSource(db, source);
    const [generation] = await db.select().from(schema.htmlScanGenerations)
      .where(eq(schema.htmlScanGenerations.id, checkpoint.generation.id)).for("update");
    if (!generation || generation.sourceFingerprint !== htmlSourceFingerprint(source)) throw new HtmlCheckpointChanged("Listing checkpoint was replaced");
    if (generation.expiresAt <= deps.now() || generation.restarts >= HTML_GENERATION_MAX_RESTARTS) {
      // Repeated drift means those pages belong to an earlier generation. Keep the attention
      // signal, but do not publish their roles as observations of the present listing.
      await db.delete(schema.htmlScanPages).where(eq(schema.htmlScanPages.generationId, generation.id));
      return { generation, pages: [], expired: true };
    }
    await db.delete(schema.htmlScanPages).where(eq(schema.htmlScanPages.generationId, generation.id));
    const [reset] = await db.update(schema.htmlScanGenerations).set({ nextUrl: source.url, bytesStored: 0, minAdvertised: 0,
      publishedPageCount: 0, restarts: generation.restarts + 1, updatedAt: deps.now() })
      .where(eq(schema.htmlScanGenerations.id, generation.id)).returning();
    return { generation: reset!, pages: [], expired: false };
  });
}

export async function appendHtmlCheckpointPage(deps: WorkerDeps, checkpoint: HtmlCheckpoint, source: CareerSource, input: {
  url: string; nextUrl: string | null; contentHash: string; semanticHash: string; roleSetHash: string; minAdvertised: number; postings: Record<string, unknown>[];
  dropped: number; recipe?: Record<string, unknown>; observedAt: Date;
}): Promise<HtmlCheckpoint> {
  return deps.db.transaction(async tx => {
    const db = tx as unknown as Db;
    await deps.assertOwnership?.(db);
    await lockAndCheckSource(db, source);
    const [generation] = await db.select().from(schema.htmlScanGenerations)
      .where(eq(schema.htmlScanGenerations.id, checkpoint.generation.id)).for("update");
    if (!generation || generation.sourceFingerprint !== htmlSourceFingerprint(source) || generation.nextUrl !== input.url) {
      throw new HtmlCheckpointChanged("Listing checkpoint cursor changed; the page cannot be appended");
    }
    const bytesStored = Buffer.byteLength(JSON.stringify(input.postings), "utf8");
    if (checkpoint.pages.length >= HTML_GENERATION_MAX_PAGES || generation.bytesStored + bytesStored > HTML_GENERATION_MAX_BYTES || generation.expiresAt <= deps.now()) {
      throw new HtmlCheckpointChanged("Listing checkpoint reached its bounded page, byte or age limit");
    }
    const [page] = await db.insert(schema.htmlScanPages).values({
      generationId: generation.id, pageIndex: checkpoint.pages.length, url: input.url,
      nextUrl: input.nextUrl, contentHash: input.contentHash, semanticHash: input.semanticHash, roleSetHash: input.roleSetHash, postings: input.postings,
      dropped: input.dropped, recipe: input.recipe ?? null, bytesStored, observedAt: input.observedAt,
    }).returning();
    const [updated] = await db.update(schema.htmlScanGenerations).set({ nextUrl: input.nextUrl ?? "", bytesStored: generation.bytesStored + bytesStored,
      minAdvertised: Math.max(generation.minAdvertised, input.minAdvertised), updatedAt: deps.now() })
      .where(eq(schema.htmlScanGenerations.id, generation.id)).returning();
    return { generation: updated!, pages: [...checkpoint.pages, page!], expired: false };
  });
}

/** Persist this claim's counters before TaskDeferred hands back the task. The task/resource fence
 * makes a stale claimant unable to add counts; an interrupted attempt is marked unavailable. */
export async function recordHtmlCheckpointMetrics(deps: WorkerDeps, taskId: string, source: CareerSource,
  delta: HtmlScanMetrics, taskAttempt: number): Promise<void> {
  await deps.db.transaction(async tx => {
    const db = tx as unknown as Db;
    await deps.assertOwnership?.(db);
    await lockAndCheckSource(db, source);
    const [generation] = await db.select().from(schema.htmlScanGenerations)
      .where(and(eq(schema.htmlScanGenerations.taskId, taskId), eq(schema.htmlScanGenerations.sourceId, source.id))).for("update");
    if (!generation || generation.sourceFingerprint !== htmlSourceFingerprint(source)) throw new HtmlCheckpointChanged("Listing generation changed before metrics were recorded");
    await db.update(schema.htmlScanGenerations).set({
      requests: generation.requests + delta.requests, fetchedBytes: generation.fetchedBytes + delta.fetchedBytes,
      revalidated: generation.revalidated + delta.revalidated,
      activeDurationMs: generation.activeDurationMs + delta.activeDurationMs,
      metricsComplete: generation.metricsComplete && taskAttempt <= 1,
      updatedAt: deps.now(),
    }).where(eq(schema.htmlScanGenerations.id, generation.id));
  });
}

/** Called inside the same transaction as final reconciliation; a crash after commit retains the scan marker. */
export async function clearHtmlCheckpoint(db: Db, taskId: string, sourceId: string): Promise<void> {
  await db.delete(schema.htmlScanGenerations).where(and(eq(schema.htmlScanGenerations.taskId, taskId), eq(schema.htmlScanGenerations.sourceId, sourceId)));
}

/** Best-effort retention for abandoned tasks; never removes a current generation. */
export async function pruneHtmlCheckpoints(db: Db, now: Date): Promise<void> {
  await db.delete(schema.htmlScanGenerations).where(and(
    lt(schema.htmlScanGenerations.expiresAt, new Date(now.getTime() - 86_400_000)),
    sql`not exists (select 1 from tasks t where t.id = ${schema.htmlScanGenerations.taskId} and t.status in ('queued','running'))`,
  ));
}
