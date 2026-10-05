import { schema, archiveNonMatches, gateCompiler, gateWithRetainedLocations, inTableFor, newView, viewUpdate, viewVerdict, writeViewUpdates, requestLocationEnrichment, type Task, type ViewUpdate } from "@col/db";
import { ats, extractMainText, sha1, stripHtml, type AppSettings } from "@col/core";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { makeFetchContext } from "../context";
import { loadUserSettingsMany } from "../settings";
import { log } from "../log";
import { admitScores } from "../score-admission";

interface Payload {
  jobId: string;
}

const MAX_DESCRIPTION = 30_000;

/**
 * Fetch and store the job description so it survives the posting being taken down.
 * Feed-supplied descriptions are stored at scan time; this handles sources that need a detail fetch.
 * The text is shared; every follower's gate is re-run against it afterwards.
 */
export async function handleFetchDescription(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { jobId } = task.payload as unknown as Payload;
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { skipped: "job not found" };
  if (!job.sourceId || !job.companyId || !job.url) return { skipped: "manual role has no source to fetch" };
  const companyId = job.companyId;
  const [source] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.id, job.sourceId)).limit(1);
  if (!source) return { skipped: "source not found" };

  const ctx = makeFetchContext(deps);
  let text: string | undefined;
  let descriptionSource: "direct" | "model" = "direct";
  let extra: Partial<typeof schema.jobs.$inferInsert> = {};

  const adapterText = await ats
    .fetchDescriptionFor(
      { type: source.type, url: source.url, apiUrl: source.apiUrl ?? undefined, atsSlug: source.atsSlug ?? undefined, atsSite: source.atsSite ?? undefined },
      { title: job.title, url: job.url, externalId: job.externalKey.replace(/^id:/, "") },
      ctx,
    )
    .catch(() => undefined);
  if (adapterText) text = adapterText;

  if (!text) {
    try {
      const res = await ctx.fetchText(job.url);
      if (res.status < 400) {
        const jsonLd = ats.extractJsonLdPostings(res.body, job.url).find((p) => p.descriptionText);
        text = jsonLd?.descriptionText ?? extractMainText(res.body);
        if ((!text || text.length < 200) && deps.ai.enabled) {
          const rawText = stripHtml(res.body).slice(0, 20_000);
          const cleaned = await deps.ai.cleanDescription({ title: job.title, rawText }, { refType: "job", refId: job.id });
          // The model chooses where the description starts and ends, and the text is the page's own
          // between the two: it is shared with every follower and read by their gates, so the model
          // may cut the page, never write it. An anchor the page does not carry keeps the page's own
          // reading, and none of the model's claims.
          const sliced = cleaned ? sliceBetweenAnchors(rawText, cleaned.startsWith, cleaned.endsWith) : null;
          if (cleaned && sliced) {
            text = sliced;
            descriptionSource = "model";
            extra = { salaryText: cleaned.salaryText ?? job.salaryText, employmentType: cleaned.employmentType ?? job.employmentType, remote: cleaned.remote ?? job.remote };
          } else if (cleaned) {
            log.warn("model description anchors not found on the page; kept the page's own text", { jobId, url: job.url });
          }
        }
      }
    } catch (err) {
      log.warn("description fetch failed", { jobId, url: job.url, error: (err as Error).message });
    }
  }

  const outcome = await deps.db.transaction(async (tx) => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    const db = tx as unknown as WorkerDeps["db"];
    // The gates first, before anything is written: a settings save holds its gate row while it
    // re-evaluates that account's views, so taking the share locks after writing views here could
    // leave each waiting on the other.
    const followers = await tx.select({ userId: schema.companySubscriptions.userId }).from(schema.companySubscriptions)
      .where(and(eq(schema.companySubscriptions.companyId, companyId), ne(schema.companySubscriptions.status, "archived")));
    const allSettings = await loadUserSettingsMany(db, followers.map(f => f.userId), { lockGates: true });
    // A location task may have resolved this posting while its description request was in flight.
    // Lock and use the current job after the gate locks, so late text cannot put its new view away.
    const [current] = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update").limit(1);
    if (!current || current.sourceId !== source.id || current.url !== job.url) return { jobId, skipped: "posting changed during description fetch" };
    const eligible = followers.map(f => f.userId).filter(id => current.shared || id === current.addedBy);
    const settings = new Map([...allSettings].filter(([id]) => eligible.includes(id)));
    if (!text) {
      await tx.update(schema.jobs).set({ descriptionFetchedAt: deps.now() }).where(eq(schema.jobs.id, job.id));
      // A new role's score waits for this task (the scan does not score what it is fetching text
      // for), so no text still means the gate runs and the role is scored on what there is.
      await refreshFollowers(deps, db, deps.now(), current, settings, false);
      return { jobId, stored: false };
    }
    const trimmed = text.slice(0, MAX_DESCRIPTION);
    const hash = sha1(trimmed);
    await tx
      .update(schema.jobs)
      .set({ ...extra,
          descriptionSource,
          descriptionTruncated: text.length > MAX_DESCRIPTION, descriptionText: trimmed, descriptionHash: hash, descriptionFetchedAt: deps.now() })
      .where(eq(schema.jobs.id, job.id));
    const changed = hash !== current.descriptionHash;
    // A changed description invalidates every follower's score for the role, and with it the record
    // that a scoring of the old text completed: the new text is new input.
    if (changed && followers.length) {
      await tx.update(schema.userJobs).set({ fitScore: null, scoredAt: null, updatedAt: deps.now() })
        .where(and(eq(schema.userJobs.jobId, job.id), inArray(schema.userJobs.userId, followers.map(f => f.userId))));
    }
    await tx.insert(schema.jobEvents).values({ jobId: job.id, type: "description_fetched", payload: { chars: trimmed.length } });
    await refreshFollowers(deps, db, deps.now(), { ...current, ...extra, descriptionText: trimmed }, settings, changed);
    if (current.sourceId && current.url && current.locationResolution === "pending" && current.locationLabel && eligible.some(userId => {
      const gate = settings.get(userId)!.gate;
      if (!gate.locationTerms.length) return false;
      const verdict = gateCompiler()(gate).evaluate({ title: current.title, department: current.department,
        description: trimmed, location: current.location, locations: current.locations, remote: current.remote,
        locationResolution: "pending" });
      return verdict.keywordMatched && !verdict.excluded;
    })) await requestLocationEnrichment(db, { id: current.id, sourceId: current.sourceId, externalKey: current.externalKey,
      url: current.url, title: current.title, locationLabel: current.locationLabel,
      locationResolution: current.locationResolution, locationRevision: current.locationRevision }, deps.now());
    return { jobId, stored: true, chars: trimmed.length, followers: followers.length };
  });
  // Idempotent and in a transaction of its own, like the scan's: once, for every follower.
  await archiveNonMatches(deps.db, { jobId });
  return outcome;
}

