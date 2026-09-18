/**
 * The daily scan. For each company: fetch every active source, normalise postings, reconcile them
 * against what is stored, then apply every follower's keyword and location gate and queue scoring
 * for anything new to them.
 *
 * The company, its sources and the observed postings are shared: one scan a day serves everyone who
 * follows the company. What each person sees of the listing lives in `user_jobs`, one row per
 * follower and posting, created only once the posting passes that follower's gate.
 */
import { schema, enqueueTask, archiveNonMatches, type Task } from "@christopher/db";
import {
  ats,
  classifyScan,
  dedupeKeyFor,
  evaluateGate,
  keyPostings,
  looksRemote,
  modeForScanStatus,
  normalizeTitle,
  priorityFor,
  IncompleteListingError,
  reconcile,
  sha1,
  SourceFetchError,
  type AppSettings,
  type ExistingJob,
  type FetchContext,
  type GateSettings,
  type HtmlRecipe,
  type RawPosting,
  type SourceSpec,
  type SystemSettings,
} from "@christopher/core";
import { and, desc, eq, inArray, sql, or, isNull } from "drizzle-orm";
import type { CareerSource } from "@christopher/db";
import { aiBudgetExceeded, makeFetchContext, type WorkerDeps } from "../context";
import { gzipSync, gunzipSync } from "node:zlib";
import { loadAdmissionCache } from "../admission-cache";
import { prepareForAdmission } from "../admission";
import { withResourceLease } from "../lease";
import { log } from "../log";

type ScanStatus = "ok" | "partial" | "suspect_empty" | "failed";

/** A manual rescan of a company that was scanned this recently is served by the existing result. */
export const MANUAL_RESCAN_INTERVAL_MS = 30 * 60_000;

export async function handleScanCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as { companyId: string; scanRunId?: string; trigger?: string };
  return withResourceLease(deps, `scan:${payload.companyId}`, locked => scanCompany(task, locked));
}

