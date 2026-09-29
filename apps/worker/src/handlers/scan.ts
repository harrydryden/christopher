/**
 * The daily scan. For each company: fetch every active source, normalise postings, reconcile them
 * against what is stored, then apply every follower's keyword and location gate and queue scoring
 * for anything new to them.
 *
 * The company, its sources and the observed postings are shared: one scan a day serves everyone who
 * follows the company. What each person sees of the listing lives in `user_jobs`, one row per
 * follower and posting, created only once the posting passes that follower's gate.
 */
import { withSpan } from "../otel";
import { schema, taskRow, enqueueTasks, enqueueStandard, enqueueTask, archiveNonMatches, gateCompiler, inTableFor, newView, viewUpdate, viewVerdict, writeViewUpdates, type Task, type ViewUpdate } from "@ava/db";
import {
  ats,
  classifyScan,
  deriveExternalKey,
  keyPostings,
  listingShrank,
  looksRemote,
  MANUAL_RESCAN_INTERVAL_MS,
  modeForScanStatus,
  normalisePostingUrl,
  normalizeTitle,
  priorityFor,
  IncompleteListingError,
  reconcile,
  sha1,
  SourceFetchError,
  type AppSettings,
  type CompiledGate,
  type ExistingJob,
  type FetchContext,
  type GateSettings,
  type HtmlRecipe,
  type RawPosting,
  type SourceSpec,
  type SystemSettings,
  SOURCE_FAILING_AFTER,
  stripHtml,
} from "@ava/core";
import { and, desc, eq, inArray, sql, or, isNull } from "drizzle-orm";
import type { CareerSource } from "@ava/db";
import { makeFetchContext, type WorkerDeps } from "../context";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { loadAdmissionCache } from "../admission-cache";
import { prepareForAdmission } from "../admission";
import { admitScores } from "../score-admission";
import { HostBusyError, statusKind } from "../fetcher";
import { withResourceLease } from "../lease";
import { TaskDeferred } from "../queue";
import { appendHtmlCheckpointPage, clearHtmlCheckpoint, htmlSourceFingerprint, HtmlCheckpointChanged,
  HTML_GENERATION_MAX_PAGES, loadHtmlCheckpoint, pruneHtmlCheckpoints, recordHtmlCheckpointMetrics, restartHtmlCheckpoint,
  type HtmlCheckpoint } from "../html-scan-checkpoint";
import { log } from "../log";
import { listingCaptureCount, listingCaptures } from "../listing-captures";
import { loadUserSettingsMany } from "../settings";

type ScanStatus = "ok" | "partial" | "suspect_empty" | "failed";

/**
 * A manual rescan of a company that was scanned this recently is served by the existing result.
 * Re-exported from core, where the interface reads it too: it writes the same sentence into the
 * Refresh control, and `apps/web` may not import `apps/worker`.
 */
export { MANUAL_RESCAN_INTERVAL_MS };

/**
 * The most outbound requests one scan of one source may make.
 *
 * The real ceiling is already there and invisible: a company scan runs under a three-minute task
 * deadline, and at one request every two seconds a source that keeps asking — page after page of a
 * listing, or one detail text per role for a description gate — runs out of time long before it
 * runs out of pages. A scan killed by its deadline is a failed scan with nothing to show for the
 * requests it did make. This makes the ceiling explicit instead: past it the scan stops fetching
 * and is recorded `partial`, with a reason that says so, which keeps every stored role open (only a
 * successful scan may close a role) and puts the source on Health beside every other partial scan.
 */
export const MAX_REQUESTS_PER_SCAN = 150;

/**
 * What a structured applicant-tracking feed's listing may take instead, with at most
 * `MAX_REQUESTS_PER_SCAN` more for descriptions after it. Those feeds page (Workday serves twenty
 * roles a page, so its 10,000-role cap is 500 pages) from vendor hosts paced at 250 ms, so at 150
 * a board of 3,000 roles was always partial and could never close one.
 */
export const MAX_LISTING_REQUESTS_PER_FEED = 600;

/** Recorded on the scan row when a request budget stopped it, and shown on Health as its reason. */
const budgetSpentReason = (limit: number) => `Scan stopped after its budget of ${limit} requests to this source was spent; the listing was not read completely, so this scan cannot close roles`;

/**
 * How many times one company's scan is put back for a host that is paced beyond what a slot may
 * wait. Past this the source records a failed scan for the day (counted against nothing).
 */
const MAX_HOST_BUSY_DEFERRALS = 6;
/** One HTTP listing pass stays comfortably below the three-minute task deadline at a 2s host pace. */
const HTML_PAGES_PER_TASK_PASS = 20;
const HTML_GENERATION_MAX_POSTINGS = 5_000;
/** Leave at least eighty seconds of a three-minute claim for final reconciliation and queue work. */
export const HTML_CLAIM_FETCH_BUDGET_MS = 100_000;

/**
 * Taken off a failing source's backoff so that "one day" means the next daily run: the scan ran
 * after its run began (spread across the hour, then queued), and the next run checks at its start.
 */
const BACKOFF_MARGIN_MS = 12 * 3_600_000;

/** The adapters that read a structured feed rather than a page. */
const PAGE_TYPES = new Set(["html", "jsonld", "rss"]);

/**
 * Thrown by a scan's fetch wrapper when the listing the adapter asked for came back byte-identical
 * to the one behind this source's last successful scan. The parsed listing from that scan is
 * carried on the error and reused as this scan's observation: an unchanged listing lists exactly
 * the same roles, so nothing is missing from it and nothing may close on the strength of it that
 * would not have closed on a re-parse of the same bytes.
 */
class ListingUnchanged extends Error {
  constructor(readonly snapshot: StoredSnapshot) {
    super("listing unchanged since the last successful scan");
    this.name = "ListingUnchanged";
  }
}

/**
 * `sourceIds` and `hostBusyRetries` are set only on a scan put back because a host was busy: the
 * sources still to read, and how many times that has happened.
 */
type ScanPayload = { companyId: string; scanRunId?: string; trigger?: string; sourceIds?: string[]; hostBusyRetries?: number };

export async function handleScanCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as ScanPayload;
  return withResourceLease(deps, `scan:${payload.companyId}`, locked => scanCompany(task, locked));
}

async function scanCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const claimStartedAtMs = Date.now();
  const payload = task.payload as ScanPayload;
  const settings = await deps.settings();
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, payload.companyId)).limit(1);
  if (!company) return { skipped: "company not found" };
  if (company.status !== "active") return { skipped: "company is not active" };

  // A final scan commit may outlive the queue's completion write. The task/source marker lets a
  // reclaimed task skip that source without repeating user admissions, miss counts or closure.
  const committed = await deps.db.select({ sourceId: schema.scans.sourceId }).from(schema.scans).where(eq(schema.scans.taskId, task.id));
  const completedSourceIds = new Set(committed.map(row => row.sourceId));
  // The scan transaction commits before this idempotent housekeeping step. Reclaimed work must
  // finish it even when the scan marker says not to reconcile the source a second time.
  for (const sourceId of completedSourceIds) await archiveNonMatches(deps.db, { sourceId });
  await pruneHtmlCheckpoints(deps.db, deps.now());

  let sources = await deps.db
    .select()
    .from(schema.careerSources)
    .where(and(eq(schema.careerSources.companyId, company.id), inArray(schema.careerSources.status, ["active", "failing"]), payload.trigger === "schedule" ? or(isNull(schema.careerSources.nextScanAt), sql`${schema.careerSources.nextScanAt} <= ${deps.now()}`) : undefined))
    .orderBy(schema.careerSources.createdAt, schema.careerSources.id);

  if (payload.sourceIds) sources = sources.filter(s => payload.sourceIds!.includes(s.id));
  sources = sources.filter(s => !completedSourceIds.has(s.id));
  if (sources.length === 0) {
    if (completedSourceIds.size) return { sources: completedSourceIds.size, resumed: true };
    log.warn("company has no active source", { company: company.name });
    return { skipped: "no active source" };
  }

  // The scan is shared, so one follower's "rescan now" must not fetch a board the system read
  // minutes ago for someone else. A source with no scan yet (just confirmed) is always read.
  if (payload.trigger !== "schedule" && !payload.scanRunId) {
    const staged = await deps.db.select({ sourceId: schema.htmlScanGenerations.sourceId }).from(schema.htmlScanGenerations)
      .where(eq(schema.htmlScanGenerations.taskId, task.id));
    const stagedIds = new Set(staged.map(row => row.sourceId));
    const cutoff = new Date(deps.now().getTime() - MANUAL_RESCAN_INTERVAL_MS);
    const recent = await deps.db.select({ sourceId: schema.scans.sourceId }).from(schema.scans)
      .where(and(inArray(schema.scans.sourceId, sources.map(s => s.id)), sql`${schema.scans.startedAt} >= ${cutoff}`, inArray(schema.scans.status, ["ok", "partial"])));
    const fresh = new Set(recent.map(r => r.sourceId));
    const stale = sources.filter(s => stagedIds.has(s.id) || !fresh.has(s.id));
    if (stale.length === 0) return { skipped: "scanned recently", sources: sources.length };
    sources = stale;
  }

  let totalNew = 0;
  let totalClosed = 0;
  const statuses: ScanStatus[] = [];
  const retries = payload.hostBusyRetries ?? 0;
  const continuationBusyRetries = (task.result as { busyRetries?: number } | null)?.busyRetries ?? 0;
  const deferred: string[] = [];
  let retryAt: Date | null = null;
  for (const source of sources) {
    const outcome = await withSpan("scan.fetch", { "source.type": source.type }, () =>
      scanSource(deps, company, source, settings, payload.scanRunId ?? null, { deferWhenHostBusy: Math.max(retries, continuationBusyRetries) < MAX_HOST_BUSY_DEFERRALS, taskId: task.id, taskAttempt: task.attempts, claimStartedAtMs }));
    if (outcome.continueAt) {
      return new TaskDeferred(outcome.continueAt, { sourceId: source.id, htmlPages: outcome.pagesStaged,
        busyRetries: continuationBusyRetries, reason: "Reading a paged HTML listing" });
    }
    if (outcome.retryAt) {
      const [checkpoint] = source.type === "html" ? await deps.db.select({ id: schema.htmlScanGenerations.id, pageCount: sql<number>`(select count(*)::int from html_scan_pages p where p.generation_id = ${schema.htmlScanGenerations.id})` })
        .from(schema.htmlScanGenerations).where(and(eq(schema.htmlScanGenerations.taskId, task.id), eq(schema.htmlScanGenerations.sourceId, source.id))).limit(1) : [];
      if (checkpoint) return new TaskDeferred(outcome.retryAt, { sourceId: source.id, htmlPages: checkpoint.pageCount, busyRetries: continuationBusyRetries + 1, reason: "Host pacing paused HTML listing continuation" });
      deferred.push(source.id);
      if (!retryAt || outcome.retryAt > retryAt) retryAt = outcome.retryAt;
      continue;
    }
    statuses.push(outcome.status);
    totalNew += outcome.newCount;
    totalClosed += outcome.closedCount;
  }
  // A host paced beyond what a slot may wait was not asked anything: its sources are read again
  // when the pace allows, by a task of their own, and nothing about them is recorded until then. A
  // scheduled scan keeps its run, which stays open until that task is done.
  if (retryAt) {
    const next: ScanPayload = { companyId: payload.companyId, scanRunId: payload.scanRunId, trigger: payload.trigger, sourceIds: deferred, hostBusyRetries: retries + 1 };
    const base = (task.dedupeKey ?? `scan_company:${company.id}`).replace(/:host-busy:\d+$/, "");
    await enqueueTask(deps.db, "scan_company", next, { dedupeKey: `${base}:host-busy:${retryAt.getTime()}`, priority: task.priority ?? priorityFor("scan_company"), runAfter: retryAt });
    log.info("host busy: sources put back", { company: company.name, sources: deferred.length, retryAt: retryAt.toISOString() });
  }

  return { sources: sources.length, new: totalNew, closed: totalClosed, statuses, ...(retryAt ? { deferred: deferred.length, retryAt: retryAt.toISOString() } : {}) };
}

