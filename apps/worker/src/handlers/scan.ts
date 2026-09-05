import { schema, enqueueTask, type CareerSource, type Company, type Task } from "@christopher/db";
import {
  ats,
  classifyScan,
  dedupeKeyFor,
  deriveExternalKey,
  evaluateGate,
  modeForScanStatus,
  normalizeTitle,
  priorityFor,
  reconcile,
  sha1,
  SourceFetchError,
  type AppSettings,
  type ExistingJob,
  type HtmlRecipe,
  type RawPosting,
} from "@christopher/core";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { makeFetchContext } from "../context";
import { log } from "../log";

interface ScanPayload {
  companyId: string;
  scanRunId?: string;
  trigger?: "schedule" | "manual";
}

export interface SourceScanOutcome {
  sourceId: string;
  status: "ok" | "partial" | "suspect_empty" | "failed";
  postingsFound: number;
  newCount: number;
  closedCount: number;
  error?: string;
}

export async function handleScanCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as unknown as ScanPayload;
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, payload.companyId)).limit(1);
  if (!company) return { skipped: "company not found" };
  if (company.status !== "active") return { skipped: `company ${company.status}` };

  const sources = await deps.db
    .select()
    .from(schema.careerSources)
    .where(and(eq(schema.careerSources.companyId, company.id), inArray(schema.careerSources.status, ["active", "failing"])));

  if (sources.length === 0) {
    log.warn("company has no active source", { company: company.domain });
    return { skipped: "no active sources" };
  }

  const settings = await deps.settings();
  const outcomes: SourceScanOutcome[] = [];
  for (const source of sources) {
    outcomes.push(await scanSource(deps, company, source, settings, payload.scanRunId));
  }

  const anyOk = outcomes.some((o) => o.status === "ok" || o.status === "partial");
  const failures = outcomes.filter((o) => o.status === "failed");
  if (!anyOk && failures.length) {
    const worst = failures[0]!;
    // Trigger re-discovery when a source has failed repeatedly.
    for (const source of sources) {
      const [fresh] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id)).limit(1);
      if (fresh && fresh.consecutiveFailures >= 3 && fresh.status !== "blocked") {
        const p = { companyId: company.id, reason: "failing" as const };
        await enqueueTask(deps.db, "discover", p, { dedupeKey: dedupeKeyFor("discover", p), priority: priorityFor("discover") });
        log.warn("scheduling re-discovery after repeated failures", { company: company.domain, failures: fresh.consecutiveFailures });
        break;
      }
    }
    return { company: company.domain, outcomes, error: worst.error };
  }
  return { company: company.domain, outcomes };
}

