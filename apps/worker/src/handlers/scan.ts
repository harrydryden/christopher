/**
 * The daily scan. For each company: fetch every active source, normalise postings, reconcile them
 * against what is stored, apply the keyword and location gate, and queue scoring for anything new.
 */
import { schema, enqueueTask, pruneNonMatches, type Db, type Task } from "@christopher/db";
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
import { gzipSync, gunzipSync } from "node:zlib";
import { log } from "../log";

type ScanStatus = "ok" | "partial" | "suspect_empty" | "failed";

export async function handleScanCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as { companyId: string; scanRunId?: string };
  // One company must never reconcile overlapping snapshots concurrently.
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`christopher:scan:${payload.companyId}`}))`);
    return scanCompany(task, { ...deps, db: tx as unknown as WorkerDeps["db"] });
  });
}

async function scanCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as { companyId: string; scanRunId?: string };
  const settings = await deps.settings();
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, payload.companyId)).limit(1);
  if (!company) return { skipped: "company not found" };
  if (company.status !== "active") return { skipped: "company is not active" };

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
  const baseCtx = makeFetchContext(deps);
  const responses: Array<{ url: string; status: number; body: string }> = [];
  let snapshotChars = 0;
  const ctx: FetchContext = { ...baseCtx, fetchText: async (url, init) => {
    const response = await baseCtx.fetchText(url, init);
    const body = response.body.slice(0, Math.max(0, 2_000_000 - snapshotChars));
    snapshotChars += body.length;
    if (body) responses.push({ url: response.url, status: response.status, body });
    return response;
  } };
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
  let htmlPages: CachedHtmlPage[] = [];
  let incomplete = false;

  try {
    if (source.type === "html") {
      const outcome = await scanHtmlSource(deps, spec, source, ctx);
      postings = outcome.postings;
      fetchMethod = outcome.method;
      droppedByValidation = outcome.dropped;
      contentHash = outcome.contentHash;
      htmlPages = outcome.pages ?? [];
      incomplete = outcome.incomplete ?? false;
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

  if (postings.length > 10_000) { postings = postings.slice(0, 10_000); incomplete = true; }
  const classified = classifyScan({ fetchOk, postingsFound: postings.length, previousOkCount, droppedByValidation });
  const status = incomplete && classified === "ok" ? "partial" : classified;
  const mode = modeForScanStatus(status);

  const existingRows = await deps.db
    .select({
      descriptionText: schema.jobs.descriptionText,
      descriptionFetchedAt: schema.jobs.descriptionFetchedAt,
      url: schema.jobs.url,
      locations: schema.jobs.locations,
      department: schema.jobs.department,
      employmentType: schema.jobs.employmentType,
      remote: schema.jobs.remote,
      salaryText: schema.jobs.salaryText,
      postedAt: schema.jobs.postedAt,
      fitScore: schema.jobs.fitScore,
      inTable: schema.jobs.inTable,
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
    if (!gate.inTable) continue;
    const nearMiss = false;
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
    if ((gate.inTable || nearMiss) && !insert.descriptionText) descriptionQueue.push(created.id);
  }

  if (result.seen.length > 0) {
    await deps.db.update(schema.jobs).set({ lastSeenAt: deps.now(), ...(mode === "ok" ? { missingScans: 0 } : {}) }).where(inArray(schema.jobs.id, result.seen));
  }
  // Refresh every observed posting, including fields the identity reconciliation does not compare.
  const observed = new Map(keyPostings(postings).keyed.map((p) => [p.externalKey, p]));
  for (const job of existingRows.filter((j) => result.seen.includes(j.id))) {
    const posting = observed.get(job.externalKey)!;
    const fields = {
      title: posting.title, url: posting.url,
      location: posting.location ?? job.location,
      locations: posting.locations ?? (posting.location ? [posting.location] : job.locations),
      department: posting.department ?? job.department,
      employmentType: posting.employmentType ?? job.employmentType,
      remote: posting.remote ?? job.remote,
      salaryText: posting.salaryText ?? job.salaryText,
      postedAt: posting.postedAt ?? job.postedAt,
      descriptionText: posting.descriptionText?.slice(0, 30_000) ?? job.descriptionText,
    };
    const changedFields = Object.keys(fields).filter((key) =>
      JSON.stringify(fields[key as keyof typeof fields]) !== JSON.stringify(job[key as keyof typeof job]));
    const gate = evaluateGate({ ...fields, description: fields.descriptionText }, settings.gate);
    const nearMiss = false;
    await deps.db.update(schema.jobs).set({
      ...fields, normalizedTitle: normalizeTitle(fields.title),
      keywordMatched: gate.keywordMatched, keywordTerms: gate.keywordTerms,
      excluded: gate.excluded, locationOk: gate.locationOk, inTable: gate.inTable, nearMiss,
      ...(posting.descriptionText !== undefined ? {
        descriptionHash: sha1(fields.descriptionText ?? ""), descriptionFetchedAt: deps.now(),
      } : {}),
      updatedAt: deps.now(),
    }).where(eq(schema.jobs.id, job.id));
    if (changedFields.length) await deps.db.insert(schema.jobEvents).values({ jobId: job.id, type: "updated", payload: { fields: changedFields } });
    if ((gate.inTable || nearMiss) && (changedFields.length || !job.inTable && gate.inTable || job.fitScore === null)) scoreQueue.push({ jobId: job.id, nearMiss });
    const descriptionStale = !job.descriptionFetchedAt || deps.now().getTime() - job.descriptionFetchedAt.getTime() >= 14 * 86_400_000;
    const sourceUpdated = posting.updatedAt && (!job.descriptionFetchedAt || posting.updatedAt > job.descriptionFetchedAt);
    if ((gate.inTable || nearMiss) && posting.descriptionText === undefined && (descriptionStale || sourceUpdated)) descriptionQueue.push(job.id);
  }
  if (result.reopened.length > 0) {
    await deps.db
      .update(schema.jobs)
      .set({ status: "open", closedAt: null, ...(mode === "ok" ? { missingScans: 0 } : {}), reopenedCount: sql`${schema.jobs.reopenedCount} + 1` })
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
    rawSnapshot: gzipSync(JSON.stringify({ version: 1, responses, htmlPages })).toString("base64"),
  });

  // Keep bounded debugging evidence from the three most recent source scans.
  await deps.db.execute(sql`update scans set raw_snapshot = null where source_id = ${source.id}
    and id not in (select id from scans where source_id = ${source.id} order by started_at desc, id desc limit 3)`);

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
  }
  // Snapshot fetching is useful even when no model is configured or the AI budget is exhausted.
  for (const jobId of descriptionQueue) {
    await enqueueTask(deps.db, "fetch_description", { jobId }, { dedupeKey: dedupeKeyFor("fetch_description", { jobId }), priority: priorityFor("fetch_description") });
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
  await pruneNonMatches(deps.db, source.id);
  return { status, newCount, closedCount: result.closed.length, postingsFound: postings.length };
}

interface CachedHtmlPage {
  url: string;
  contentHash: string;
  postings: RawPosting[];
}

interface HtmlScanOutcome {
  postings: RawPosting[];
  method: "http" | "browser";
  dropped: number;
  contentHash: string;
  unchanged: boolean;
  recipe?: HtmlRecipe;
  html?: string;
  finalUrl?: string;
  pages?: CachedHtmlPage[];
  incomplete?: boolean;
  traversed?: boolean;
}

/**
 * Tier-3 HTML: try the stored selector recipe first, then embedded structure, then the model.
 * A model extraction also produces a recipe, so later scans of an unchanged page cost nothing.
 */
async function scanHtmlSource(deps: WorkerDeps, spec: SourceSpec, source: CareerSource, ctx: FetchContext): Promise<HtmlScanOutcome> {
  const [last] = await deps.db.select({ rawSnapshot: schema.scans.rawSnapshot }).from(schema.scans)
    .where(and(eq(schema.scans.sourceId, source.id), eq(schema.scans.status, "ok"))).orderBy(desc(schema.scans.startedAt)).limit(1);
  let cached: CachedHtmlPage[] = [];
  try {
    if (last?.rawSnapshot) {
      const snapshot = JSON.parse(gunzipSync(Buffer.from(last.rawSnapshot, "base64"), { maxOutputLength: 8_000_000 }).toString());
      if (snapshot.version === 1 && Array.isArray(snapshot.htmlPages)) cached = snapshot.htmlPages.map((page: CachedHtmlPage) => ({ ...page, postings: page.postings.map(posting => ({ ...posting,
        postedAt: posting.postedAt ? new Date(posting.postedAt) : undefined,
        updatedAt: posting.updatedAt ? new Date(posting.updatedAt) : undefined,
      })) }));
    }
  } catch { /* Missing or older snapshots trigger fresh extraction. */ }
  const pages: CachedHtmlPage[] = [];
  const visited = new Set<string>();
  let url: string | null = spec.url;
  let method: "http" | "browser" = "http";
  let dropped = 0;
  let recipe: HtmlRecipe | undefined;
  let unchanged = true;
  let incomplete = false;
  while (url && pages.length < 20) {
    if (visited.has(url)) { incomplete = true; break; }
    visited.add(url);
    try {
      const page = await scanHtmlPage(deps, { ...spec, url }, source, ctx, cached.find(p => p.url === url));
      if (page.method === "browser") method = "browser";
      dropped += page.dropped;
      unchanged = unchanged && page.unchanged;
      recipe ??= page.recipe;
      pages.push({ url, contentHash: page.contentHash, postings: page.postings });
      incomplete ||= page.incomplete ?? false;
      url = page.traversed ? null : ats.nextListingPage(page.html ?? "", page.finalUrl ?? url);
      if (pages.reduce((n, p) => n + p.postings.length, 0) >= 500 && url) { incomplete = true; break; }
    } catch (error) {
      if (pages.length === 0) throw error;
      incomplete = true;
      log.warn("HTML pagination incomplete", { url, error: (error as Error).message });
      break;
    }
  }
  if (url) incomplete = true;
  const postings = keyPostings(pages.flatMap(page => page.postings)).keyed;
  return { postings, method, dropped, contentHash: sha1(pages.map(p => p.contentHash).join("|")), unchanged, recipe, pages, incomplete };
}

async function scanHtmlPage(deps: WorkerDeps, spec: SourceSpec, source: CareerSource, ctx: FetchContext, cached?: CachedHtmlPage, supplied?: { html: string; url: string }): Promise<HtmlScanOutcome> {
  let html: string;
  let finalUrl = spec.url;
  let method: "http" | "browser" = "http";

  const page = supplied ?? await ats.fetchHtmlPage(spec, ctx);
  html = page.html;
  finalUrl = page.url;

  let postings = ats.extractPostingsFromHtml(html, finalUrl, spec.recipe);
  if (!supplied && deps.browser && (postings.length === 0 || /<(?:button|a)[^>]*>\s*(?:next|load more|show more)/i.test(html))) {
    const rendered = await deps.browser.render(spec.url, { scrollAndExpand: true });
    if (rendered.status !== null && rendered.status >= 400) {
      throw new SourceFetchError(`Browser returned HTTP ${rendered.status}`, rendered.status === 403 || rendered.status === 429 ? "blocked" : "http", rendered.status);
    }
    const captures = rendered.listingPages?.length ? rendered.listingPages : [{ html: rendered.html, url: rendered.finalUrl }];
    const outcomes: HtmlScanOutcome[] = [];
    let incomplete = rendered.incomplete ?? false;
    for (const capture of captures) {
      try { outcomes.push(await scanHtmlPage(deps, spec, source, ctx, captures.length === 1 ? cached : undefined, capture)); }
      catch (error) { if (!outcomes.length) throw error; incomplete = true; }
    }
    return { postings: keyPostings(outcomes.flatMap(p => p.postings)).keyed, method: "browser", dropped: outcomes.reduce((n, p) => n + p.dropped, 0),
      contentHash: sha1(captures.map(p => p.html).join("|")), unchanged: false, incomplete, traversed: true };

  }

  const contentHash = sha1(html.replace(/\s+/g, " "));
  const unchanged = contentHash === cached?.contentHash;

  if (postings.length === 0 && unchanged && cached?.postings.length) postings = cached.postings;
  if (postings.length > 0) return { postings, method, dropped: 0, contentHash, unchanged, html, finalUrl };
  if (unchanged || !deps.ai.enabled || (await aiBudgetExceeded(deps))) {
    throw new SourceFetchError("HTML extraction found no verifiable postings; cannot establish a successful empty scan", "parse");
  }

  // Nothing came out of the heuristics and the page has changed: ask the model, and keep its recipe.
  const compact = ats.compactDomForModel(html, finalUrl);
  const extraction = await deps.ai.extractPostings({ pageUrl: finalUrl, compactDom: compact.text, knownUrls: compact.knownUrls }, { refType: "source", refId: source.id });
  if (!extraction || extraction.postings.length === 0) throw new SourceFetchError("HTML extraction produced no verifiable postings", "parse");

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
  return { postings: modelPostings, method, dropped: extraction.dropped, contentHash, unchanged, recipe, html, finalUrl };
}

export { scanSource as _scanSourceForTests };