interface SourceOutcome {
  status: ScanStatus;
  newCount: number;
  closedCount: number;
  postingsFound: number;
  /** Set when nothing was read because the host is paced until then; no scan was recorded. */
  retryAt?: Date;
  /** The same task will resume this source from its durable HTML page checkpoint. */
  continueAt?: Date;
  pagesStaged?: number;
}

interface Follower {
  userId: string;
  settings: AppSettings;
  /** This follower's gate with its patterns built once; followers with the same gate share one. */
  gate: CompiledGate;
}

/** Description-based matching needs the detail text before the gate can decide anything. */
function needsDescription(gate: GateSettings): boolean {
  return gate.matchFields.includes("description") && gate.includeKeywords.length > 0;
}

/**
 * Everyone who follows the company, with their settings read in one query. `lockGates` share-locks
 * their gate rows for the caller's transaction (see `loadUserSettingsMany`): the commit reads the
 * gates it writes verdicts from that way, after the network work, so a gate saved while the scan
 * was fetching is the one it applies.
 */
async function loadFollowers(db: WorkerDeps["db"], companyId: string, opts: { lockGates?: boolean } = {}): Promise<Follower[]> {
  const rows = await db.select({ userId: schema.companySubscriptions.userId }).from(schema.companySubscriptions)
    .where(and(eq(schema.companySubscriptions.companyId, companyId), inArray(schema.companySubscriptions.status, ["active", "paused"])));
  const settings = await loadUserSettingsMany(db, rows.map(row => row.userId), opts);
  const gateFor = gateCompiler();
  return rows.map(row => {
    const own = settings.get(row.userId)!;
    return { userId: row.userId, settings: own, gate: gateFor(own.gate) };
  });
}