export async function scanSource(
  deps: WorkerDeps,
  company: Company,
  source: CareerSource,
  settings: AppSettings,
  scanRunId?: string,
): Promise<SourceScanOutcome> {
  const startedAt = deps.now();
  const started = Date.now();
  const fetchCtx = makeFetchContext(deps);
  let postings: RawPosting[] = [];
  let fetchOk = true;
  let error: string | undefined;
  let fetchMethod: "api" | "http" | "browser" = source.type === "html" || source.type === "jsonld" || source.type === "rss" ? "http" : "api";
  let dropped = 0;
  let contentHash: string | null = source.contentHash;
  let recipe = (source.recipe as HtmlRecipe | null) ?? undefined;
  let recipeChanged = false;
  let blocked = false;

  try {
    if (source.type === "html" || source.type === "jsonld") {
      const res = await fetchHtmlSource(deps, source, fetchCtx, recipe);
      postings = res.postings;
      fetchMethod = res.fetchMethod;
      dropped = res.dropped;
      contentHash = res.contentHash;
      if (res.recipe) {
        recipe = res.recipe;
        recipeChanged = true;
      }
      if (res.unchanged) {
        // Page identical to last scan: keep previous jobs alive without re-parsing.
        return await recordUnchangedScan(deps, source, scanRunId, startedAt, started, res.previousCount ?? 0, fetchMethod);
      }
    } else {
      const adapter = ats.getAdapter(source.type);
      postings = await adapter.fetchPostings(
        { type: source.type, url: source.url, apiUrl: source.apiUrl ?? undefined, atsSlug: source.atsSlug ?? undefined, atsSite: source.atsSite ?? undefined },
        fetchCtx,
      );
    }
  } catch (err) {
    fetchOk = false;
    error = err instanceof Error ? err.message : String(err);
    blocked = err instanceof SourceFetchError && err.kind === "blocked";
  }

  const status = classifyScan({ fetchOk, postingsFound: postings.length, previousOkCount: source.lastPostingsCount ?? null, droppedByValidation: dropped });
  const mode = modeForScanStatus(status);

  const existing = await loadExistingJobs(deps, source.id);
  const result = reconcile(existing, postings, { mode, closeAfterMissing: settings.closeAfterMissingScans, now: deps.now() });
  const isFirstScan = existing.length === 0 && (source.lastOkScanAt === null || source.lastOkScanAt === undefined);

  let newCount = 0;
  let closedCount = 0;
  if (mode !== "none") {
    const applied = await applyReconcile(deps, company, source, result, settings, isFirstScan, postings);
    newCount = applied.newCount;
    closedCount = applied.closedCount;
  }

  const [scan] = await deps.db
    .insert(schema.scans)
    .values({
      scanRunId: scanRunId ?? null,
      sourceId: source.id,
      startedAt,
      finishedAt: deps.now(),
      status,
      fetchMethod,
      postingsFound: postings.length,
      newCount,
      closedCount,
      error: error?.slice(0, 2000) ?? null,
      durationMs: Date.now() - started,
      rawSnapshot: null,
    })
    .returning({ id: schema.scans.id });

  const sourcePatch: Partial<typeof schema.careerSources.$inferInsert> = {};
  if (status === "ok" || status === "partial") {
    sourcePatch.lastOkScanAt = deps.now();
    sourcePatch.lastPostingsCount = postings.length;
    sourcePatch.consecutiveFailures = 0;
    sourcePatch.status = "active";
    if (contentHash) sourcePatch.contentHash = contentHash;
    if (recipeChanged && recipe) sourcePatch.recipe = recipe as unknown as object;
  } else {
    sourcePatch.consecutiveFailures = source.consecutiveFailures + 1;
    sourcePatch.status = blocked ? "blocked" : source.consecutiveFailures + 1 >= 3 ? "failing" : source.status;
  }
  await deps.db.update(schema.careerSources).set(sourcePatch).where(eq(schema.careerSources.id, source.id));

  log.info("scan finished", { company: company.domain, source: source.type, status, postings: postings.length, newCount, closedCount, scanId: scan?.id });
  return { sourceId: source.id, status, postingsFound: postings.length, newCount, closedCount, error };
}

async function recordUnchangedScan(
  deps: WorkerDeps,
  source: CareerSource,
  scanRunId: string | undefined,
  startedAt: Date,
  started: number,
  count: number,
  fetchMethod: "api" | "http" | "browser",
): Promise<SourceScanOutcome> {
  await deps.db.insert(schema.scans).values({
    scanRunId: scanRunId ?? null,
    sourceId: source.id,
    startedAt,
    finishedAt: deps.now(),
    status: "ok",
    fetchMethod,
    postingsFound: count,
    newCount: 0,
    closedCount: 0,
    durationMs: Date.now() - started,
    error: null,
  });
  await deps.db
    .update(schema.careerSources)
    .set({ lastOkScanAt: deps.now(), consecutiveFailures: 0, status: "active" })
    .where(eq(schema.careerSources.id, source.id));
  await deps.db
    .update(schema.jobs)
    .set({ lastSeenAt: deps.now(), missingScans: 0 })
    .where(and(eq(schema.jobs.sourceId, source.id), eq(schema.jobs.status, "open")));
  log.info("scan skipped: content unchanged", { sourceId: source.id, count });
  return { sourceId: source.id, status: "ok", postingsFound: count, newCount: 0, closedCount: 0 };
}

interface HtmlScanResult {
  postings: RawPosting[];
  fetchMethod: "http" | "browser";
  dropped: number;
  contentHash: string | null;
  recipe?: HtmlRecipe;
  unchanged?: boolean;
  previousCount?: number;
}

