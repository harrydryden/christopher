/**
 * One posting a follower pasted the URL of.
 *
 * The scan reads listings; this reads a single detail page, for the role the listing never
 * carried — a board page the adapter cannot parse, a role linked from an email, a posting behind
 * a site the scan gave up on. The row it stores is shared like any other observed posting, so
 * every follower's gate is offered it; the difference is `origin = 'user'`, which keeps a scan
 * from ever counting it missing (it was never in a listing to go missing from) until a scan
 * observes the same URL and adopts it.
 *
 * Nothing here retries a reason the person has to act on. A page that is not a posting, a company
 * nobody follows any more, a catalogue entry with no careers source: those finish `done` with a
 * sentence the interface shows. Only a transport failure throws, because only a transport failure
 * is worth the queue's backoff.
 */
import { schema, enqueueTask, reevaluateGate, type Db, type Task } from "@ava/db";
import {
  ats,
  dedupeKeyFor,
  evaluateGate,
  extractPostingFromPage,
  looksRemote,
  normalisePostingUrl,
  normalizeTitle,
  priorityFor,
  sha1,
  SourceFetchError,
  stripHtml,
  type AppSettings,
  type GateResult,
  type TaskPayloads,
} from "@ava/core";
import { and, eq, ne } from "drizzle-orm";
import { makeFetchContext, type WorkerDeps } from "../context";
import { log } from "../log";

const MAX_DESCRIPTION = 30_000;

/** Below this the stored text is a stub, and the description fetch (adapter, page, model) is worth a go. */
const SHORT_DESCRIPTION = 200;

/** A page with less text than this is a shell waiting for JavaScript, not a posting. */
const JS_SHELL_TEXT = 400;

/** What the interface shows about the gate, whether or not the role went into the table anyway. */
interface GateSummary {
  inTable: boolean;
  keywordMatched: boolean;
  locationOk: boolean;
  excluded: boolean;
  keywordTerms: string[];
}

export type ImportResult =
  | { ok: true; jobId: string; title: string; existing: boolean; gate: GateSummary }
  | { ok: false; reason: string };

const summarise = (verdict: GateResult): GateSummary => ({
  inTable: verdict.inTable,
  keywordMatched: verdict.keywordMatched,
  locationOk: verdict.locationOk,
  excluded: verdict.excluded,
  keywordTerms: verdict.keywordTerms,
});

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** How a failed fetch reads in a sentence, so a retried task's `tasks.error` says something useful. */
function transportReason(err: unknown): string {
  if (err instanceof SourceFetchError) {
    switch (err.kind) {
      case "timeout": return "timeout";
      case "blocked": return "the site refused the request";
      case "rate_limited": return "the site asked us to slow down";
      case "parse": return "the page was too large to read";
      case "network": return "network error";
      default: return `HTTP ${err.status ?? "error"}`;
    }
  }
  return (err as Error)?.message ?? "unknown error";
}