async function scanSource(
  deps: WorkerDeps,
  company: typeof schema.companies.$inferSelect,
  source: CareerSource,
  settings: SystemSettings,
  scanRunId: string | null,
  opts: { deferWhenHostBusy?: boolean; taskId?: string; taskAttempt?: number; claimStartedAtMs?: number } = {},
): Promise<SourceOutcome> {
  const started = Date.now();
  // Recorded on the worker's clock so the manual-rescan guard compares like with like.
  const startedAt = deps.now();
  const baseCtx = makeFetchContext(deps);
  const responses: Array<{ url: string; status: number; body: string }> = [];
  let snapshotChars = 0;
  // Every byte this scan actually transferred, recorded on the scan row. It is the number that
  // tells an operator which source is about to run the worker out of memory, before it does — so a
  // body the fetcher served from its cache after a 304 is not counted (nothing came down the wire),
  // and a browser render is, because those bytes were read too.
  let fetchedBytes = 0;
  // What the scan cost the host: every request attempted, and how many of them the host answered
  // with a 304. A source whose listing revalidates is nearly free; one that never does is not.
  let requests = 0;
  let revalidated = 0;
  // Set when the request budget below stopped this scan, whoever ends up catching the error: an
  // adapter that gives up mid-listing and a description read that swallows the failure both leave
  // a scan that did not read everything, and it must be recorded as one.
  let budgetSpent = false;
  // A structured feed may page further for its listing; descriptions keep the ordinary budget.
  let requestLimit = PAGE_TYPES.has(source.type) ? MAX_REQUESTS_PER_SCAN : MAX_LISTING_REQUESTS_PER_FEED;
  // The evidence kept with this source's last successful scan, read at most once and only when
  // something is about to reuse it.
  let snapshot: Promise<StoredSnapshot | null> | null = null;
  const lastOkSnapshot = () => (snapshot ??= readLastOkSnapshot(deps, source.id));
  // The hash of the listing body this scan read, stored with its snapshot. A snapshot may only be
  // reused for bytes it was actually parsed from: "unchanged since the last time this process read
  // the URL" is not the same claim as "unchanged since the last successful scan", and a snapshot
  // from some older listing would be a fabricated observation, which is how roles close wrongly.
  let listingHash: string | undefined;
  const spend = () => {
    if (requests >= requestLimit) {
      budgetSpent = true;
      throw new Error(budgetSpentReason(requestLimit));
    }
    requests += 1;
  };
  const count = (response: { revalidated?: boolean; body: string }) => {
    if (response.revalidated) revalidated += 1;
    else fetchedBytes += Buffer.byteLength(response.body, "utf8");
  };
  const ctx: FetchContext = { ...baseCtx, fetchText: async (url, init) => {
    // Only the first request of a scan is the listing itself; a description, a departments index or
    // a second listing page says nothing about whether the board as a whole moved, so only this one
    // asks to be revalidated. HTML never reuses the full listing from this first-page signal.
    const isListing = requests === 0;
    spend();
    let response = await baseCtx.fetchText(url, isListing ? { ...init, revalidateLargeBody: true } : init);
    count(response);
    if (isListing) listingHash = response.contentHash;
    if (isListing && response.unchanged) {
      // Reuse the whole listing only when the adapter explicitly proves that its first response
      // contains every posting and mapped field. A paged feed's first page says nothing about later
      // pages, even if its bytes are identical to yesterday's.
      const stored = ats.getAdapter(source.type).completeFromFirstResponse ? await lastOkSnapshot() : null;
      if (stored && stored.postings.length > 0 && stored.listingHash && stored.listingHash === response.contentHash) throw new ListingUnchanged(stored);
      // Nothing to reuse: a 304 left no body, so ask again without the validators.
      if (!response.body) {
        spend();
        response = await baseCtx.fetchText(url, { ...init, revalidateLargeBody: false });
        count(response);
      }
    }
    const body = response.body.slice(0, Math.max(0, 2_000_000 - snapshotChars));
    snapshotChars += body.length;
    if (body) responses.push({ url: response.url, status: response.status, body });
    return response;
  }, render: baseCtx.render ? async (url, opts) => {
    spend();
    const page = await baseCtx.render!(url, opts);
    fetchedBytes += Buffer.byteLength(page.html, "utf8");
    return page;
  } : undefined };
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
  let reusedListing = false;
  let longHtmlListing = false;
  let hostBusy: HostBusyError | null = null;

  try {
    if (source.type === "html") {
      const outcome = await scanHtmlSource(deps, spec, source, ctx, lastOkSnapshot, opts.taskId, undefined, opts.claimStartedAtMs);
      if (outcome.continueAt) {
        await recordHtmlCheckpointMetrics(deps, opts.taskId!, source,
          { requests, fetchedBytes, revalidated, activeDurationMs: Date.now() - started }, opts.taskAttempt ?? 1);
        return { status: "partial", newCount: 0, closedCount: 0, postingsFound: outcome.postings.length,
          continueAt: outcome.continueAt, pagesStaged: outcome.pagesStaged };
      }
      longHtmlListing = outcome.longListing ?? false;
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
    if (err instanceof ListingUnchanged) {
      // The bytes were identical, so re-parsing them could only produce this same listing. It is
      // the complete observation of the board, which is why the scan stays `ok`: every stored role
      // is present in it, so none is missing and none closes, and the two-miss rule is untouched.
      postings = err.snapshot.postings;
      htmlPages = err.snapshot.htmlPages;
      reusedListing = true;
      log.debug("listing unchanged: reusing the last successful scan's postings", { company: company.name, url: source.url, postings: postings.length });
    } else if (err instanceof IncompleteListingError) {
      // The adapter read the board but knows the listing is short (a paging budget ran out, or the
      // feed said it holds more than it returned). What was read is kept and stored; the scan is
      // partial, so nothing closes on the strength of a listing that was never complete.
      postings = err.postings;
      incomplete = true;
      error = err.message.slice(0, 1000);
    } else if (budgetSpent) {
      // Checked after `IncompleteListingError` so an adapter that gives its partial listing up
      // rather than propagating still has it stored. The reason and the partial status are applied
      // below, so that a budget spent inside a description read — where the failure is swallowed
      // and never reaches here at all — is recorded in exactly the same way.
    } else if (err instanceof HostBusyError) {
      // The host is paced beyond what this slot may wait, and nothing was sent. That says nothing
      // about the board, so it is never a miss and never a failure of the source.
      hostBusy = err;
      fetchOk = false;
      error = err.message.slice(0, 1000);
    } else {
      fetchOk = false;
      error = (err as Error).message.slice(0, 1000);
      blocked = err instanceof SourceFetchError && err.kind === "blocked";
    }
  }

  if (hostBusy && opts.deferWhenHostBusy) {
    if (opts.taskId && source.type === "html") {
      const [generation] = await deps.db.select({ id: schema.htmlScanGenerations.id }).from(schema.htmlScanGenerations)
        .where(and(eq(schema.htmlScanGenerations.taskId, opts.taskId), eq(schema.htmlScanGenerations.sourceId, source.id))).limit(1);
      if (generation) await recordHtmlCheckpointMetrics(deps, opts.taskId, source,
        { requests, fetchedBytes, revalidated, activeDurationMs: Date.now() - started }, opts.taskAttempt ?? 1);
    }
    log.info("host busy: source scan deferred", { company: company.name, url: source.url, host: hostBusy.host, retryAt: hostBusy.retryAt.toISOString() });
    return { status: "failed", newCount: 0, closedCount: 0, postingsFound: 0, retryAt: hostBusy.retryAt };
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
  // The description text each posting carried in the listing itself, before anything below fills
  // one in: its hash goes into the snapshot, so a byte-identical listing reused later still knows
  // which roles it gave text for, and that the text was the one stored.
  const inlineHash = new Map<string, string>();
  for (const posting of postings as StoredPosting[]) {
    if (inlineHash.has(posting.url)) continue;
    const hash = reusedListing ? posting.descriptionHash : posting.descriptionText ? sha1(posting.descriptionText.slice(0, 30_000)) : undefined;
    if (hash) inlineHash.set(posting.url, hash);
  }
  // Followers decide admission. Only the distinct description-matching gates cost detail fetches;
  // a posting fetched for one follower is already in hand for the next. These gates only plan what
  // to read: the verdicts are written from the gates the commit reads under lock, below.
  const followersAtFetch = await loadFollowers(deps.db, company.id);
  const descriptionGates = [...new Map(followersAtFetch.filter(f => needsDescription(f.settings.gate)).map(f => [JSON.stringify(f.settings.gate), f.settings.gate])).values()];
  // One read of what is stored about the listed roles, taken here and reused by the commit below,
  // so it is not repeated while the commit holds the source's row lock. Only rows this listing
  // carries: a source's closed history can run to thousands of descriptions nothing here uses. And
  // the text itself, the largest column on the table, only where a follower's gate reads it and
  // the listing did not carry it.
  const descriptionsReadAt = deps.now();
  const observedKeys = keyPostings(postings).keyed.map(p => p.externalKey);
  const savedDescriptions = observedKeys.length ? await deps.db.select({
    externalKey: schema.jobs.externalKey, url: schema.jobs.url, hash: schema.jobs.descriptionHash, at: schema.jobs.descriptionFetchedAt,
    hasText: sql<boolean>`${schema.jobs.descriptionText} is not null`,
  }).from(schema.jobs).where(and(eq(schema.jobs.sourceId, source.id), inArray(schema.jobs.externalKey, observedKeys))) : [];
  const readsDescriptions = followersAtFetch.some(f => f.gate.matchesDescription);
  const textWanted = readsDescriptions ? keyPostings(postings).keyed.filter(p => !p.descriptionText).map(p => p.externalKey) : [];
  const savedText = new Map<string, string | null>();
  for (let offset = 0; offset < textWanted.length; offset += 1000) {
    const rows = await deps.db.select({ externalKey: schema.jobs.externalKey, text: schema.jobs.descriptionText }).from(schema.jobs)
      .where(and(eq(schema.jobs.sourceId, source.id), inArray(schema.jobs.externalKey, textWanted.slice(offset, offset + 1000))));
    for (const row of rows) savedText.set(row.externalKey, row.text);
  }
  const reusedDescriptions = new Set<string>();
  const savedByUrl = new Map(savedDescriptions.map(row => [row.url, row]));
  for (const posting of postings) {
    const saved = savedByUrl.get(posting.url);
    const text = saved ? savedText.get(saved.externalKey) : undefined;
    if (!saved || !text || posting.descriptionText) continue;
    // The listing is the one behind the stored text, byte for byte: what it carried then, it
    // carries now, however long ago that was.
    const sameInline = reusedListing && inlineHash.get(posting.url) === saved.hash;
    const recent = !!posting.externalId && saved.externalKey === `id:${posting.externalId}` && !!saved.at && deps.now().getTime() - saved.at.getTime() < 7 * 86400000 && (!posting.updatedAt || posting.updatedAt <= saved.at);
    if (sameInline || recent) { posting.descriptionText = text; reusedDescriptions.add(posting.url); }
  }
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
    if (ats.descriptionsFetchedPerPosting(source.type) || longHtmlListing) {
      for (const posting of postings) {
        if (!posting.descriptionText && !savedByUrl.get(posting.url)?.hasText) deferred.add(posting.url);
      }
    } else {
      // The listing is read; what descriptions may cost is the ordinary budget from here.
      requestLimit = Math.min(requestLimit, requests + MAX_REQUESTS_PER_SCAN);
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
  // Last, so that it names the cause rather than the symptom: a spent budget is why those
  // descriptions were unavailable, and why the listing above may be short.
  if (budgetSpent) {
    incomplete = true;
    error = budgetSpentReason(requestLimit);
  }
  // The source's latest scans, newest first, while each was partial because its listing collapsed.
  const recentShrunkCounts: number[] = [];
  for (const scan of await deps.db.select({ status: schema.scans.status, error: schema.scans.error, postingsFound: schema.scans.postingsFound }).from(schema.scans)
    .where(eq(schema.scans.sourceId, source.id)).orderBy(desc(schema.scans.startedAt)).limit(2)) {
    if (scan.status !== "partial" || !/shrank/.test(scan.error ?? "")) break;
    recentShrunkCounts.push(scan.postingsFound);
  }
  const classified = classifyScan({ fetchOk, postingsFound: postings.length, previousOkCount, droppedByValidation, recentShrunkCounts });
  // A listing that collapsed against the last ok scan is what an ATS migration
  // looks like while the old board is still up: it keeps serving, just a
  // shrinking remainder. classifyScan already makes this partial so nothing
  // closes; the message lets the persistence check below recognise it.
  const collapsed = fetchOk && listingShrank(previousOkCount, postings.length);
  // Unless the same collapsed count has now been read three times running: that board did shrink,
  // and this scan is ok. It is worth looking for a new board all the same.
  const settledShrink = collapsed && classified === "ok";
  const shrunk = collapsed && !settledShrink;
  if (shrunk) error ??= `Listing shrank from ${previousOkCount} to ${postings.length} postings against the last ok scan; treated as partial`;
  // A scan that knows it did not read the whole listing is `partial`, never `suspect_empty`: it is
  // not evidence that the board went empty, and it must not trigger re-discovery on that reading.
  const status = incomplete && classified !== "failed" ? "partial" : classified;
  const mode = modeForScanStatus(status);

  // Compressing the evidence is synchronous and the snapshot can be megabytes, so it happens
  // before the transaction opens rather than with the source's row lock held.
  const rawSnapshot = gzipSync(JSON.stringify(snapshotFor(postings, responses, htmlPages, listingHash, inlineHash))).toString("base64");

  let committed = false;
  const outcome = await deps.db.transaction(async (tx): Promise<SourceOutcome> => {
  await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
  const [current] = await tx.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id)).for("update");
  // A user can disable or replace a source while the network request is in flight.
  if (!current || !["active", "failing"].includes(current.status) || htmlSourceFingerprint(current) !== htmlSourceFingerprint(source)) {
    return { status: "partial", newCount: 0, closedCount: 0, postingsFound: postings.length };
  }
  if (opts.taskId) {
    const [already] = await tx.select().from(schema.scans).where(and(eq(schema.scans.taskId, opts.taskId), eq(schema.scans.sourceId, source.id))).limit(1);
    if (already) return { status: already.status, newCount: already.newCount, closedCount: already.closedCount, postingsFound: already.postingsFound };
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
  // First, before anything is written: the gates the verdicts below come from, read now that the
  // network work is done and held until this commits (see `loadFollowers`).
  const followers = await loadFollowers(deps.db, company.id, { lockGates: true });
  if (updatedRecipe) await deps.db.update(schema.careerSources).set({ recipe: updatedRecipe }).where(eq(schema.careerSources.id, source.id));
  const sourceRows = await deps.db
    .select({
      origin: schema.jobs.origin,
      addedBy: schema.jobs.addedBy,
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
      firstMissedAt: schema.jobs.firstMissedAt,
      title: schema.jobs.title,
      location: schema.jobs.location,
      normalizedTitle: schema.jobs.normalizedTitle,
      closedAt: schema.jobs.closedAt,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.sourceId, source.id));
  // A posting a follower pasted the URL of was never in this listing, so its absence from one is
  // no evidence about it: it is kept out of reconciliation altogether, which is what stops a scan
  // counting it missing, closing it or reopening it. It rejoins the listing below, the first time
  // a scan actually observes its URL.
  const existingRows = sourceRows.filter((row) => row.origin !== "user");
  const existing: ExistingJob[] = existingRows.map((r) => ({ ...r, status: r.status, closedAt: r.closedAt }));

  const result = reconcile(existing, postings, { mode, now: deps.now(), closeAfterMissing: settings.closeAfterMissingScans });
  const isFirstScan = existing.length === 0 && previousOkCount === null;

  let newCount = 0;
  const scoreQueue: Array<{ userId: string; jobId: string }> = [];
  const descriptionQueue = new Set<string>();
  const viewInserts: Array<typeof schema.userJobs.$inferInsert> = [];

  // A role somebody added by URL, which this listing now carries, is the same vacancy. The scan
  // adopts that row instead of storing a second one beside it: the person's decisions, CV and
  // history stay with it, and from here it is an ordinary scanned posting the two-miss rule can
  // close like any other. The match is on the canonical URL, because the listing's identifier and
  // the one derived from a pasted link will never agree.
  const userRows = await deps.db
    .select({
      id: schema.jobs.id, url: schema.jobs.url, externalKey: schema.jobs.externalKey,
      location: schema.jobs.location, locations: schema.jobs.locations, department: schema.jobs.department,
      employmentType: schema.jobs.employmentType, remote: schema.jobs.remote, salaryText: schema.jobs.salaryText,
      postedAt: schema.jobs.postedAt, descriptionText: schema.jobs.descriptionText,
    })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.companyId, company.id), eq(schema.jobs.origin, "user")));
  const userByUrl = new Map(userRows.map((row) => [normalisePostingUrl(row.url), row]));
  // (source, external_key) is unique. A scanned row already holding the key the listing gives this
  // posting means the two are not the same row after all, so both are left as they are.
  const keyOwner = new Map(sourceRows.map((row) => [row.externalKey, row.id]));
  const adoptions: Array<{ job: (typeof userRows)[number]; insert: (typeof result.inserts)[number] }> = [];
  const adoptedIds = new Set<string>();

  // Every observed posting is stored once, for everyone; the gate is applied per follower below.
  const newRows: Array<typeof schema.jobs.$inferInsert> = [];
  for (const insert of result.inserts) {
    const candidate = userByUrl.get(normalisePostingUrl(insert.url));
    const holder = keyOwner.get(insert.externalKey);
    if (candidate && !adoptedIds.has(candidate.id) && (holder === undefined || holder === candidate.id)) {
      adoptions.push({ job: candidate, insert });
      adoptedIds.add(candidate.id);
      continue;
    }
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
  type Admissible = { id: string; url: string; title: string; department: string | null; location: string | null; locations: string[]; remote: boolean | null; descriptionText: string | null };
  /**
   * Offer a posting new to these followers to each one's gate: a view for every follower it
   * admits, and then either its description or their scores queued.
   */
  const admit = (row: Admissible, seeded: boolean, skip?: (userId: string) => boolean) => {
    const admitted: string[] = [];
    for (const follower of followers) {
      if (skip?.(follower.userId)) continue;
      if (undecided(row.url) && needsDescription(follower.settings.gate)) continue;
      const verdict = follower.gate.evaluate({ title: row.title, department: row.department, description: follower.gate.matchesDescription ? row.descriptionText : undefined, location: row.location, locations: row.locations, remote: row.remote });
      if (!verdict.inTable) continue;
      admitted.push(follower.userId);
      viewInserts.push(newView(follower.userId, row.id, viewVerdict(verdict, true), seeded, deps.now()));
    }
    // A posting a follower admitted needs its description stored; a deferred posting needs it
    // before any description gate can decide. The first scan of a 2,331-role Greenhouse board
    // with a description-matching follower therefore queues 2,331 tasks, once: dedupe keys stop
    // duplicates and later scans queue only postings that are new or still have no text. That
    // cost is accepted rather than capped, because a silent cap would hide roles from the gate.
    if (!row.descriptionText && (admitted.length || deferred.has(row.url))) descriptionQueue.add(row.id);
    // A role whose description is on its way is scored once, when the text lands: the
    // description task re-runs every follower's gate and queues the score then, text or no text.
    // Scoring it now on the title alone would pay for the same role twice.
    else for (const userId of admitted) scoreQueue.push({ userId, jobId: row.id });
  };
  const adopted: Admissible[] = [];
  for (const { job, insert } of adoptions) {
    const fields = {
      title: insert.title,
      url: insert.url,
      location: insert.location ?? job.location,
      locations: insert.locations ?? (insert.location ? [insert.location] : job.locations),
      department: insert.department ?? job.department,
      remote: insert.remote ?? job.remote,
    };
    await deps.db.update(schema.jobs).set({
      sourceId: source.id,
      externalKey: insert.externalKey,
      // From here it belongs to the listing, and `added_by` stays: the person who found it keeps
      // the credit, and their view of it keeps its place. The company's own listing carries it, so
      // it is the company's posting, shared like any other, even if it was pasted from elsewhere.
      origin: "scan",
      shared: true,
      lastSeenAt: deps.now(),
      missingScans: 0,
      firstMissedAt: null,
      status: "open",
      closedAt: null,
      ...fields,
      normalizedTitle: normalizeTitle(insert.title),
      employmentType: insert.employmentType ?? job.employmentType,
      salaryText: insert.salaryText ?? job.salaryText,
      postedAt: insert.postedAt ?? job.postedAt,
      updatedAt: deps.now(),
    }).where(eq(schema.jobs.id, job.id));
    await deps.db.insert(schema.jobEvents).values({ jobId: job.id, type: "updated", payload: { action: "adopted", method: fetchMethod } });
    adopted.push({ id: job.id, ...fields, descriptionText: job.descriptionText });
  }
  for (let offset = 0; offset < newRows.length; offset += 100) {
    const created = await deps.db.insert(schema.jobs).values(newRows.slice(offset, offset + 100)).onConflictDoNothing()
      .returning({ id: schema.jobs.id, url: schema.jobs.url, title: schema.jobs.title, department: schema.jobs.department, location: schema.jobs.location, locations: schema.jobs.locations, remote: schema.jobs.remote, descriptionText: schema.jobs.descriptionText });
    newCount += created.length;
    if (created.length) await deps.db.insert(schema.jobEvents).values(created.map(row => ({ jobId: row.id, type: "discovered" as const, payload: { method: fetchMethod, seeded: isFirstScan } })));
    for (const row of created) admit(row, isFirstScan);
  }
  // An adopted role is new to every follower but whoever pasted it, so each follower without a
  // view of it meets it now, exactly as they would a new posting, rather than a day later.
  if (adopted.length) {
    const held = new Set((await deps.db.select({ userId: schema.userJobs.userId, jobId: schema.userJobs.jobId }).from(schema.userJobs)
      .where(inArray(schema.userJobs.jobId, adopted.map(row => row.id)))).map(view => `${view.userId}:${view.jobId}`));
    for (const row of adopted) admit(row, false, userId => held.has(`${userId}:${row.id}`));
  }

  // Refresh every observed posting, including fields the identity reconciliation does not compare.
  const observed = new Map(keyPostings(postings).keyed.map((p) => [p.externalKey, p]));
  const updates: Array<Record<string, unknown>> = [];
  const descriptionWrites: Array<Record<string, unknown>> = [];
  // Rows whose description the listing gave again unchanged: their `description_fetched_at` moves
  // with `last_seen_at`, in the one write every seen row gets anyway.
  const descriptionConfirmed: string[] = [];
  const updateEvents: Array<typeof schema.jobEvents.$inferInsert> = [];
  const seenIds = new Set(result.seen);
  const seenRows = existingRows.filter((j) => seenIds.has(j.id));
  // Stored text is only read for a gate that matches on it, and only where the listing gave none.
  // The copy taken before the listing was fetched is topped up for any row a `fetch_description`
  // task has written since, and for every row when no follower read descriptions back then.
  const readsDescriptionsNow = followers.some(f => f.gate.matchesDescription);
  const savedTextByKey = new Map(savedText);
  const restale = readsDescriptionsNow ? seenRows.filter(j => observed.get(j.externalKey)!.descriptionText === undefined
    && (!savedTextByKey.has(j.externalKey) || (j.descriptionFetchedAt !== null && j.descriptionFetchedAt > descriptionsReadAt))) : [];
  for (let offset = 0; offset < restale.length; offset += 1000) {
    const fresh = await deps.db.select({ externalKey: schema.jobs.externalKey, text: schema.jobs.descriptionText })
      .from(schema.jobs).where(inArray(schema.jobs.id, restale.slice(offset, offset + 1000).map(j => j.id)));
    for (const row of fresh) savedTextByKey.set(row.externalKey, row.text);
  }
  // Only what the comparison below needs: a popular company's views are tens of thousands of rows.
  const views = seenRows.length && followers.length
    ? await deps.db.select({
        userId: schema.userJobs.userId, jobId: schema.userJobs.jobId, inTable: schema.userJobs.inTable, nearMiss: schema.userJobs.nearMiss,
        keywordMatched: schema.userJobs.keywordMatched, keywordTerms: schema.userJobs.keywordTerms, excluded: schema.userJobs.excluded,
        locationOk: schema.userJobs.locationOk, fitScore: schema.userJobs.fitScore, scoredAt: schema.userJobs.scoredAt,
        archivedAt: schema.userJobs.archivedAt, gateArchivedAt: schema.userJobs.gateArchivedAt, addedByUrl: schema.userJobs.addedByUrl,
      }).from(schema.userJobs).where(and(inArray(schema.userJobs.jobId, seenRows.map(j => j.id)), inArray(schema.userJobs.userId, followers.map(f => f.userId))))
    : [];
  const viewByKey = new Map(views.map(v => [`${v.userId}:${v.jobId}`, v]));
  const viewUpdates: ViewUpdate[] = [];
  for (const row of seenRows) {
    const job = row;
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
    };
    const changedFields: string[] = (Object.keys(fields) as Array<keyof typeof fields>).filter((key) => JSON.stringify(fields[key]) !== JSON.stringify(job[key]));
    // Written only when something moved. A role's row carries its description, up to 30,000
    // characters, and rewriting every observed role every day re-stored all of them for nothing.
    if (changedFields.length) updates.push({ id: job.id, ...fields, normalizedTitle: normalizeTitle(fields.title) });
    // Text this scan read for the role (the listing's own, or a detail page read for admission),
    // as opposed to stored text put back on the posting above to spare a fetch.
    const freshText = posting.descriptionText !== undefined && !reusedDescriptions.has(posting.url) ? posting.descriptionText.slice(0, 30_000) : undefined;
    const freshHash = freshText !== undefined ? sha1(freshText) : undefined;
    // The description is set only from fresh text that differs from what is stored, and only if no
    // `fetch_description` wrote since this commit read the row: a newer stored description wins.
    if (freshText !== undefined && freshHash !== job.descriptionHash) {
      const truncated = posting.descriptionText!.length > 30_000;
      descriptionWrites.push({ id: job.id, text: freshText, hash: freshHash, truncated, prevFetchedAt: job.descriptionFetchedAt });
      changedFields.push("descriptionText");
      if (job.descriptionSource !== "direct") changedFields.push("descriptionSource");
      if (job.descriptionTruncated !== truncated) changedFields.push("descriptionTruncated");
    } else if (freshHash !== undefined || (inlineHash.has(posting.url) && inlineHash.get(posting.url) === job.descriptionHash)) {
      descriptionConfirmed.push(job.id);
    }
    const descriptionText = posting.descriptionText?.slice(0, 30_000) ?? savedTextByKey.get(job.externalKey) ?? null;
    // Whether this scan has the role's text in hand, read or reused, so no detail fetch is needed.
    const textInHand = posting.descriptionText !== undefined || (inlineHash.has(posting.url) && inlineHash.get(posting.url) === job.descriptionHash);
    if (changedFields.length) updateEvents.push({ jobId: job.id, type: "updated", payload: { fields: changedFields } });
    // When the feed carries the vendor's own `updated_at`, that is the refresh rule: the text is
    // re-read when the posting moved and not otherwise. Age only stands in for it where the feed
    // carries nothing — re-reading every stored role every fortnight to learn what `updated_at`
    // already answers costs a board of N roles about N/14 detail fetches a day for nothing.
    const descriptionAged = !job.descriptionFetchedAt || deps.now().getTime() - job.descriptionFetchedAt.getTime() >= 14 * 86_400_000;
    const descriptionMoved = !job.descriptionFetchedAt || (posting.updatedAt ? posting.updatedAt > job.descriptionFetchedAt : descriptionAged);
    for (const follower of followers) {
      const gate = follower.settings.gate;
      if (undecided(posting.url) && needsDescription(gate)) continue;
      const verdict = follower.gate.evaluate({ ...fields, description: follower.gate.matchesDescription ? descriptionText : undefined });
      const view = viewByKey.get(`${follower.userId}:${job.id}`);
      const inTable = inTableFor(verdict, follower.userId, job, view);
      if (view) {
        // A scan leaves `hidden` as it is.
        const update = viewUpdate(follower.userId, job.id, view, viewVerdict(verdict, inTable));
        if (update) viewUpdates.push(update);
        // A view whose scoring completed without a score is not paid for again on unchanged inputs.
        if (inTable && (changedFields.length || !view.inTable || (view.fitScore === null && view.scoredAt === null))) scoreQueue.push({ userId: follower.userId, jobId: job.id });
      } else if (inTable) {
        viewInserts.push(newView(follower.userId, job.id, viewVerdict(verdict, true), false, deps.now()));
        scoreQueue.push({ userId: follower.userId, jobId: job.id });
      } else continue;
      if (inTable && !textInHand && descriptionMoved) descriptionQueue.add(job.id);
    }
    // A stored posting still without text, whose description was never attempted or whose last
    // attempt is 14 days old, is queued again so a description gate is not deferred for ever.
    // A posting whose text is already stored is not in `deferred` and costs nothing here. This one
    // keeps the age rule whatever the feed says: a failed or empty read leaves no text but does
    // move `description_fetched_at`, and `updated_at` will never move on our account.
    if (deferred.has(posting.url) && descriptionAged) descriptionQueue.add(job.id);
  }
  // Being seen is positive evidence in every mode that reconciles: a partial scan that lists a role
  // proves it is still there as surely as an ok one does, so either resets the miss count. What a
  // partial scan may not do is count a miss or close anything, and reconcile() gives it neither.
  if (result.seen.length > 0) {
    const confirmed = descriptionConfirmed.length
      ? sql`case when ${inArray(schema.jobs.id, descriptionConfirmed)} then ${deps.now()}::timestamptz else ${schema.jobs.descriptionFetchedAt} end`
      : undefined;
    for (let offset = 0; offset < result.seen.length; offset += 5000) {
      await deps.db.update(schema.jobs).set({ lastSeenAt: deps.now(), missingScans: 0, firstMissedAt: null, ...(confirmed ? { descriptionFetchedAt: confirmed } : {}) })
        .where(inArray(schema.jobs.id, result.seen.slice(offset, offset + 5000)));
    }
  }
  for (let offset = 0; offset < updates.length; offset += 250) {
    await deps.db.execute(sql`update jobs j set title=v.title, url=v.url, location=v.location, locations=v.locations,
      department=v.department, employment_type=v."employmentType", remote=v.remote, salary_text=v."salaryText", posted_at=v."postedAt",
      normalized_title=v."normalizedTitle", updated_at=${deps.now()}
      from jsonb_to_recordset(${JSON.stringify(updates.slice(offset, offset + 250))}::jsonb) as v(id uuid, title text, url text, location text, locations jsonb,
        department text, "employmentType" text, remote boolean, "salaryText" text, "postedAt" timestamptz, "normalizedTitle" text)
      where j.id=v.id`);
  }
  for (let offset = 0; offset < descriptionWrites.length; offset += 100) {
    await deps.db.execute(sql`update jobs j set description_text=v.text, description_hash=v.hash, description_source='direct',
      description_truncated=v.truncated, description_fetched_at=${deps.now()}, updated_at=${deps.now()}
      from jsonb_to_recordset(${JSON.stringify(descriptionWrites.slice(offset, offset + 100))}::jsonb) as v(id uuid, text text, hash text, truncated boolean, "prevFetchedAt" timestamptz)
      where j.id=v.id and date_trunc('milliseconds', j.description_fetched_at) is not distinct from v."prevFetchedAt"`);
  }
  // A view the gate archived and this listing's gate admits again comes back.
  await writeViewUpdates(deps.db, viewUpdates, deps.now());
  for (let offset = 0; offset < viewInserts.length; offset += 250) await deps.db.insert(schema.userJobs).values(viewInserts.slice(offset, offset + 250)).onConflictDoNothing();
  for (let offset = 0; offset < updateEvents.length; offset += 250) await deps.db.insert(schema.jobEvents).values(updateEvents.slice(offset, offset + 250));
  if (result.reopened.length > 0) {
    await deps.db
      .update(schema.jobs)
      // A reopened role starts its two-miss count afresh, whichever scan saw it. A closed row carries
      // the count that closed it, so leaving that in place would let a single later miss close it again.
      .set({ status: "open", closedAt: null, missingScans: 0, firstMissedAt: null, reopenedCount: sql`${schema.jobs.reopenedCount} + 1` })
      .where(inArray(schema.jobs.id, result.reopened));
    await deps.db.insert(schema.jobEvents).values(result.reopened.map(jobId => ({ jobId, type: "reopened" as const, payload: {} })));
  }
  if (result.missing.length > 0) {
    // The first miss records when it happened; the closing one is measured from it.
    await deps.db
      .update(schema.jobs)
      .set({
        missingScans: sql`${schema.jobs.missingScans} + 1`,
        firstMissedAt: sql`case when ${schema.jobs.missingScans} = 0 then ${deps.now()}::timestamptz else coalesce(${schema.jobs.firstMissedAt}, ${deps.now()}::timestamptz) end`,
      })
      .where(inArray(schema.jobs.id, result.missing));
  }
  if (result.awaitingSeparation.length > 0) {
    // Missed again too soon after the first miss to be a second observation: nothing is counted.
    // A row missed before with no time recorded gets one now, so it can close no sooner than
    // six hours from here.
    await deps.db
      .update(schema.jobs)
      .set({ firstMissedAt: deps.now() })
      .where(and(inArray(schema.jobs.id, result.awaitingSeparation), isNull(schema.jobs.firstMissedAt)));
  }
  if (result.closed.length > 0) {
    await deps.db
      .update(schema.jobs)
      .set({ status: "closed", closedAt: sql`coalesce(${schema.jobs.lastSeenAt}, now())`, missingScans: sql`${schema.jobs.missingScans} + 1` })
      .where(inArray(schema.jobs.id, result.closed));
    await deps.db.insert(schema.jobEvents).values(result.closed.map(jobId => ({ jobId, type: "closed" as const, payload: {} })));
  }

  const [htmlGeneration] = opts.taskId && source.type === "html"
    ? await deps.db.select().from(schema.htmlScanGenerations)
      .where(and(eq(schema.htmlScanGenerations.taskId, opts.taskId), eq(schema.htmlScanGenerations.sourceId, source.id))).for("update").limit(1)
    : [];
  const metricsComplete = !htmlGeneration || (htmlGeneration.metricsComplete && (opts.taskAttempt ?? 1) <= 1);
  const activeDurationMs = (htmlGeneration?.activeDurationMs ?? 0) + Date.now() - started;
  const observedStartedAt = htmlGeneration?.startedAt ?? startedAt;
  await deps.db.insert(schema.scans).values({
    scanRunId,
    sourceId: source.id,
    taskId: opts.taskId,
    startedAt: observedStartedAt,
    finishedAt: deps.now(),
    status,
    fetchMethod,
    postingsFound: postings.length,
    newCount,
    closedCount: result.closed.length,
    error,
    durationMs: metricsComplete ? activeDurationMs : null,
    elapsedMs: Math.max(0, deps.now().getTime() - observedStartedAt.getTime()),
    metricsComplete,
    fetchedBytes: metricsComplete ? (htmlGeneration?.fetchedBytes ?? 0) + fetchedBytes : null,
    requests: metricsComplete ? (htmlGeneration?.requests ?? 0) + requests : null,
    revalidated: metricsComplete ? (htmlGeneration?.revalidated ?? 0) + revalidated : null,
    rawSnapshot,
  });
  if (opts.taskId && source.type === "html") await clearHtmlCheckpoint(deps.db, opts.taskId, source.id);

  // Keep bounded debugging evidence from the three most recent source scans.
  await deps.db.execute(sql`update scans set raw_snapshot = null where source_id = ${source.id} and raw_snapshot is not null
    and id not in (select id from scans where source_id = ${source.id} order by started_at desc, id desc limit 3)
    and id not in (select id from scans where source_id = ${source.id} and status='ok' order by started_at desc, id desc limit 1)`);

  // A host that asked us to wait is not a source that failed: its count, its next scan and its
  // status stay exactly as they were.
  const failures = hostBusy ? source.consecutiveFailures : status === "failed" ? source.consecutiveFailures + 1 : 0;
  await deps.db
    .update(schema.careerSources)
    .set({
      consecutiveFailures: failures,
      // Backed off by whole daily runs (1, 2, 4, then 7 days): measured from this scan, which ran
      // some time after its run began, the next run would find it not yet due and add a day.
      nextScanAt: hostBusy ? source.nextScanAt : failures ? new Date(deps.now().getTime() + Math.min(7, 2 ** Math.min(failures - 1, 3)) * 86400000 - BACKOFF_MARGIN_MS) : null,
      status: hostBusy ? source.status : blocked ? "blocked" : failures >= SOURCE_FAILING_AFTER ? "failing" : source.status === "failing" && status === "ok" ? "active" : source.status,
      lastOkScanAt: status === "ok" ? deps.now() : source.lastOkScanAt,
      lastPostingsCount: status === "ok" ? postings.length : source.lastPostingsCount,
      contentHash,
    })
    .where(eq(schema.careerSources.id, source.id));

  // A source that keeps failing, or that suddenly went empty, is worth re-discovering.
  // So is one that shrank and stayed shrunk: three consecutive collapsed scans
  // is a migration in progress, not a quiet week.
  const persistentlyShrunk = settledShrink || (shrunk && (await deps.db.select({ error: schema.scans.error, status: schema.scans.status }).from(schema.scans)
    .where(eq(schema.scans.sourceId, source.id)).orderBy(desc(schema.scans.startedAt)).limit(3))
    .filter((scan) => scan.status === "partial" && /shrank/.test(scan.error ?? "")).length >= 3);
  if ((failures >= SOURCE_FAILING_AFTER && !hostBusy) || status === "suspect_empty" || persistentlyShrunk) {
    await enqueueStandard(deps.db, "discover", { companyId: company.id, reason: status === "suspect_empty" ? "suspect_empty" : persistentlyShrunk ? "shrunk" : "failing" });
  }

  // Scoring is per account. Leave roles visible when the model is unavailable or this account has
  // no room, but record that reason instead of promising an indefinite pending score. Only the
  // accounts with something to score are asked, all in one read; futile tasks are not queued.
  const scoreSettings = new Map(followers.map(follower => [follower.userId, follower.settings] as const));
  for (let offset = 0; offset < scoreQueue.length; offset += 250)
    await admitScores(deps, scoreQueue.slice(offset, offset + 250), { db: deps.db, onlyUnscored: true, settings: scoreSettings });
  await enqueueTasks(deps.db, [...descriptionQueue].map(jobId => taskRow("fetch_description", { jobId })));

  log.info("source scanned", {
    company: company.name,
    type: source.type,
    status,
    postings: postings.length,
    new: newCount,
    closed: result.closed.length,
    followers: followers.length,
    deferredDescriptions: deferred.size,
    reusedListing,
    claimFetchedBytes: fetchedBytes,
    claimRequests: requests,
    claimRevalidated: revalidated,
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
    ms: Date.now() - started,
  });
  return { status, newCount, closedCount: result.closed.length, postingsFound: postings.length };
  }

}