/** Tier-3 HTML: recipe → embedded structure → model extraction, with a content-hash short circuit. */
async function fetchHtmlSource(
  deps: WorkerDeps,
  source: CareerSource,
  fetchCtx: ReturnType<typeof makeFetchContext>,
  recipe: HtmlRecipe | undefined,
): Promise<HtmlScanResult> {
  const res = await fetchCtx.fetchText(source.url);
  if (res.status >= 400) throw new SourceFetchError(`HTTP ${res.status} from ${source.url}`, res.status === 403 || res.status === 429 ? "blocked" : "http", res.status);
  let html = res.body;
  let fetchMethod: "http" | "browser" = "http";

  let postings = ats.extractPostingsFromHtml(html, source.url, recipe);
  const looksEmpty = postings.length === 0;
  if (looksEmpty && fetchCtx.render) {
    try {
      const rendered = await fetchCtx.render(source.url, { scrollAndExpand: true });
      html = rendered.html;
      fetchMethod = "browser";
      postings = ats.extractPostingsFromHtml(html, source.url, recipe);
    } catch (err) {
      log.warn("render failed during scan", { url: source.url, error: (err as Error).message });
    }
  }

  const hash = sha1(html.replace(/\s+/g, " ").slice(0, 500_000));
  if (source.contentHash && source.contentHash === hash && postings.length > 0) {
    return { postings, fetchMethod, dropped: 0, contentHash: hash, unchanged: true, previousCount: postings.length };
  }

  let dropped = 0;
  let newRecipe: HtmlRecipe | undefined;
  if (postings.length === 0 && deps.ai.enabled) {
    const compact = ats.compactDomForModel(html, source.url);
    const extracted = await deps.ai.extractPostings({ pageUrl: source.url, compactDom: compact.text, knownUrls: compact.knownUrls }, { refType: "source", refId: source.id });
    if (extracted) {
      postings = extracted.postings.map((p) => ({ title: p.title, url: p.url, location: p.location, department: p.department }));
      dropped = extracted.dropped;
      if (extracted.recipe) {
        const validation = ats.validateRecipe(html, source.url, extracted.recipe, postings);
        if (validation.ok) newRecipe = extracted.recipe;
        else log.info("model recipe rejected", { url: source.url, coverage: validation.coverage });
      }
    }
  }
  return { postings, fetchMethod, dropped, contentHash: hash, recipe: newRecipe };
}

async function loadExistingJobs(deps: WorkerDeps, sourceId: string): Promise<ExistingJob[]> {
  const rows = await deps.db
    .select({
      id: schema.jobs.id,
      externalKey: schema.jobs.externalKey,
      status: schema.jobs.status,
      missingScans: schema.jobs.missingScans,
      title: schema.jobs.title,
      location: schema.jobs.location,
      normalizedTitle: schema.jobs.normalizedTitle,
      closedAt: schema.jobs.closedAt,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.sourceId, sourceId));
  return rows;
}