export async function handleImportPosting(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, companyId, url } = task.payload as unknown as TaskPayloads["import_posting"];
  const now = deps.now();
  const host = hostOf(url);

  // ---- Reads -------------------------------------------------------------------------------
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1);
  const [subscription] = company
    ? await deps.db
        .select({ id: schema.companySubscriptions.id })
        .from(schema.companySubscriptions)
        .where(and(
          eq(schema.companySubscriptions.userId, userId),
          eq(schema.companySubscriptions.companyId, companyId),
          ne(schema.companySubscriptions.status, "archived"),
        ))
        .limit(1)
    : [];
  if (!company || !subscription) return { ok: false, reason: "You no longer follow this company." } satisfies ImportResult;

  const settings = await deps.userSettings(userId);
  const canonical = normalisePostingUrl(url);
  // Only three columns: a company can have a few thousand postings and the description is the
  // largest thing on the table. The canonical comparison happens here rather than in SQL because
  // it is the same function the row was stored under.
  const stored = await deps.db
    .select({ id: schema.jobs.id, url: schema.jobs.url, title: schema.jobs.title })
    .from(schema.jobs)
    .where(eq(schema.jobs.companyId, companyId));
  const known = stored.find((job) => job.url === url || normalisePostingUrl(job.url) === canonical);
  if (known) {
    return deps.db.transaction(async (tx) => {
      await deps.assertOwnership?.(tx as unknown as Db);
      return adoptExistingView(known.id, { db: tx as unknown as Db }, { userId, settings, now });
    });
  }

  // ---- The page ----------------------------------------------------------------------------
  const ctx = makeFetchContext(deps);
  let html: string | null = null;
  let finalUrl = url;
  let failure: unknown = null;
  try {
    const res = await ctx.fetchText(url, { timeoutMs: 20_000, maxBodyBytes: 3_000_000 });
    // A server having a bad minute is worth another go; a page that is gone or refused is the
    // person's to look at, and no number of retries turns a 404 into a posting.
    if (res.status >= 500) throw new Error(`Could not fetch ${host}: HTTP ${res.status}`);
    if (res.status >= 400) {
      return { ok: false, reason: `The page at ${host} answered HTTP ${res.status}. Check that the link still opens the role.` } satisfies ImportResult;
    }
    html = res.body;
    finalUrl = res.url || url;
  } catch (err) {
    failure = err;
  }
  // A site that refuses the worker serves the page to a browser, and a page that arrived with no
  // text in it is a shell waiting for its JavaScript. Both are what the renderer is for.
  if ((failure || (html !== null && stripHtml(html).length < JS_SHELL_TEXT)) && ctx.render) {
    try {
      const rendered = await ctx.render(url);
      if (rendered.html && (rendered.status === null || rendered.status < 400)) {
        html = rendered.html;
        finalUrl = rendered.finalUrl || finalUrl;
        failure = null;
      }
    } catch (err) {
      log.warn("import render failed", { url, error: (err as Error).message });
    }
  }
  // Worth the queue's backoff, unlike everything else here: the site may simply be having an hour.
  if (html === null) throw new Error(`Could not fetch ${host}: ${transportReason(failure)}`);

  const extracted = extractPostingFromPage(html, finalUrl);
  if (!extracted) {
    return { ok: false, reason: `The page at ${host} does not look like a job posting. Check that the link opens the role itself rather than a listing.` } satisfies ImportResult;
  }

  // The posting belongs to a source, because everything on `jobs` does. The one that matches the
  // pasted URL's own vendor is the truthful home for it; failing that, whichever source this
  // company actually scans.
  const sources = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, companyId));
  const vendor = ats.specFromAnyUrl(url)?.type;
  const source = (vendor ? sources.find((s) => s.type === vendor) : undefined)
    ?? sources.find((s) => s.status === "active")
    ?? sources.find((s) => s.status === "failing")
    ?? sources[0];
  if (!source) {
    return { ok: false, reason: "This company has no careers source yet. Add its careers URL first." } satisfies ImportResult;
  }

  // Every other follower's gate decides for itself whether this role reaches them, so their
  // settings are read here rather than from inside the transaction.
  const others = await deps.db
    .select({ userId: schema.companySubscriptions.userId })
    .from(schema.companySubscriptions)
    .where(and(eq(schema.companySubscriptions.companyId, companyId), ne(schema.companySubscriptions.status, "archived")));
  const followers = await Promise.all(
    others.filter((f) => f.userId !== userId).map(async (f) => ({ userId: f.userId, settings: await deps.userSettings(f.userId) })),
  );

  const descriptionText = extracted.descriptionText?.slice(0, MAX_DESCRIPTION) ?? null;
  const locations = extracted.locations ?? (extracted.location ? [extracted.location] : []);
  // The URL the person pasted is the one they will click again, so a cosmetic redirect does not
  // replace it; a redirect that landed on a different posting URL does.
  const storedUrl = normalisePostingUrl(finalUrl) === canonical ? url : finalUrl;
  const row: typeof schema.jobs.$inferInsert = {
    companyId,
    sourceId: source.id,
    externalKey: `url:${sha1(canonical)}`,
    title: extracted.title,
    normalizedTitle: normalizeTitle(extracted.title),
    url: storedUrl,
    location: extracted.location ?? null,
    locations,
    department: extracted.department ?? null,
    employmentType: extracted.employmentType ?? null,
    remote: extracted.remote ?? looksRemote([extracted.location, ...locations].filter(Boolean).join(" ")),
    salaryText: extracted.salaryText ?? null,
    postedAt: extracted.postedAt ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    seeded: false,
    descriptionText,
    descriptionSource: descriptionText ? "direct" : null,
    descriptionTruncated: (extracted.descriptionText?.length ?? 0) > MAX_DESCRIPTION,
    descriptionHash: descriptionText ? sha1(descriptionText) : null,
    descriptionFetchedAt: descriptionText ? now : null,
    origin: "user",
    addedBy: userId,
  };

  // ---- One transaction ---------------------------------------------------------------------
  return deps.db.transaction(async (tx): Promise<ImportResult> => {
    await deps.assertOwnership?.(tx as unknown as Db);
    const [created] = await tx.insert(schema.jobs).values(row)
      .onConflictDoNothing({ target: [schema.jobs.sourceId, schema.jobs.externalKey] })
      .returning({ id: schema.jobs.id, title: schema.jobs.title });
    // Another import of the same URL got there first — the same posting, not a second one.
    if (!created) {
      const [raced] = await tx.select({ id: schema.jobs.id }).from(schema.jobs)
        .where(and(eq(schema.jobs.sourceId, row.sourceId), eq(schema.jobs.externalKey, row.externalKey))).limit(1);
      if (!raced) throw new Error(`Could not store the posting at ${host}`);
      return adoptExistingView(raced.id, { db: tx as unknown as Db }, { userId, settings, now });
    }
    await tx.insert(schema.jobEvents).values({ jobId: created.id, type: "discovered", payload: { method: "user" } });

    // The person asked for this role by name, so it goes in their table whatever their keywords
    // say. The verdict is still recorded, so the interface can tell them it is an exception.
    const verdict = evaluateGate({
      title: row.title, department: row.department, description: descriptionText,
      location: row.location, locations, remote: row.remote,
    }, settings.gate);
    await tx.insert(schema.userJobs).values({
      userId, jobId: created.id,
      keywordMatched: verdict.keywordMatched, keywordTerms: verdict.keywordTerms,
      excluded: verdict.excluded, locationOk: verdict.locationOk,
      inTable: true, nearMiss: false, seeded: false, createdAt: now, updatedAt: now,
      // The score is queued in the same transaction, so the view says so from the moment it exists.
      scoreState: "queued", scoreStateAt: now,
    }).onConflictDoNothing();
    const scorePayload = { userId, jobId: created.id };
    await enqueueTask(tx, "score_job", scorePayload, { dedupeKey: dedupeKeyFor("score_job", scorePayload), priority: 1 });

    // Everyone else who follows the company meets it as they would any other new posting: their
    // own gate decides, and nothing is forced into anybody else's table.
    for (const follower of followers) {
      await reevaluateGate(tx as unknown as Db, follower.userId, follower.settings, now, { jobId: created.id });
    }

    // A page that gave up a title and little else is worth one more read: the adapter, the page
    // and the cleaning model all have a go at the text this one did not carry.
    if (!descriptionText || descriptionText.length < SHORT_DESCRIPTION) {
      await enqueueTask(tx, "fetch_description", { jobId: created.id }, {
        dedupeKey: dedupeKeyFor("fetch_description", { jobId: created.id }), priority: priorityFor("fetch_description"),
      });
    }

    log.info("posting imported", { company: company.name, userId, jobId: created.id, title: created.title, url: storedUrl, inTable: verdict.inTable, followers: followers.length });
    return { ok: true, jobId: created.id, title: created.title, existing: false, gate: summarise(verdict) };
  });
}