/**
 * The same digest as `sha1` over the captures joined with "|", fed one capture at a time: joining
 * a render's pages into one string copied every one of them again just to hash it.
 */
function appendCaptureHash(hash: ReturnType<typeof createHash>, html: string, index: number): void {
  if (index) hash.update("|");
  hash.update(html);
}

/**
 * Evidence kept for the last three scans of a source. Version 2 stores every
 * parsed posting (title, url, location, ids) plus a bounded head of each raw
 * response; version 1 stored raw bodies up to 2MB, which for a large feed was
 * the first 5% of the listing and nothing anyone could replay.
 */
function snapshotFor(postings: RawPosting[], responses: Array<{ url: string; status: number; body: string }>, htmlPages: CachedHtmlPage[], listingHash?: string, inlineHash?: Map<string, string>) {
  return {
    version: 2,
    listingHash,
    // `descriptionHash` is the text the listing itself carried for the role, when it carried any.
    postings: postings.map(p => ({ externalId: p.externalId, title: p.title, url: p.url, location: p.location, locations: p.locations, department: p.department, postedAt: p.postedAt, updatedAt: p.updatedAt, descriptionHash: inlineHash?.get(p.url) })),
    responses: responses.map(r => ({ url: r.url, status: r.status, bytes: r.body.length, head: r.body.slice(0, 20_000) })),
    htmlPages,
  };
}