async function scanCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as { companyId: string; scanRunId?: string; trigger?: string };
  const settings = await deps.settings();
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, payload.companyId)).limit(1);
  if (!company) return { skipped: "company not found" };
  if (company.status !== "active") return { skipped: "company is not active" };

  let sources = await deps.db
    .select()
    .from(schema.careerSources)
    .where(and(eq(schema.careerSources.companyId, company.id), inArray(schema.careerSources.status, ["active", "failing"]), payload.trigger === "schedule" ? or(isNull(schema.careerSources.nextScanAt), sql`${schema.careerSources.nextScanAt} <= ${deps.now()}`) : undefined));

  if (sources.length === 0) {
    log.warn("company has no active source", { company: company.name });
    return { skipped: "no active source" };
  }

  // The scan is shared, so one follower's "rescan now" must not fetch a board the system read
  // minutes ago for someone else. A source with no scan yet (just confirmed) is always read.
  if (payload.trigger !== "schedule" && !payload.scanRunId) {
    const cutoff = new Date(deps.now().getTime() - MANUAL_RESCAN_INTERVAL_MS);
    const recent = await deps.db.select({ sourceId: schema.scans.sourceId }).from(schema.scans)
      .where(and(inArray(schema.scans.sourceId, sources.map(s => s.id)), sql`${schema.scans.startedAt} >= ${cutoff}`, inArray(schema.scans.status, ["ok", "partial"])));
    const fresh = new Set(recent.map(r => r.sourceId));
    const stale = sources.filter(s => !fresh.has(s.id));
    if (stale.length === 0) return { skipped: "scanned recently", sources: sources.length };
    sources = stale;
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

interface Follower {
  userId: string;
  settings: AppSettings;
}

/** Description-based matching needs the detail text before the gate can decide anything. */
function needsDescription(gate: GateSettings): boolean {
  return gate.matchFields.includes("description") && gate.includeKeywords.length > 0;
}

async function loadFollowers(deps: WorkerDeps, companyId: string): Promise<Follower[]> {
  const rows = await deps.db.select({ userId: schema.companySubscriptions.userId }).from(schema.companySubscriptions)
    .where(and(eq(schema.companySubscriptions.companyId, companyId), inArray(schema.companySubscriptions.status, ["active", "paused"])));
  return Promise.all(rows.map(async row => ({ userId: row.userId, settings: await deps.userSettings(row.userId) })));
}

async function scanSource(
  deps: WorkerDeps,
  company: typeof schema.companies.$inferSelect,
  source: CareerSource,
  settings: SystemSettings,
  scanRunId: string | null,
): Promise<SourceOutcome> {
  const started = Date.now();
  // Recorded on the worker's clock so the manual-rescan guard compares like with like.
  const startedAt = deps.now();
  const baseCtx = makeFetchContext(deps);
  const responses: Array<{ url: string; status: number; body: string }> = [];
  let snapshotChars = 0;
  // Every byte the adapter reads for this listing, recorded on the scan row. It is the number that
  // tells an operator which source is about to run the worker out of memory, before it does.
  let fetchedBytes = 0;
  const ctx: FetchContext = { ...baseCtx, fetchText: async (url, init) => {
    const response = await baseCtx.fetchText(url, init);
    fetchedBytes += Buffer.byteLength(response.body, "utf8");
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
  let updatedRecipe: HtmlRecipe | undefined;

  try {
    if (source.type === "html") {
      const outcome = await scanHtmlSource(deps, spec, source, ctx);
      postings = outcome.postings;
      fetchMethod = outcome.method;
      droppedByValidation = outcome.dropped;
      contentHash = outcome.contentHash;
      htmlPages = outcome.pages ?? [];
      incomplete = outcome.incomplete ?? false;
      error = outcome.incompleteReason ?? null;
      if (outcome.unchanged) {
        log.debug("source unchanged since last scan", { company: company.name, url: source.url });
      }
      if (outcome.recipe) {
        updatedRecipe = outcome.recipe;
      }
    } else {
      postings = await ats.getAdapter(source.type).fetchPostings(spec, ctx);
    }
  } catch (err) {
    if (err instanceof IncompleteListingError) {
      // The adapter read the board but knows the listing is short (a paging budget ran out, or the
      // feed said it holds more than it returned). What was read is kept and stored; the scan is
      // partial, so nothing closes on the strength of a listing that was never complete.
      postings = err.postings;
      incomplete = true;
      error = err.message.slice(0, 1000);
    } else {
      fetchOk = false;
      error = (err as Error).message.slice(0, 1000);
      blocked = err instanceof SourceFetchError && err.kind === "blocked";
    }
  }

  const previousOk = await deps.db
    .select({ postingsFound: schema.scans.postingsFound })
    .from(schema.scans)
    .where(and(eq(schema.scans.sourceId, source.id), eq(schema.scans.status, "ok")))
    .orderBy(desc(schema.scans.startedAt))
    .limit(1);
  const previousOkCount = previousOk[0]?.postingsFound ?? null;

  // A source that reaches the adapter cap was not read completely. The scan
  // is partial, which keeps every stored role open: only a complete listing
  // is evidence that a role has gone.
  if (postings.length >= ats.MAX_POSTINGS) {
    postings = postings.slice(0, ats.MAX_POSTINGS);
    incomplete = true;
    error ??= `Listing reached the ${ats.MAX_POSTINGS}-posting cap; roles beyond it are not tracked and this scan cannot close roles`;
  }
  // One read of the stored descriptions, taken here and reused by the commit below, so the largest
  // column on the table is not read a second time while the commit holds the source's row lock.
  const descriptionsReadAt = deps.now();
  const savedDescriptions = await deps.db.select({ externalKey: schema.jobs.externalKey, url: schema.jobs.url, text: schema.jobs.descriptionText, at: schema.jobs.descriptionFetchedAt }).from(schema.jobs).where(eq(schema.jobs.sourceId, source.id));
  const reusedDescriptions = new Set<string>();
  const savedByUrl = new Map(savedDescriptions.map(row => [row.url, row]));
  for (const posting of postings) {
    const saved = savedByUrl.get(posting.url);
    if (posting.externalId && saved?.externalKey === `id:${posting.externalId}` && !posting.descriptionText && saved?.text && saved.at && deps.now().getTime() - saved.at.getTime() < 7 * 86400000 && (!posting.updatedAt || posting.updatedAt <= saved.at)) { posting.descriptionText = saved.text; reusedDescriptions.add(posting.url); }
  }
  // Followers decide admission. Only the distinct description-matching gates cost detail fetches;
  // a posting fetched for one follower is already in hand for the next.
  const followers = await loadFollowers(deps, company.id);
  const descriptionGates = [...new Map(followers.filter(f => needsDescription(f.settings.gate)).map(f => [JSON.stringify(f.settings.gate), f.settings.gate])).values()];
  const rejectionCache = await loadAdmissionCache(deps.db, source.id, deps.now());
  // Two ways a description-matching gate can fail to decide about a posting, and they are not the
  // same thing. `unresolved`: the detail text was read inline and could not be had, so the listing
  // was not fully readable and the scan is partial, with admission left to the next scan.
  // `deferred`: the source lists roles without descriptions and serves one per request (Greenhouse
  // — reading 2,331 of them inline is what ran the worker out of heap). The listing itself is
  // complete, so the scan stays `ok` and may still close roles; the posting is stored, a
  // `fetch_description` task is queued for it below, and every follower's gate is re-run when the
  // text lands. A posting is never rejected for want of a description it was never offered.
  const unresolved = new Set<string>();
  const deferred = new Set<string>();
  if (fetchOk && descriptionGates.length) {
    if (ats.descriptionsFetchedPerPosting(source.type)) {
      for (const posting of postings) {
        if (!posting.descriptionText && !savedByUrl.get(posting.url)?.text) deferred.add(posting.url);
      }
    } else {
      for (const gate of descriptionGates) for (const url of await prepareForAdmission(postings, spec, ctx, gate, rejectionCache)) unresolved.add(url);
    }
  }
  await rejectionCache.save();
  /** The gate cannot judge this posting yet: defer it rather than reject it. */
  const undecided = (url: string) => unresolved.has(url) || deferred.has(url);
  if (unresolved.size) {
    incomplete = true;
    error = `${unresolved.size} descriptions unavailable; admission deferred until the next scan`;
  }
  const classified = classifyScan({ fetchOk, postingsFound: postings.length, previousOkCount, droppedByValidation });
  // A listing that collapsed against the last ok scan is what an ATS migration
  // looks like while the old board is still up: it keeps serving, just a
  // shrinking remainder. classifyScan already makes this partial so nothing
  // closes; the message lets the persistence check below recognise it.
  const shrunk = fetchOk && previousOkCount !== null && previousOkCount >= 10 && postings.length > 0 && postings.length < previousOkCount * 0.3;
  if (shrunk) error ??= `Listing shrank from ${previousOkCount} to ${postings.length} postings against the last ok scan; treated as partial`;
  const status = incomplete && classified === "ok" ? "partial" : classified;
  const mode = modeForScanStatus(status);

  // Compressing the evidence is synchronous and the snapshot can be megabytes, so it happens
  // before the transaction opens rather than with the source's row lock held.
  const rawSnapshot = gzipSync(JSON.stringify(snapshotFor(postings, responses, htmlPages))).toString("base64");
  // Scoring is per account, so the budget is asked per account: one follower with nothing left to
  // spend has its roles left unscored, while everyone else scans and scores as usual. Queuing them
  // anyway would only fail and retry each task at the hold. Each distinct account is asked once,
  // here, because a month's budget cannot change meaningfully while one commit runs and asking
  // from inside it took another pooled connection per follower while holding the row lock.
  const scorable = new Set<string>();
  if (!(await aiBudgetExceeded(deps))) {
    for (const follower of followers) {
      if (!(await aiBudgetExceeded(deps, follower.userId))) scorable.add(follower.userId);
    }
  }

  let committed = false;
  const outcome = await deps.db.transaction(async (tx): Promise<SourceOutcome> => {
  await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
  const [current] = await tx.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id)).for("update");
  // A user can disable or replace a source while the network request is in flight.
  if (!current || !["active", "failing"].includes(current.status) || current.url !== source.url || current.apiUrl !== source.apiUrl) {
    return { status: "partial", newCount: 0, closedCount: 0, postingsFound: postings.length };
  }
  const commitDeps = { ...deps, db: tx as unknown as WorkerDeps["db"] };
  committed = true;
  return commitScan(commitDeps);
  });
  // Idempotent and takes a transaction of its own, so it runs after this scan has committed
  // instead of extending the window in which the source's row lock is held.
  if (committed) await archiveNonMatches(deps.db, { sourceId: source.id });
  return outcome;

  async function commitScan(deps: WorkerDeps): Promise<SourceOutcome> {
  if (updatedRecipe) await deps.db.update(schema.careerSources).set({ recipe: updatedRecipe }).where(eq(schema.careerSources.id, source.id));
  const existingRows = await deps.db
    .select({
      descriptionSource: schema.jobs.descriptionSource,
      descriptionTruncated: schema.jobs.descriptionTruncated,
      descriptionFetchedAt: schema.jobs.descriptionFetchedAt,
      descriptionHash: schema.jobs.descriptionHash,
      url: schema.jobs.url,
      locations: schema.jobs.locations,
      department: schema.jobs.department,
      employmentType: schema.jobs.employmentType,
      remote: schema.jobs.remote,
      salaryText: schema.jobs.salaryText,
      postedAt: schema.jobs.postedAt,
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
  const scoreQueue: Array<{ userId: string; jobId: string }> = [];
  const descriptionQueue = new Set<string>();
  const viewInserts: Array<typeof schema.userJobs.$inferInsert> = [];

  // Every observed posting is stored once, for everyone; the gate is applied per follower below.
  const newRows: Array<typeof schema.jobs.$inferInsert> = [];
  for (const insert of result.inserts) {
    newRows.push({
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
        remote: insert.remote ?? looksRemote([insert.location, ...(insert.locations ?? [])].filter(Boolean).join(" ")),
        salaryText: insert.salaryText ?? null,
        postedAt: insert.postedAt ?? null,
        firstSeenAt: deps.now(),
        lastSeenAt: deps.now(),
        seeded: isFirstScan,
        repostOfJobId: insert.repostOfJobId ?? null,
        descriptionText: insert.descriptionText?.slice(0, 30_000) ?? null,
        descriptionSource: insert.descriptionText ? "direct" : null,
        descriptionTruncated: (insert.descriptionText?.length ?? 0) > 30_000,
        descriptionHash: insert.descriptionText ? sha1(insert.descriptionText.slice(0, 30_000)) : null,
        descriptionFetchedAt: insert.descriptionText ? deps.now() : null,
      });
  }
  for (let offset = 0; offset < newRows.length; offset += 100) {
    const created = await deps.db.insert(schema.jobs).values(newRows.slice(offset, offset + 100)).onConflictDoNothing()
      .returning({ id: schema.jobs.id, url: schema.jobs.url, title: schema.jobs.title, department: schema.jobs.department, location: schema.jobs.location, locations: schema.jobs.locations, remote: schema.jobs.remote, descriptionText: schema.jobs.descriptionText });
    newCount += created.length;
    if (created.length) await deps.db.insert(schema.jobEvents).values(created.map(row => ({ jobId: row.id, type: "discovered" as const, payload: { method: fetchMethod, seeded: isFirstScan } })));
    for (const row of created) {
      let wanted = false;
      for (const follower of followers) {
        const gate = follower.settings.gate;
        if (undecided(row.url) && needsDescription(gate)) continue;
        const verdict = evaluateGate({ title: row.title, department: row.department, description: gate.matchFields.includes("description") ? row.descriptionText : undefined, location: row.location, locations: row.locations, remote: row.remote }, gate);
        if (!verdict.inTable) continue;
        wanted = true;
        viewInserts.push({ userId: follower.userId, jobId: row.id, keywordMatched: verdict.keywordMatched, keywordTerms: verdict.keywordTerms, excluded: verdict.excluded, locationOk: verdict.locationOk, inTable: true, nearMiss: false, seeded: isFirstScan, createdAt: deps.now(), updatedAt: deps.now() });
        scoreQueue.push({ userId: follower.userId, jobId: row.id });
      }
      // A posting a follower admitted needs its description stored; a deferred posting needs it
      // before any description gate can decide. The first scan of a 2,331-role Greenhouse board
      // with a description-matching follower therefore queues 2,331 tasks, once: dedupe keys stop
      // duplicates and later scans queue only postings that are new or still have no text. That
      // cost is accepted rather than capped, because a silent cap would hide roles from the gate.
      if (!row.descriptionText && (wanted || deferred.has(row.url))) descriptionQueue.add(row.id);
    }
  }

  if (result.seen.length > 0) {
    await deps.db.update(schema.jobs).set({ lastSeenAt: deps.now(), ...(mode === "ok" ? { missingScans: 0 } : {}) }).where(inArray(schema.jobs.id, result.seen));
  }
  // Refresh every observed posting, including fields the identity reconciliation does not compare.
  const observed = new Map(keyPostings(postings).keyed.map((p) => [p.externalKey, p]));
  const updates: Array<Record<string, unknown>> = [];
  const updateEvents: Array<typeof schema.jobEvents.$inferInsert> = [];
  const seenIds = new Set(result.seen);
  const seenRows = existingRows.filter((j) => seenIds.has(j.id));
  // The copy taken before the listing was fetched, topped up for any row a `fetch_description`
  // task has written (or created) since. Usually no row qualifies and nothing is read.
  const savedTextByKey = new Map(savedDescriptions.map(row => [row.externalKey, row.text]));
  const restale = seenRows.filter(j => !savedTextByKey.has(j.externalKey) || (j.descriptionFetchedAt !== null && j.descriptionFetchedAt > descriptionsReadAt));
  if (restale.length) {
    const fresh = await deps.db.select({ externalKey: schema.jobs.externalKey, text: schema.jobs.descriptionText })
      .from(schema.jobs).where(inArray(schema.jobs.id, restale.map(j => j.id)));
    for (const row of fresh) savedTextByKey.set(row.externalKey, row.text);
  }
  const views = seenRows.length && followers.length
    ? await deps.db.select().from(schema.userJobs).where(and(inArray(schema.userJobs.jobId, seenRows.map(j => j.id)), inArray(schema.userJobs.userId, followers.map(f => f.userId))))
    : [];
  const viewByKey = new Map(views.map(v => [`${v.userId}:${v.jobId}`, v]));
  const viewUpdates: Array<Record<string, unknown>> = [];
  for (const row of seenRows) {
    const job = { ...row, descriptionText: savedTextByKey.get(row.externalKey) ?? null };
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
      descriptionSource: posting.descriptionText !== undefined && !reusedDescriptions.has(posting.url) ? "direct" as const : job.descriptionSource,
      descriptionTruncated: posting.descriptionText !== undefined && !reusedDescriptions.has(posting.url) ? posting.descriptionText.length > 30_000 : job.descriptionTruncated,
    };
    const changedFields = Object.keys(fields).filter((key) =>
      JSON.stringify(fields[key as keyof typeof fields]) !== JSON.stringify(job[key as keyof typeof job]));
    updates.push({ id: job.id,
      ...fields, normalizedTitle: normalizeTitle(fields.title),
      descriptionHash: fields.descriptionText ? sha1(fields.descriptionText) : null,
      descriptionFetchedAt: posting.descriptionText !== undefined && !reusedDescriptions.has(posting.url) ? deps.now() : job.descriptionFetchedAt,
      updatedAt: deps.now(),
    });
    if (changedFields.length) updateEvents.push({ jobId: job.id, type: "updated", payload: { fields: changedFields } });
    const descriptionStale = !job.descriptionFetchedAt || deps.now().getTime() - job.descriptionFetchedAt.getTime() >= 14 * 86_400_000;
    const sourceUpdated = posting.updatedAt && (!job.descriptionFetchedAt || posting.updatedAt > job.descriptionFetchedAt);
    for (const follower of followers) {
      const gate = follower.settings.gate;
      if (undecided(posting.url) && needsDescription(gate)) continue;
      const verdict = evaluateGate({ ...fields, description: gate.matchFields.includes("description") ? fields.descriptionText : undefined }, gate);
      const view = viewByKey.get(`${follower.userId}:${job.id}`);
      if (view) {
        viewUpdates.push({ userId: follower.userId, jobId: job.id, keywordMatched: verdict.keywordMatched, keywordTerms: verdict.keywordTerms,
          excluded: verdict.excluded, locationOk: verdict.locationOk, inTable: verdict.inTable });
        if (verdict.inTable && (changedFields.length || !view.inTable || view.fitScore === null)) scoreQueue.push({ userId: follower.userId, jobId: job.id });
      } else if (verdict.inTable) {
        viewInserts.push({ userId: follower.userId, jobId: job.id, keywordMatched: verdict.keywordMatched, keywordTerms: verdict.keywordTerms, excluded: verdict.excluded, locationOk: verdict.locationOk, inTable: true, nearMiss: false, seeded: false, createdAt: deps.now(), updatedAt: deps.now() });
        scoreQueue.push({ userId: follower.userId, jobId: job.id });
      } else continue;
      if (verdict.inTable && posting.descriptionText === undefined && (descriptionStale || sourceUpdated)) descriptionQueue.add(job.id);
    }
    // A stored posting still without text, whose description was never attempted or whose last
    // attempt is 14 days old, is queued again so a description gate is not deferred for ever.
    // A posting whose text is already stored is not in `deferred` and costs nothing here.
    if (deferred.has(posting.url) && descriptionStale) descriptionQueue.add(job.id);
  }
  for (let offset = 0; offset < updates.length; offset += 250) {
    await deps.db.execute(sql`update jobs j set title=v.title, url=v.url, location=v.location, locations=v.locations,
      department=v.department, employment_type=v."employmentType", remote=v.remote, salary_text=v."salaryText", posted_at=v."postedAt",
      description_text=v."descriptionText", description_source=v."descriptionSource", description_truncated=v."descriptionTruncated", normalized_title=v."normalizedTitle",
      description_hash=v."descriptionHash", description_fetched_at=v."descriptionFetchedAt", updated_at=${deps.now()}
      from jsonb_to_recordset(${JSON.stringify(updates.slice(offset, offset + 250))}::jsonb) as v(id uuid, title text, url text, location text, locations jsonb,
        department text, "employmentType" text, remote boolean, "salaryText" text, "postedAt" timestamptz, "descriptionText" text, "descriptionSource" text, "descriptionTruncated" boolean, "normalizedTitle" text,
        "descriptionHash" text, "descriptionFetchedAt" timestamptz)
      where j.id=v.id`);
  }
  for (let offset = 0; offset < viewUpdates.length; offset += 250) {
    await deps.db.execute(sql`update user_jobs uj set keyword_matched=v."keywordMatched", keyword_terms=v."keywordTerms",
      excluded=v.excluded, location_ok=v."locationOk", in_table=v."inTable", near_miss=false, updated_at=${deps.now()}
      from jsonb_to_recordset(${JSON.stringify(viewUpdates.slice(offset, offset + 250))}::jsonb) as v("userId" uuid, "jobId" uuid,
        "keywordMatched" boolean, "keywordTerms" jsonb, excluded boolean, "locationOk" boolean, "inTable" boolean)
      where uj.user_id=v."userId" and uj.job_id=v."jobId"`);
  }
  for (let offset = 0; offset < viewInserts.length; offset += 250) await deps.db.insert(schema.userJobs).values(viewInserts.slice(offset, offset + 250)).onConflictDoNothing();
  for (let offset = 0; offset < updateEvents.length; offset += 250) await deps.db.insert(schema.jobEvents).values(updateEvents.slice(offset, offset + 250));
  if (result.reopened.length > 0) {
    await deps.db
      .update(schema.jobs)
      .set({ status: "open", closedAt: null, ...(mode === "ok" ? { missingScans: 0 } : {}), reopenedCount: sql`${schema.jobs.reopenedCount} + 1` })
      .where(inArray(schema.jobs.id, result.reopened));
    await deps.db.insert(schema.jobEvents).values(result.reopened.map(jobId => ({ jobId, type: "reopened" as const, payload: {} })));
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
    await deps.db.insert(schema.jobEvents).values(result.closed.map(jobId => ({ jobId, type: "closed" as const, payload: {} })));
  }

  await deps.db.insert(schema.scans).values({
    scanRunId,
    sourceId: source.id,
    startedAt,
    finishedAt: deps.now(),
    status,
    fetchMethod,
    postingsFound: postings.length,
    newCount,
    closedCount: result.closed.length,
    error,
    durationMs: Date.now() - started,
    fetchedBytes,
    rawSnapshot,
  });

  // Keep bounded debugging evidence from the three most recent source scans.
  await deps.db.execute(sql`update scans set raw_snapshot = null where source_id = ${source.id}
    and id not in (select id from scans where source_id = ${source.id} order by started_at desc, id desc limit 3)
    and id not in (select id from scans where source_id = ${source.id} and status='ok' order by started_at desc, id desc limit 1)`);

  const failures = status === "failed" ? source.consecutiveFailures + 1 : 0;
  await deps.db
    .update(schema.careerSources)
    .set({
      consecutiveFailures: failures,
      nextScanAt: failures ? new Date(deps.now().getTime() + Math.min(7, 2 ** Math.min(failures - 1, 3)) * 86400000) : null,
      status: blocked ? "blocked" : failures >= 3 ? "failing" : source.status === "failing" && status === "ok" ? "active" : source.status,
      lastOkScanAt: status === "ok" ? deps.now() : source.lastOkScanAt,
      lastPostingsCount: status === "ok" ? postings.length : source.lastPostingsCount,
      contentHash,
    })
    .where(eq(schema.careerSources.id, source.id));

  // A source that keeps failing, or that suddenly went empty, is worth re-discovering.
  // So is one that shrank and stayed shrunk: three consecutive collapsed scans
  // is a migration in progress, not a quiet week.
  const persistentlyShrunk = shrunk && (await deps.db.select({ error: schema.scans.error, status: schema.scans.status }).from(schema.scans)
    .where(eq(schema.scans.sourceId, source.id)).orderBy(desc(schema.scans.startedAt)).limit(3))
    .filter((scan) => scan.status === "partial" && /shrank/.test(scan.error ?? "")).length >= 3;
  if (failures >= 3 || status === "suspect_empty" || persistentlyShrunk) {
    await enqueueTask(deps.db, "discover", { companyId: company.id, reason: status === "suspect_empty" ? "suspect_empty" : persistentlyShrunk ? "shrunk" : "failing" }, {
      dedupeKey: dedupeKeyFor("discover", { companyId: company.id }),
      priority: priorityFor("discover"),
    });
  }

  const queued: Array<typeof schema.tasks.$inferInsert> = [];
  for (const payload of scoreQueue) if (scorable.has(payload.userId)) queued.push({ type: "score_job", payload, dedupeKey: dedupeKeyFor("score_job", payload), priority: priorityFor("score_job") });
  for (const jobId of descriptionQueue) queued.push({ type: "fetch_description", payload: { jobId }, dedupeKey: dedupeKeyFor("fetch_description", { jobId }), priority: priorityFor("fetch_description") });
  for (let offset = 0; offset < queued.length; offset += 250) await deps.db.insert(schema.tasks).values(queued.slice(offset, offset + 250)).onConflictDoNothing();

  log.info("source scanned", {
    company: company.name,
    type: source.type,
    status,
    postings: postings.length,
    new: newCount,
    closed: result.closed.length,
    followers: followers.length,
    deferredDescriptions: deferred.size,
    fetchedBytes,
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
    ms: Date.now() - started,
  });
  return { status, newCount, closedCount: result.closed.length, postingsFound: postings.length };
  }

}

/**
 * Evidence kept for the last three scans of a source. Version 2 stores every
 * parsed posting (title, url, location, ids) plus a bounded head of each raw
 * response; version 1 stored raw bodies up to 2MB, which for a large feed was
 * the first 5% of the listing and nothing anyone could replay.
 */
function snapshotFor(postings: RawPosting[], responses: Array<{ url: string; status: number; body: string }>, htmlPages: CachedHtmlPage[]) {
  return {
    version: 2,
    postings: postings.map(p => ({ externalId: p.externalId, title: p.title, url: p.url, location: p.location, locations: p.locations, department: p.department, postedAt: p.postedAt })),
    responses: responses.map(r => ({ url: r.url, status: r.status, bytes: r.body.length, head: r.body.slice(0, 20_000) })),
    htmlPages,
  };
}

interface CachedHtmlPage {
  url: string;
  contentHash: string;
  postings: RawPosting[];
  /** Hash of the page as plain HTTP served it, before any browser render. */
  httpHash?: string;
  /** When a browser last rendered this page; a reused capture carries it forward. */
  renderedAt?: string;
}

interface HtmlScanOutcome {
  postings: RawPosting[];
  method: "http" | "browser";
  httpHash?: string;
  renderedAt?: string;
  dropped: number;
  contentHash: string;
  unchanged: boolean;
  recipe?: HtmlRecipe;
  html?: string;
  finalUrl?: string;
  pages?: CachedHtmlPage[];
  incomplete?: boolean;
  incompleteReason?: string;
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
      if ((snapshot.version === 1 || snapshot.version === 2) && Array.isArray(snapshot.htmlPages)) cached = snapshot.htmlPages.map((page: CachedHtmlPage) => ({ ...page, postings: page.postings.map(posting => ({ ...posting,
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
  let incompleteReason: string | undefined;
  while (url && pages.length < 20) {
    if (visited.has(url)) { incomplete = true; break; }
    visited.add(url);
    try {
      const page = await scanHtmlPage(deps, { ...spec, url }, source, ctx, cached.find(p => p.url === url));
      if (page.method === "browser") method = "browser";
      dropped += page.dropped;
      unchanged = unchanged && page.unchanged;
      recipe ??= page.recipe;
      pages.push({ url, contentHash: page.contentHash, postings: page.postings, httpHash: page.httpHash, renderedAt: page.renderedAt });
      incomplete ||= page.incomplete ?? false;
      incompleteReason ??= page.incompleteReason;
      url = page.traversed ? null : ats.nextListingPage(page.html ?? "", page.finalUrl ?? url);
      if (pages.reduce((n, p) => n + p.postings.length, 0) >= 500 && url) { incomplete = true; break; }
    } catch (error) {
      if (pages.length === 0) throw error;
      incomplete = true;
      incompleteReason = `Could not finish listing page ${url}: ${(error as Error).message}`.slice(0, 1000);
      log.warn("HTML pagination incomplete", { url, error: (error as Error).message });
      break;
    }
  }
  if (url) incomplete = true;
  const postings = keyPostings(pages.flatMap(page => page.postings)).keyed;
  return { postings, method, dropped, contentHash: sha1(pages.map(p => p.contentHash).join("|")), unchanged, recipe, pages, incomplete, incompleteReason: incomplete ? incompleteReason ?? "Listing pagination stopped before all pages could be verified (page, posting or browser limit)." : undefined };
}

async function scanHtmlPage(deps: WorkerDeps, spec: SourceSpec, source: CareerSource, ctx: FetchContext, cached?: CachedHtmlPage, supplied?: { html: string; url: string }): Promise<HtmlScanOutcome> {
  let html: string;
  let finalUrl = spec.url;
  let method: "http" | "browser" = "http";

  const page = supplied ?? await ats.fetchHtmlPage(spec, ctx);
  html = page.html;
  finalUrl = page.url;

  let postings = ats.extractPostingsFromHtml(html, finalUrl, spec.recipe);
  const httpHash = supplied ? undefined : sha1(html.replace(/\s+/g, " "));
  const wantsRender = !supplied && deps.browser && (postings.length === 0 || (!ats.nextListingPage(html, finalUrl) && /<(?:button|a)[^>]*>\s*(?:next|load more|show more)/i.test(html)));
  // A server-rendered list with a "load more" control was rendered every scan
  // to reach the rest of it. When the first page is byte-identical to the one
  // behind the last render, the rest has not moved either: reuse that capture
  // and skip the browser, but never for more than a week, and never for a
  // JavaScript shell (zero postings over HTTP), whose static markup says
  // nothing about what the board lists today.
  const RENDER_TTL_MS = 7 * 86_400_000;
  if (wantsRender && postings.length > 0 && cached?.httpHash && cached.httpHash === httpHash && cached.renderedAt && cached.postings.length >= postings.length
      && deps.now().getTime() - new Date(cached.renderedAt).getTime() < RENDER_TTL_MS) {
    log.debug("reusing last render: first page unchanged", { url: spec.url, renderedAt: cached.renderedAt });
    return { postings: cached.postings, method: "http", dropped: 0, contentHash: cached.contentHash, unchanged: true, html, finalUrl, httpHash, renderedAt: cached.renderedAt };
  }
  if (wantsRender) {
    const rendered = await deps.browser!.render(spec.url, { scrollAndExpand: true });
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
      contentHash: sha1(captures.map(p => p.html).join("|")), unchanged: false, httpHash, renderedAt: deps.now().toISOString(), incomplete, incompleteReason: incomplete ? "Browser pagination could not complete; a control was blocked, did not advance, or reached its limit." : undefined, traversed: true };

  }

  const contentHash = sha1(html.replace(/\s+/g, " "));
  const unchanged = contentHash === cached?.contentHash;

  if (postings.length === 0 && unchanged && cached?.postings.length) postings = cached.postings;
  if (postings.length > 0) return { postings, method, dropped: 0, contentHash, unchanged, html, finalUrl, httpHash };
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