/**
 * Every follower's gate over this one posting, in one pass: the gates (read and share-locked by
 * the caller in one query, as the scan reads them) are evaluated in memory, and the views written
 * with one update, one insert and one queue insert, however many people follow the company.
 *
 * Scoring is queued for every view in the table still without a score and never scored on these
 * inputs, and, when the text changed, for a role shortlisted outside the table whose score that
 * change just cleared.
 */
export async function refreshFollowers(
  deps: WorkerDeps,
  db: WorkerDeps["db"],
  now: Date,
  job: Pick<typeof schema.jobs.$inferSelect, "id" | "title" | "department" | "descriptionText" | "location" | "locations" | "remote" | "status" | "addedBy" | "locationResolution" | "locationFetchedAt">,
  settings: Map<string, AppSettings>,
  descriptionChanged: boolean,
  options: { preserveHidden?: boolean } = {},
) {
  const eligible = [...settings.keys()];
  if (!eligible.length) return;
  const views = await db.select({
    userId: schema.userJobs.userId, keywordMatched: schema.userJobs.keywordMatched, keywordTerms: schema.userJobs.keywordTerms,
    excluded: schema.userJobs.excluded, locationOk: schema.userJobs.locationOk, inTable: schema.userJobs.inTable, hidden: schema.userJobs.hidden,
    nearMiss: schema.userJobs.nearMiss, fitScore: schema.userJobs.fitScore, scoredAt: schema.userJobs.scoredAt,
    archivedAt: schema.userJobs.archivedAt, gateArchivedAt: schema.userJobs.gateArchivedAt, addedByUrl: schema.userJobs.addedByUrl,
  }).from(schema.userJobs).where(and(eq(schema.userJobs.jobId, job.id), inArray(schema.userJobs.userId, eligible)));
  const viewOf = new Map(views.map(view => [view.userId, view]));
  const shortlisted = descriptionChanged
    ? new Set((await db.select({ userId: schema.decisions.userId }).from(schema.decisions)
        .where(and(eq(schema.decisions.jobId, job.id), eq(schema.decisions.decision, "apply"), eq(schema.decisions.superseded, false), inArray(schema.decisions.userId, eligible)))).map(row => row.userId))
    : new Set<string>();

  const gateFor = gateCompiler();
  const updates: ViewUpdate[] = [];
  const inserts: Array<typeof schema.userJobs.$inferInsert> = [];
  const scoring: string[] = [];
  for (const userId of eligible) {
    const view = viewOf.get(userId);
    const { verdict, held } = gateWithRetainedLocations(gateFor(settings.get(userId)!.gate),
      { title: job.title, department: job.department, description: job.descriptionText, location: job.location,
        locations: job.locations, remote: job.remote, locationResolution: job.locationResolution },
      { status: job.status, locationFetchedAt: job.locationFetchedAt }, view);
    const inTable = inTableFor(verdict, userId, job, view);
    const values = viewVerdict(verdict, inTable, { hidden: options.preserveHidden ? view?.hidden ?? false : false });
    if (view) {
      const update = viewUpdate(userId, job.id, view, values);
      if (update) updates.push(update);
      // Scores were cleared above when the text changed, so a stored score here still stands.
      const unscored = descriptionChanged || (view.fitScore === null && view.scoredAt === null);
      if (!held && job.status === "open" && unscored && (inTable || shortlisted.has(userId))) scoring.push(userId);
    } else if (inTable) {
      inserts.push(newView(userId, job.id, values, true, now));
      if (job.status === "open") scoring.push(userId);
    }
  }
  await writeViewUpdates(db, updates, now);
  if (inserts.length) await db.insert(schema.userJobs).values(inserts).onConflictDoNothing();
  for (let offset = 0; offset < scoring.length; offset += 250)
    await admitScores(deps, scoring.slice(offset, offset + 250).map(userId => ({ userId, jobId: job.id })), { db, settings, onlyUnscored: true });
}