/** A posting as the snapshot holds it: JSON, so every date has been through a string. */
type SnapshotPosting = Omit<RawPosting, "postedAt" | "updatedAt"> & { postedAt?: string; updatedAt?: string; descriptionHash?: string };

/** A posting revived from a snapshot, still carrying the hash of the text its listing carried. */
type StoredPosting = RawPosting & { descriptionHash?: string };

interface StoredSnapshot {
  /** The hash of the listing body these postings were parsed from, when it was large enough to be
   * revalidated at all. Reuse is allowed only against bytes that hash to this. */
  listingHash?: string;
  /** The listing exactly as the last successful scan parsed it. */
  postings: StoredPosting[];
  /** That scan's per-page HTML cache, carried forward so reusing it costs the next scan nothing. */
  htmlPages: CachedHtmlPage[];
}

function revivePosting(p: SnapshotPosting): StoredPosting {
  return { ...p, postedAt: p.postedAt ? new Date(p.postedAt) : undefined, updatedAt: p.updatedAt ? new Date(p.updatedAt) : undefined };
}

/**
 * The compressed evidence kept with this source's last successful scan. `null` when there is none,
 * when the prune above dropped it, or when it cannot be read: every caller then fetches and parses
 * normally, so a missing snapshot costs a re-read and never a wrong listing.
 */
