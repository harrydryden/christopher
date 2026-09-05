/**
 * The daily scan. For each company: fetch every active source, normalise postings, reconcile them
 * against what is stored, apply the keyword and location gate, and queue scoring for anything new.
 */
import { schema, enqueueTask, type Db, type Task } from "@christopher/db";
import {
  ats,
  classifyScan,
  dedupeKeyFor,
  evaluateGate,
  keyPostings,
  modeForScanStatus,
  normalizeTitle,
  priorityFor,
  reconcile,
  sha1,
  SourceFetchError,
  type AppSettings,
  type ExistingJob,
  type FetchContext,
  type HtmlRecipe,
  type RawPosting,
  type SourceSpec,
} from "@christopher/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { CareerSource } from "@christopher/db";
import { aiBudgetExceeded, makeFetchContext, type WorkerDeps } from "../context";
import { log } from "../log";

type ScanStatus = "ok" | "partial" | "suspect_empty" | "failed";

export async function handleScanCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as { companyId: string; scanRunId?: string };
  const settings = await deps.settings();
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, payload.companyId)).limit(1);
  if (!company) return { skipped: "company not found" };

  const sources = await deps.db
    .select()
    .from(schema.careerSources)
    .where(and(eq(schema.careerSources.companyId, company.id), inArray(schema.careerSources.status, ["active", "failing"])));

  if (sources.length === 0) {
    log.warn("company has no active source", { company: company.name });
    return { skipped: "no active source" };
  }

  let totalNew = 0;
  let totalClosed = 0;
  const statuses: ScanStatus[] = [];
  for (const source of sources) {
    const outcome = await scanSource(deps, company, source, settings, payload.scanRunId ?? null);
    statuses.push(outcome.status);
    totalNew += outcome.newCount;
    totalClosed += outcome.closedCount;
  }

  if (payload.scanRunId) {
    const ok = statuses.some((s) => s === "ok" || s === "partial");
    await deps.db
      .update(schema.scanRuns)
      .set({
        companiesOk: sql`${schema.scanRuns.companiesOk} + ${ok ? 1 : 0}`,
        companiesFailed: sql`${schema.scanRuns.companiesFailed} + ${ok ? 0 : 1}`,
        newRoles: sql`${schema.scanRuns.newRoles} + ${totalNew}`,
        closedRoles: sql`${schema.scanRuns.closedRoles} + ${totalClosed}`,
        finishedAt: deps.now(),
      })
      .where(eq(schema.scanRuns.id, payload.scanRunId));
  }
  return { sources: sources.length, new: totalNew, closed: totalClosed, statuses };
}

interface SourceOutcome {
  status: ScanStatus;
  newCount: number;
  closedCount: number;
  postingsFound: number;
}