/**
 * `value` with case, punctuation and spacing set aside — lower case, every run of anything but
 * letters and digits one space, trimmed — with, for each character of the result, where it came
 * from in `value` (`from`) and where that source character ends (`to`).
 */
function normaliseWithMap(value: string): { text: string; from: number[]; to: number[] } {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let gap = false;
  for (let i = 0; i < value.length;) {
    const ch = String.fromCodePoint(value.codePointAt(i)!);
    if (/[\p{L}\p{N}]/u.test(ch)) {
      if (gap && text) { text += " "; from.push(i); to.push(i); }
      gap = false;
      // A lower case can be longer than its capital, with a mark that is not a letter ("İ"): only
      // its letters and digits count, each mapped back to the one source character.
      const lower = [...ch.toLowerCase()].filter(part => /[\p{L}\p{N}]/u.test(part)).join("");
      for (let unit = 0; unit < lower.length; unit++) { from.push(i); to.push(i + ch.length); }
      text += lower;
    } else {
      gap = true;
    }
    i += ch.length;
  }
  return { text, from, to };
}

/**
 * The page's own text from the sentence A4 says the description starts with to the one it says it
 * ends with, both matched as whole words with case, punctuation and spacing set aside (as
 * `normaliseWithMap` reads them), the end at or after the start, and the end sentence's closing
 * punctuation kept. Null when either is not on the page, so the caller keeps the page's own reading.
 */
export function sliceBetweenAnchors(rawText: string, startsWith: string, endsWith: string): string | null {
  const page = normaliseWithMap(rawText);
  const start = normaliseWithMap(startsWith).text;
  const end = normaliseWithMap(endsWith).text;
  if (!start || !end) return null;
  // Padded, so a match is whole words: index `p` in the padded page is index `p` of the anchor's
  // first character in `page.text`.
  const padded = ` ${page.text} `;
  const first = padded.indexOf(` ${start} `);
  if (first < 0) return null;
  const last = padded.indexOf(` ${end} `, first);
  if (last < 0) return null;
  let stop = page.to[last + end.length - 1]!;
  while (stop < rawText.length && /[^\s\p{L}\p{N}]/u.test(rawText[stop]!)) stop++;
  const sliced = rawText.slice(page.from[first]!, stop).trim();
  return sliced || null;
}

/**
 * Moved to @col/core (`posting-page.ts`), where the same reading serves a posting a
 * follower pastes the URL of. Re-exported so the worker's own callers keep their import.
 */
export { extractMainText };