async function readLastOkSnapshot(deps: WorkerDeps, sourceId: string): Promise<StoredSnapshot | null> {
  const [last] = await deps.db.select({ rawSnapshot: schema.scans.rawSnapshot }).from(schema.scans)
    .where(and(eq(schema.scans.sourceId, sourceId), eq(schema.scans.status, "ok"))).orderBy(desc(schema.scans.startedAt)).limit(1);
  if (!last?.rawSnapshot) return null;
  try {
    const snapshot = JSON.parse(gunzipSync(Buffer.from(last.rawSnapshot, "base64"), { maxOutputLength: 8_000_000 }).toString()) as {
      version?: number;
      listingHash?: string;
      postings?: SnapshotPosting[];
      htmlPages?: Array<Omit<CachedHtmlPage, "postings"> & { postings?: SnapshotPosting[] }>;
    };
    // Version 1 stored raw bodies and no parsed listing; its per-page cache is still usable.
    if (snapshot.version !== 1 && snapshot.version !== 2) return null;
    return {
      listingHash: typeof snapshot.listingHash === "string" ? snapshot.listingHash : undefined,
      postings: (Array.isArray(snapshot.postings) ? snapshot.postings : [])
        .filter((p): p is SnapshotPosting => typeof p?.title === "string" && typeof p?.url === "string")
        .map(revivePosting),
      htmlPages: (Array.isArray(snapshot.htmlPages) ? snapshot.htmlPages : [])
        .map(page => ({ ...page, postings: (page.postings ?? []).map(revivePosting) })),
    };
  } catch {
    return null;
  }
}

interface CachedHtmlPage {
  url: string;
  contentHash: string;
  postings: RawPosting[];
  /** Hash of the page as plain HTTP served it, before any browser render. */
  httpHash?: string;
  /** When a browser rendered this page, kept with the snapshot for provenance. */
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
  nextPageUrl?: string;
  continueAt?: Date;
  pagesStaged?: number;
  longListing?: boolean;
}

function checkpointPostings(checkpoint: HtmlCheckpoint): RawPosting[] {
  return keyPostings(checkpoint.pages.flatMap(page => (page.postings as SnapshotPosting[]).map(revivePosting))).keyed;
}

/** A content nonce is not a changed board. Compare the parsed role set and the continuation. */
function htmlPageRoleSetHash(postings: RawPosting[]): string {
  const roles = postings.map(p => [normalisePostingUrl(p.url), p.externalId ?? "", p.title,
    p.location ?? "", p.locations ?? [], p.department ?? "", p.employmentType ?? "",
    p.postedAt?.toISOString() ?? ""])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha1(JSON.stringify(roles));
}