async function scanSource(
  deps: WorkerDeps,
  company: typeof schema.companies.$inferSelect,
  source: CareerSource,
  settings: AppSettings,
  scanRunId: string | null,
): Promise<SourceOutcome> {
  const started = Date.now();
  const ctx = makeFetchContext(deps);
  const spec: SourceSpec = {
    type: source.type,
    url: source.url,
    apiUrl: source.apiUrl ?? undefined,
    atsSlug: source.atsSlug ?? undefined,
    atsSite: source.atsSite ?? undefined,
    recipe: (source.recipe as HtmlRecipe | null) ?? undefined,
  };

  let postings: RawPosting[] = [];
  let fetchOk = true;
  let error: string | null = null;
  let fetchMethod: "api" | "http" | "browser" = source.type === "html" || source.type === "jsonld" ? "http" : "api";
  let droppedByValidation = 0;
  let blocked = false;
  let contentHash: string | null = source.contentHash;

  try {
    if (source.type === "html") {
      const outcome = await scanHtmlSource(deps, spec, source, ctx);
      postings = outcome.postings;
      fetchMethod = outcome.method;
      droppedByValidation = outcome.dropped;
      contentHash = outcome.contentHash;
      if (outcome.unchanged) {
        log.debug("source unchanged since last scan", { company: company.name, url: source.url });
      }
      if (outcome.recipe) {
        await deps.db.update(schema.careerSources).set({ recipe: outcome.recipe }).where(eq(schema.careerSources.id, source.id));
      }
    } else {
      postings = await ats.getAdapter(source.type).fetchPostings(spec, ctx);
    }
  } catch (err) {
    fetchOk = false;
    error = (err as Error).message.slice(0, 1000);
    blocked = err instanceof SourceFetchError && err.kind === "blocked";
  }

  const previousOk = await deps.db
    .select({ postingsFound: schema.scans.postingsFound })
    .from(schema.scans)
    .where(and(eq(schema.scans.sourceId, source.id), eq(schema.scans.status, "ok")))
    .orderBy(desc(schema.scans.startedAt))
    .limit(1);
  const previousOkCount = previousOk[0]?.postingsFound ?? null;

  const status = classifyScan({ fetchOk, postingsFound: postings.length, previousOkCount, droppedByValidation });
  const mode = modeForScanStatus(status);

  const existingRows = await deps.db
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
    .where(eq(schema.jobs.sourceId, source.id));
  const existing: ExistingJob[] = existingRows.map((r) => ({ ...r, status: r.status, closedAt: r.closedAt }));

  const result = reconcile(existing, postings, { mode, now: deps.now(), closeAfterMissing: settings.closeAfterMissingScans });
  const isFirstScan = existing.length === 0 && previousOkCount === null;

  let newCount = 0;
  const scoreQueue: Array<{ jobId: string; nearMiss: boolean }> = [];
  const descriptionQueue: string[] = [];

  for (const insert of result.inserts) {
    const gate = evaluateGate(
      {
        title: insert.title,
        department: insert.department,
        description: settings.gate.matchFields.includes("description") ? insert.descriptionText : undefined,
        location: insert.location,
        locations: insert.locations,
        remote: insert.remote,
      },
      settings.gate,
    );
    // A near miss is a role that failed the keyword gate but is still plausibly relevant. It is
    // recorded cheaply here; only a capped number are scored each day (see below).
    const nearMiss = !gate.inTable && settings.nearMissEnabled && !gate.excluded && gate.locationOk;
    const [created] = await deps.db
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
        firstSeenAt: deps.now(),
        lastSeenAt: deps.now(),
        seeded: isFirstScan,
        repostOfJobId: insert.repostOfJobId ?? null,
        descriptionText: insert.descriptionText?.slice(0, 30_000) ?? null,
        descriptionHash: insert.descriptionText ? sha1(insert.descriptionText) : null,
        descriptionFetchedAt: insert.descriptionText ? deps.now() : null,
        keywordMatched: gate.keywordMatched,
        keywordTerms: gate.keywordTerms,
        excluded: gate.excluded,
        locationOk: gate.locationOk,
        inTable: gate.inTable,
        nearMiss,
      })
      .onConflictDoNothing()
      .returning({ id: schema.jobs.id });
    if (!created) continue;
    newCount++;
    await deps.db.insert(schema.jobEvents).values({ jobId: created.id, type: "discovered", payload: { method: fetchMethod, seeded: isFirstScan } });
    if (gate.inTable || nearMiss) scoreQueue.push({ jobId: created.id, nearMiss });
    if (gate.inTable && !insert.descriptionText) descriptionQueue.push(created.id);
  }

  if (result.seen.length > 0) {
    await deps.db.update(schema.jobs).set({ lastSeenAt: deps.now(), missingScans: 0 }).where(inArray(schema.jobs.id, result.seen));
  }
  for (const update of result.updates) {
    await deps.db
      .update(schema.jobs)
      .set({
        ...(update.changes.title ? { title: update.changes.title, normalizedTitle: normalizeTitle(update.changes.title) } : {}),
        ...(update.changes.location !== undefined ? { location: update.changes.location ?? null } : {}),
        updatedAt: deps.now(),
      })
      .where(eq(schema.jobs.id, update.id));
    await deps.db.insert(schema.jobEvents).values({ jobId: update.id, type: "updated", payload: { fields: update.changedFields } });
  }
  if (result.reopened.length > 0) {
    await deps.db
      .update(schema.jobs)
      .set({ status: "open", closedAt: null, missingScans: 0, reopenedCount: sql`${schema.jobs.reopenedCount} + 1` })
      .where(inArray(schema.jobs.id, result.reopened));
    for (const id of result.reopened) await deps.db.insert(schema.jobEvents).values({ jobId: id, type: "reopened", payload: {} });
  }
  if (result.missing.length > 0) {
    await deps.db
      .update(schema.jobs)
      .set({ missingScans: sql`${schema.jobs.missingScans} + 1` })
      .where(inArray(schema.jobs.id, result.missing));
  }
  if (result.closed.length > 0) {
    await deps.db
      .update(schema.jobs)
      .set({ status: "closed", closedAt: sql`coalesce(${schema.jobs.lastSeenAt}, now())`, missingScans: sql`${schema.jobs.missingScans} + 1` })
      .where(inArray(schema.jobs.id, result.closed));
    for (const id of result.closed) await deps.db.insert(schema.jobEvents).values({ jobId: id, type: "closed", payload: {} });
  }

  await deps.db.insert(schema.scans).values({
    scanRunId,
    sourceId: source.id,
    startedAt: new Date(started),
    finishedAt: deps.now(),
    status,
    fetchMethod,
    postingsFound: postings.length,
    newCount,
    closedCount: result.closed.length,
    error,
    durationMs: Date.now() - started,
    rawSnapshot: null,
  });

  const failures = status === "failed" ? source.consecutiveFailures + 1 : 0;
  await deps.db
    .update(schema.careerSources)
    .set({
      consecutiveFailures: failures,
      status: blocked ? "blocked" : failures >= 3 ? "failing" : source.status === "failing" && status === "ok" ? "active" : source.status,
      lastOkScanAt: status === "ok" ? deps.now() : source.lastOkScanAt,
      lastPostingsCount: status === "ok" ? postings.length : source.lastPostingsCount,
      contentHash,
    })
    .where(eq(schema.careerSources.id, source.id));

  // A source that keeps failing, or that suddenly went empty, is worth re-discovering.
  if (failures >= 3 || status === "suspect_empty") {
    await enqueueTask(deps.db, "discover", { companyId: company.id, reason: status === "suspect_empty" ? "suspect_empty" : "failing" }, {
      dedupeKey: dedupeKeyFor("discover", { companyId: company.id }),
      priority: priorityFor("discover"),
    });
  }

  if (!(await aiBudgetExceeded(deps))) {
    // Roles in the table are always scored. Near misses are scored only up to the daily cap, so a
    // wide keyword change cannot turn into hundreds of model calls.
    const inTableToScore = scoreQueue.filter((item) => !item.nearMiss);
    let nearMissBudget = 0;
    const nearMissCandidates = scoreQueue.filter((item) => item.nearMiss);
    if (nearMissCandidates.length > 0) {
      const scoredToday = await deps.db.execute<{ n: number }>(sql`
        select count(*)::int as n from jobs
        where near_miss and fit_scored_at >= date_trunc('day', now())`);
      nearMissBudget = Math.max(0, settings.nearMissDailyCap - (scoredToday.rows[0]?.n ?? 0));
    }
    for (const item of [...inTableToScore, ...nearMissCandidates.slice(0, nearMissBudget)]) {
      await enqueueTask(deps.db, "score_job", item, { dedupeKey: dedupeKeyFor("score_job", item), priority: priorityFor("score_job") });
    }
    for (const jobId of descriptionQueue.slice(0, 50)) {
      await enqueueTask(deps.db, "fetch_description", { jobId }, { dedupeKey: dedupeKeyFor("fetch_description", { jobId }), priority: priorityFor("fetch_description") });
    }
  }

  log.info("source scanned", {
    company: company.name,
    type: source.type,
    status,
    postings: postings.length,
    new: newCount,
    closed: result.closed.length,
    ms: Date.now() - started,
  });
  return { status, newCount, closedCount: result.closed.length, postingsFound: postings.length };
}