/**
 * The posting is already in the catalogue — this account had not seen it, or pasted it twice.
 * Nothing about the shared row changes; what may be missing is this account's view of it, and
 * having asked for the role by its URL is reason enough to have one.
 */
async function adoptExistingView(
  jobId: string,
  deps: Pick<WorkerDeps, "db">,
  who: { userId: string; settings: AppSettings; now: Date },
): Promise<ImportResult> {
  const { userId, settings, now } = who;
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { ok: false, reason: "That role is no longer in the catalogue." };
  const verdict = evaluateGate({
    title: job.title, department: job.department, description: job.descriptionText,
    location: job.location, locations: job.locations, remote: job.remote,
  }, settings.gate);
  const [view] = await deps.db.select({ userId: schema.userJobs.userId }).from(schema.userJobs)
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))).limit(1);
  if (!view) {
    const inserted = await deps.db.insert(schema.userJobs).values({
      userId, jobId,
      keywordMatched: verdict.keywordMatched, keywordTerms: verdict.keywordTerms,
      excluded: verdict.excluded, locationOk: verdict.locationOk,
      inTable: true, nearMiss: false, seeded: false, createdAt: now, updatedAt: now,
      scoreState: "queued", scoreStateAt: now,
    }).onConflictDoNothing().returning({ userId: schema.userJobs.userId });
    if (inserted.length) {
      const payload = { userId, jobId };
      await enqueueTask(deps.db, "score_job", payload, { dedupeKey: dedupeKeyFor("score_job", payload), priority: 1 });
    }
  }
  return { ok: true, jobId, title: job.title, existing: true, gate: summarise(verdict) };
}