function htmlPageSemanticHash(postings: RawPosting[], nextUrl: string | null): string {
  return sha1(JSON.stringify([htmlPageRoleSetHash(postings), nextUrl]));
}

/** Only an explicit listing result count is useful as a lower bound, never a generic page number. */
function htmlAdvertisedMinimum(html: string): number {
  const text = stripHtml(html).replace(/\s+/g, " ");
  const matches = [...text.matchAll(/\b\d{1,6}\s*(?:-|–|—|to)\s*\d{1,6}\s+of\s+(\d{1,7})\+?\s+(?:results?|jobs?|roles?|positions?|openings?)\b/gi)];
  return Math.max(0, ...matches.map(match => Number(match[1])));
}

function htmlNextUrl(page: HtmlScanOutcome, url: string): string | null {
  return page.nextPageUrl ?? (page.traversed ? null : ats.nextListingPage(page.html ?? "", page.finalUrl ?? url));
}

/** Exactly one HTTP batch per task claim. Browser-expanded listings retain their existing path. */
async function scanHtmlSourceContinued(deps: WorkerDeps, spec: SourceSpec, source: CareerSource, ctx: FetchContext,
  lastOkSnapshot: () => Promise<StoredSnapshot | null>, taskId: string, claimStartedAtMs: number): Promise<HtmlScanOutcome> {
  let checkpoint = await loadHtmlCheckpoint(deps, taskId, source);
  const cached = (await lastOkSnapshot())?.htmlPages ?? [];
  const partial = (reason: string, extra: RawPosting[] = []): HtmlScanOutcome => ({
    postings: keyPostings([...checkpointPostings(checkpoint), ...extra]).keyed, method: "http", dropped: checkpoint.pages.reduce((n, p) => n + p.dropped, 0),
    contentHash: sha1(checkpoint.pages.map(p => p.contentHash).join("|")), unchanged: false,
    // The snapshot needs the full posting set once, not a second copy in per-page HTML evidence.
    pages: [], incomplete: true, incompleteReason: reason,
  });
  const terminal = (): HtmlScanOutcome => ({
    postings: checkpointPostings(checkpoint), method: "http", dropped: checkpoint.pages.reduce((n, p) => n + p.dropped, 0),
    contentHash: sha1(checkpoint.pages.map(p => p.contentHash).join("|")), unchanged: false,
    // Small pages keep the existing no-AI extraction cache. Large generations omit this second
    // posting copy from the pruned snapshot; their bounded checkpoint is removed on final commit.
    pages: checkpoint.pages.length <= HTML_PAGES_PER_TASK_PASS
      ? checkpoint.pages.map(page => ({ url: page.url, contentHash: page.contentHash,
        postings: (page.postings as SnapshotPosting[]).map(revivePosting) })) : [],
    recipe: checkpoint.pages.find(p => p.recipe)?.recipe as HtmlRecipe | undefined,
    longListing: checkpoint.pages.length > HTML_PAGES_PER_TASK_PASS,
  });
  if (checkpoint.expired) return partial("HTML listing continuation expired before all pages could be verified; roles remain open.");

  // A deferred task does not treat yesterday's first page and today's tail as one generation.
  // Re-read both ends; raw HTML can change harmlessly, so compare semantic evidence and next URL.
  if (checkpoint.pages.length) {
    const boundaries = [checkpoint.pages[0]!, checkpoint.pages.at(-1)!].filter((p, i, list) => i === 0 || p.pageIndex !== list[0]!.pageIndex);
    let changed = false;
    for (const stored of boundaries) {
      try {
        const observed = await scanHtmlPage(deps, { ...spec, url: stored.url }, source, ctx, cached.find(p => p.url === stored.url));
        const next = htmlNextUrl(observed, stored.url);
        if (observed.method !== "http" || observed.incomplete || htmlPageSemanticHash(observed.postings, next) !== stored.semanticHash) changed = true;
      } catch (error) {
        if (error instanceof HostBusyError) throw error;
        return partial(`HTML listing boundary could not be revalidated: ${(error as Error).message}`.slice(0, 1000));
      }
    }
    if (changed) {
      checkpoint = await restartHtmlCheckpoint(deps, checkpoint, source);
      if (checkpoint.expired) return partial("HTML listing changed repeatedly during continuation; no complete generation was observed.");
    }
  }

  let readThisPass = 0;
  while (checkpoint.generation.nextUrl) {
    if (Date.now() - claimStartedAtMs >= HTML_CLAIM_FETCH_BUDGET_MS) {
      return { ...partial("HTML listing continues after this claim's time budget."), continueAt: new Date(deps.now().getTime() + 1000), pagesStaged: checkpoint.pages.length };
    }
    const url = checkpoint.generation.nextUrl;
    if (checkpoint.pages.some(page => page.url === url)) return partial("HTML listing repeated a pagination URL; the remaining pages cannot be verified.");
    if (checkpoint.pages.length >= HTML_GENERATION_MAX_PAGES) return partial("HTML listing exceeded the bounded page limit before its final page.");
    if (checkpointPostings(checkpoint).length >= HTML_GENERATION_MAX_POSTINGS) return partial("HTML listing exceeded the bounded posting limit before its final page.");
    let page: HtmlScanOutcome;
    try {
      page = await scanHtmlPage(deps, { ...spec, url }, source, ctx, cached.find(p => p.url === url));
    } catch (error) {
      if (checkpoint.pages.length === 0) throw error;
      if (error instanceof HostBusyError) throw error;
      return partial(`Could not finish listing page ${url}: ${(error as Error).message}`.slice(0, 1000));
    }
    if (page.method === "browser" || page.traversed) {
      if (checkpoint.pages.length === 0) return scanHtmlSource(deps, spec, source, ctx, lastOkSnapshot, undefined, page);
      return partial("HTML listing switched to browser traversal after staged HTTP pages; the complete listing could not be verified.", page.postings);
    }
    const next = htmlNextUrl(page, url);
    if (page.incomplete) return partial(page.incompleteReason ?? "HTML listing page was incomplete.", page.postings);
    if (next && (next === url || checkpoint.pages.some(saved => saved.url === next))) {
      return partial("HTML listing pagination repeated an earlier page; the complete listing cannot be verified.", page.postings);
    }
    const semanticHash = htmlPageSemanticHash(page.postings, next);
    const roleSetHash = htmlPageRoleSetHash(page.postings);
    if (checkpoint.pages.some(saved => saved.roleSetHash === roleSetHash && saved.url !== url)) {
      return partial("HTML listing returned duplicate roles at different offsets; the complete listing cannot be verified.", page.postings);
    }
    try {
      checkpoint = await appendHtmlCheckpointPage(deps, checkpoint, source, {
        url, nextUrl: next, contentHash: page.contentHash, semanticHash, roleSetHash,
        minAdvertised: htmlAdvertisedMinimum(page.html ?? ""),
        postings: page.postings as unknown as Record<string, unknown>[], dropped: page.dropped,
        recipe: page.recipe as Record<string, unknown> | undefined,
      });
    } catch (error) {
      if (!(error instanceof HtmlCheckpointChanged)) throw error;
      return partial(error.message, page.postings);
    }
    readThisPass += 1;
    if (next && readThisPass >= HTML_PAGES_PER_TASK_PASS) {
      return { ...partial("HTML listing continues in another task claim."), continueAt: new Date(deps.now().getTime() + 1000), pagesStaged: checkpoint.pages.length };
    }
  }
  if (checkpointPostings(checkpoint).length < checkpoint.generation.minAdvertised) {
    return partial(`Listing advertised at least ${checkpoint.generation.minAdvertised} results but only ${checkpointPostings(checkpoint).length} distinct roles were verified.`);
  }
  return terminal();
}

/**
 * Tier-3 HTML: try the stored selector recipe first, then embedded structure, then the model.
 * A model extraction also produces a recipe, so later scans of an unchanged page cost nothing.
 */