async function applyReconcile(
  deps: WorkerDeps,
  company: Company,
  source: CareerSource,
  result: ReturnType<typeof reconcile>,
  settings: AppSettings,
  isFirstScan: boolean,
  postings: RawPosting[],
): Promise<{ newCount: number; closedCount: number }> {
  const now = deps.now();
  const byKey = new Map(postings.map((p) => [deriveExternalKey(p), p]));
  const descriptionMatchAllowed = settings.gate.matchFields.includes("description");

  const insertedIds: string[] = [];
  for (const insert of result.inserts) {
    const gate = evaluateGate(
      {
        title: insert.title,
        department: insert.department,
        description: descriptionMatchAllowed ? insert.descriptionText ?? null : null,
        location: insert.location,
        locations: insert.locations,
        remote: insert.remote,
      },
      settings.gate,
    );
    const [row] = await deps.db
      .insert(schema.jobs)
      .values({
        companyId: company.id,
        sourceId: source.id,
        externalKey: insert.externalKey,
        title: insert.title,
        normalizedTitle: normalizeTitle(insert.title),
        url: insert.url,
        location: insert.location ?? null,
        locations: insert.locations ?? (insert.location ? [insert.location] : []),
        department: insert.department ?? null,
        employmentType: insert.employmentType ?? null,
        remote: insert.remote ?? gate.remote,
        salaryText: insert.salaryText ?? null,
        postedAt: insert.postedAt ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        status: "open",
        seeded: isFirstScan,
        repostOfJobId: insert.repostOfJobId ?? null,
        descriptionText: insert.descriptionText?.slice(0, 30_000) ?? null,
        descriptionHash: insert.descriptionText ? sha1(insert.descriptionText) : null,
        descriptionFetchedAt: insert.descriptionText ? now : null,
        keywordMatched: gate.keywordMatched,
        keywordTerms: gate.keywordTerms,
        excluded: gate.excluded,
        locationOk: gate.locationOk,
        inTable: gate.inTable,
        nearMiss: !gate.inTable && settings.nearMissEnabled && !gate.excluded,
      })
      .onConflictDoNothing()
      .returning({ id: schema.jobs.id });
    if (row) {
      insertedIds.push(row.id);
      await deps.db.insert(schema.jobEvents).values({ jobId: row.id, type: "discovered", payload: { seeded: isFirstScan, inTable: gate.inTable } });
    }
  }

  if (result.seen.length) {
    await deps.db.update(schema.jobs).set({ lastSeenAt: now, missingScans: 0 }).where(inArray(schema.jobs.id, result.seen));
  }
  if (result.reopened.length) {
    await deps.db
      .update(schema.jobs)
      .set({ status: "open", closedAt: null, reopenedCount: sql`${schema.jobs.reopenedCount} + 1`, missingScans: 0 })
      .where(inArray(schema.jobs.id, result.reopened));
    for (const id of result.reopened) await deps.db.insert(schema.jobEvents).values({ jobId: id, type: "reopened", payload: {} });
  }
  for (const update of result.updates) {
    const posting = [...byKey.values()].find((p) => p.title === update.changes.title || p.location === update.changes.location);
    await deps.db
      .update(schema.jobs)
      .set({
        ...(update.changes.title ? { title: update.changes.title, normalizedTitle: normalizeTitle(update.changes.title) } : {}),
        ...(update.changes.location !== undefined ? { location: update.changes.location ?? null } : {}),
        ...(posting?.locations ? { locations: posting.locations } : {}),
        updatedAt: now,
      })
      .where(eq(schema.jobs.id, update.id));
    await deps.db.insert(schema.jobEvents).values({ jobId: update.id, type: "updated", payload: { fields: update.changedFields } });
  }
  if (result.missing.length) {
    await deps.db
      .update(schema.jobs)
      .set({ missingScans: sql`${schema.jobs.missingScans} + 1` })
      .where(inArray(schema.jobs.id, result.missing));
  }
  if (result.closed.length) {
    await deps.db
      .update(schema.jobs)
      .set({ status: "closed", closedAt: now, missingScans: sql`${schema.jobs.missingScans} + 1` })
      .where(inArray(schema.jobs.id, result.closed));
    for (const id of result.closed) await deps.db.insert(schema.jobEvents).values({ jobId: id, type: "closed", payload: {} });
  }

  // Follow-up work for newly inserted roles: description fetch then scoring.
  for (const id of insertedIds) {
    const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    if (!job) continue;
    if (job.inTable || job.nearMiss) {
      if (!job.descriptionText && job.inTable) {
        const p = { jobId: id };
        await enqueueTask(deps.db, "fetch_description", p, { dedupeKey: dedupeKeyFor("fetch_description", p), priority: priorityFor("fetch_description") });
      }
      const p = { jobId: id, nearMiss: job.nearMiss && !job.inTable };
      await enqueueTask(deps.db, "score_job", p, { dedupeKey: dedupeKeyFor("score_job", p), priority: priorityFor("score_job") });
    }
  }

  return { newCount: insertedIds.length, closedCount: result.closed.length };
}

export async function jobsNeedingDescription(deps: WorkerDeps, limit = 50) {
  const cutoff = new Date(deps.now().getTime() - 14 * 86_400_000);
  return deps.db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.inTable, true), eq(schema.jobs.status, "open"), isNotNull(schema.jobs.url), sql`(${schema.jobs.descriptionFetchedAt} is null or ${schema.jobs.descriptionFetchedAt} < ${cutoff})`))
    .orderBy(desc(schema.jobs.firstSeenAt))
    .limit(limit);
}