interface HtmlScanOutcome {
  postings: RawPosting[];
  method: "http" | "browser";
  dropped: number;
  contentHash: string;
  unchanged: boolean;
  recipe?: HtmlRecipe;
}

/**
 * Tier-3 HTML: try the stored selector recipe first, then embedded structure, then the model.
 * A model extraction also produces a recipe, so later scans of an unchanged page cost nothing.
 */
async function scanHtmlSource(deps: WorkerDeps, spec: SourceSpec, source: CareerSource, ctx: FetchContext): Promise<HtmlScanOutcome> {
  let html: string;
  let finalUrl = spec.url;
  let method: "http" | "browser" = "http";

  const page = await ats.fetchHtmlPage(spec, ctx);
  html = page.html;
  finalUrl = page.url;

  let postings = ats.extractPostingsFromHtml(html, finalUrl, spec.recipe);
  if (postings.length === 0 && deps.browser) {
    const rendered = await deps.browser.render(spec.url, { scrollAndExpand: true });
    html = rendered.html;
    finalUrl = rendered.finalUrl;
    method = "browser";
    postings = ats.extractPostingsFromHtml(html, finalUrl, spec.recipe);
  }

  const contentHash = sha1(html.replace(/\s+/g, " "));
  const unchanged = contentHash === source.contentHash;

  if (postings.length > 0 || unchanged || !deps.ai.enabled || (await aiBudgetExceeded(deps))) {
    return { postings, method, dropped: 0, contentHash, unchanged };
  }

  // Nothing came out of the heuristics and the page has changed: ask the model, and keep its recipe.
  const compact = ats.compactDomForModel(html, finalUrl);
  const extraction = await deps.ai.extractPostings({ pageUrl: finalUrl, compactDom: compact.text, knownUrls: compact.knownUrls }, { refType: "source", refId: source.id });
  if (!extraction) return { postings, method, dropped: 0, contentHash, unchanged };

  const modelPostings: RawPosting[] = extraction.postings.map((p) => ({
    title: p.title,
    url: p.url,
    location: p.location,
    department: p.department,
    remote: p.location ? /remote/i.test(p.location) || undefined : undefined,
  }));

  let recipe: HtmlRecipe | undefined;
  if (extraction.recipe) {
    const validation = ats.validateRecipe(html, finalUrl, extraction.recipe, modelPostings);
    if (validation.ok) recipe = extraction.recipe;
    else log.info("model recipe rejected", { url: finalUrl, coverage: validation.coverage });
  }
  return { postings: modelPostings, method, dropped: extraction.dropped, contentHash, unchanged, recipe };
}

export { scanSource as _scanSourceForTests };