async function scanHtmlSource(deps: WorkerDeps, spec: SourceSpec, source: CareerSource, ctx: FetchContext, lastOkSnapshot: () => Promise<StoredSnapshot | null>, taskId?: string, firstPage?: HtmlScanOutcome, claimStartedAtMs = Date.now()): Promise<HtmlScanOutcome> {
  if (taskId) return scanHtmlSourceContinued(deps, spec, source, ctx, lastOkSnapshot, taskId, claimStartedAtMs);
  // Missing or unreadable snapshots trigger fresh extraction.
  const cached: CachedHtmlPage[] = (await lastOkSnapshot())?.htmlPages ?? [];
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
      const page: HtmlScanOutcome = pages.length === 0 && firstPage ? firstPage : await scanHtmlPage(deps, { ...spec, url }, source, ctx, cached.find(p => p.url === url));
      if (page.method === "browser") method = "browser";
      dropped += page.dropped;
      unchanged = unchanged && page.unchanged;
      recipe ??= page.recipe;
      pages.push({ url, contentHash: page.contentHash, postings: page.postings, httpHash: page.httpHash, renderedAt: page.renderedAt });
      incomplete ||= page.incomplete ?? false;
      incompleteReason ??= page.incompleteReason;
      url = page.nextPageUrl ?? (page.traversed ? null : ats.nextListingPage(page.html ?? "", page.finalUrl ?? url));
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

const BROWSER_PAGINATION_INCOMPLETE = "Browser pagination could not complete; a control was blocked, did not advance, or reached its limit.";

async function scanHtmlPage(deps: WorkerDeps, spec: SourceSpec, source: CareerSource, ctx: FetchContext, cached?: CachedHtmlPage, supplied?: { html: string; url: string }): Promise<HtmlScanOutcome> {
  let html: string;
  let finalUrl = spec.url;
  let method: "http" | "browser" = "http";

  const page = supplied ?? await ats.fetchHtmlPage(spec, ctx);
  html = page.html;
  finalUrl = page.url;

  let postings = ats.extractPostingsFromHtml(html, finalUrl, spec.recipe);
  const httpHash = supplied ? undefined : sha1(html.replace(/\s+/g, " "));
  const expansionPending = !supplied && !ats.nextListingPage(html, finalUrl) && ats.hasListingExpansionControl(html, finalUrl);
  const wantsRender = !supplied && ctx.render && (postings.length === 0 || expansionPending);
  // The first HTTP page cannot prove that later browser-expanded pages are unchanged. Render
  // every scan that needs expansion; a cached full listing could miss a new role for days.
  if (wantsRender) {
    // Through the scan's context, not the browser directly, so a render counts as a request and
    // its bytes against this scan like any other fetch.
    const rendered = await ctx.render!(spec.url, { scrollAndExpand: true });
    if (rendered.status !== null && rendered.status >= 400) {
      // Same rule as the fetcher's.
      throw new SourceFetchError(`Browser returned HTTP ${rendered.status}`, statusKind(rendered.status), rendered.status);
    }
    // A browser may capture the same 1,000 roles on every page. Keep one posting per source
    // identity, with a separate byte ceiling for unusually large descriptions/metadata.
    const maxCapturedMetadataBytes = 4_000_000;
    const capturedByKey = new Map<string, { posting: RawPosting; bytes: number }>();
    let capturedMetadataBytes = 0;
    let verifiedCaptureCount = 0;
    let dropped = 0;
    let postingCapExceeded = false;
    const addCaptured = (items: RawPosting[]) => {
      for (const item of items) {
        const key = deriveExternalKey(item);
        const previous = capturedByKey.get(key);
        if (previous) {
          const locations = new Set([...(previous.posting.locations ?? []), ...(previous.posting.location ? [previous.posting.location] : []),
            ...(item.locations ?? []), ...(item.location ? [item.location] : [])]);
          const merged = { ...previous.posting, locations: [...locations], remote: previous.posting.remote || item.remote || [...locations].some(looksRemote) || undefined };
          const bytes = Buffer.byteLength(JSON.stringify(merged), "utf8");
          if (capturedMetadataBytes - previous.bytes + bytes > maxCapturedMetadataBytes) postingCapExceeded = true;
          else {
            capturedMetadataBytes += bytes - previous.bytes;
            capturedByKey.set(key, { posting: merged, bytes });
          }
        } else {
          const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
          if (capturedByKey.size >= ats.MAX_POSTINGS || capturedMetadataBytes + bytes > maxCapturedMetadataBytes) postingCapExceeded = true;
          else {
            capturedByKey.set(key, { posting: { ...item }, bytes });
            capturedMetadataBytes += bytes;
          }
        }
        if (postingCapExceeded) break;
      }
    };
    let incomplete = rendered.incomplete ?? false;
    let incompleteReason = incomplete ? BROWSER_PAGINATION_INCOMPLETE : undefined;
    // Browser controls may not expose a document-head rel=next link to the renderer. Keep
    // explicit HTTP and rendered next links, then resume the ordinary page traversal from the
    // first page the browser has not already captured. A later capture may itself point onward.
    const capturedUrls = new Set([new URL(finalUrl).href]);
    const continuations = [ats.nextListingPage(html, finalUrl)];
    let advertisedTotal = ats.advertisedDistinctJobTotal(html) ?? 0;
    let externalContinuation = ats.hasUnfollowableListingContinuation(html, finalUrl);
    let lastExpansionPending = false;
    const captureHash = createHash("sha1");
    const captureCount = listingCaptureCount(rendered);
    let captureIndex = 0;
    try {
      for (const capture of listingCaptures(rendered)) {
        const index = captureIndex++;
        advertisedTotal = Math.max(advertisedTotal, ats.advertisedDistinctJobTotal(capture.html) ?? 0);
        appendCaptureHash(captureHash, capture.html, index);
        capturedUrls.add(new URL(capture.url).href);
        const nextCaptured = ats.nextListingPage(capture.html, capture.url);
        continuations.push(nextCaptured);
        externalContinuation ||= ats.hasUnfollowableListingContinuation(capture.html, capture.url);
        lastExpansionPending = !nextCaptured && ats.hasListingExpansionControl(capture.html, capture.url);
        try {
          const outcome = await scanHtmlPage(deps, spec, source, ctx, captureCount === 1 ? cached : undefined, capture);
          // Only parsed postings and counts survive this iteration; never retain all decoded DOMs.
          if (outcome.postings.length === 0 && captureCount > 1 && (verifiedCaptureCount > 0 || index < captureCount - 1)) {
            incomplete = true;
            incompleteReason ??= "A browser listing capture was empty after or before a populated capture; this scan cannot close roles.";
          }
          addCaptured(outcome.postings);
          verifiedCaptureCount++;
          dropped += outcome.dropped;
          incomplete ||= outcome.incomplete ?? false;
          incompleteReason ??= outcome.incompleteReason;
        } catch (error) {
          // A shell before later confirmed roles is allowed; one after roles is incomplete.
          if (!verifiedCaptureCount && index < captureCount - 1 && error instanceof SourceFetchError && error.kind === "parse") continue;
          if (!verifiedCaptureCount) throw error;
          incomplete = true;
          incompleteReason ??= `Browser listing capture ${index + 1} could not be verified: ${(error as Error).message}`.slice(0, 1000);
        }
        if (postingCapExceeded) { incomplete = true; break; }
      }
    } catch (error) {
      // A corrupt compressed capture is never a complete listing. Retain already parsed captures
      // and the HTTP first page so a partial scan can still surface useful roles.
      if (!(error instanceof SourceFetchError && error.kind === "parse")) throw error;
      incomplete = true;
      incompleteReason ??= `Browser listing capture could not be decoded: ${error.message}`.slice(0, 1000);
    }
    if (externalContinuation) {
      incomplete = true;
      incompleteReason ??= "Listing has an explicit next page outside this source; the remaining roles could not be verified.";
    }
    if (lastExpansionPending) {
      incomplete = true;
      incompleteReason ??= "The final browser capture still has an expansion control; the remaining roles could not be verified.";
    }
    if (postingCapExceeded) incompleteReason ??= "The browser listing exceeded its posting or parsed-metadata limit; remaining roles could not be verified.";
    const nextPageUrl = postingCapExceeded ? undefined : continuations.find(next => next !== null && !capturedUrls.has(new URL(next).href)) ?? undefined;
    const capturedPostings = [...capturedByKey.values()].map(value => value.posting);
    if (capturedPostings.length < advertisedTotal) {
      incomplete = true;
      incompleteReason ??= `Listing advertised ${advertisedTotal} distinct jobs but only ${capturedPostings.length} were verified.`;
    }
    return { postings: keyPostings(incomplete ? [...postings, ...capturedPostings] : capturedPostings).keyed,
      method: "browser", dropped,
      contentHash: captureIndex ? captureHash.digest("hex") : httpHash ?? sha1(html), unchanged: false, httpHash, renderedAt: deps.now().toISOString(), incomplete,
      incompleteReason: incomplete ? incompleteReason ?? BROWSER_PAGINATION_INCOMPLETE : undefined, traversed: true, nextPageUrl };

  }

  const contentHash = httpHash ?? sha1(html.replace(/\s+/g, " "));
  const unchanged = contentHash === cached?.contentHash;

  if (postings.length === 0 && unchanged && cached?.postings.length) postings = cached.postings;
  const unfollowableContinuation = ats.hasUnfollowableListingContinuation(html, finalUrl);
  if (postings.length > 0) return { postings, method, dropped: 0, contentHash, unchanged, html, finalUrl, httpHash,
    incomplete: expansionPending || unfollowableContinuation,
    incompleteReason: expansionPending ? "Listing has an expansion control but browser rendering is unavailable; this scan cannot close roles."
      : unfollowableContinuation ? "Listing has an explicit next page outside this source; the remaining roles could not be verified." : undefined };
  if (ats.isExplicitEmptyListing(html, finalUrl)) {
    return { postings: [], method, dropped: 0, contentHash, unchanged, html, finalUrl, httpHash,
      incomplete: unfollowableContinuation,
      incompleteReason: unfollowableContinuation ? "Listing has an explicit next page outside this source; the remaining roles could not be verified." : undefined };
  }
  if (unchanged || !deps.ai.enabled) {
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

  const visibleUrls = new Set(compact.knownUrls.map(normalisePostingUrl));
  const modelUrls = new Set(modelPostings.map(posting => normalisePostingUrl(posting.url)));
  const omittedVisiblePrevious = (cached?.postings ?? []).filter(posting => {
    const url = normalisePostingUrl(posting.url);
    return visibleUrls.has(url) && !modelUrls.has(url);
  });
  const incomplete = compact.truncated || omittedVisiblePrevious.length > 0 || expansionPending || unfollowableContinuation;
  const incompleteReason = compact.truncated
    ? "Model extraction used a truncated listing representation; this scan cannot prove the complete set of postings."
    : omittedVisiblePrevious.length > 0
      ? `Model extraction omitted ${omittedVisiblePrevious.length} previously observed posting URL(s) still visible on the listing; this scan cannot close roles.`
      : expansionPending
        ? "Listing has an expansion control but browser rendering is unavailable; this scan cannot close roles."
        : unfollowableContinuation
          ? "Listing has an explicit next page outside this source; the remaining roles could not be verified."
          : undefined;

  let recipe: HtmlRecipe | undefined;
  if (extraction.recipe && !incomplete) {
    const validation = ats.validateRecipe(html, finalUrl, extraction.recipe, modelPostings);
    if (validation.ok) recipe = extraction.recipe;
    else log.info("model recipe rejected", { url: finalUrl, coverage: validation.coverage });
  }
  return { postings: modelPostings, method, dropped: extraction.dropped, contentHash, unchanged, recipe, html, finalUrl,
    incomplete,
    incompleteReason };
}

export { scanSource as _scanSourceForTests };
