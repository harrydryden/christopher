import { schema, archiveNonMatches, isGateArchive, restoreGateArchive, GATE_RESTORE_EVENT, type Task } from "@ava/db";
import { ats, compileGate, dedupeKeyFor, extractMainText, priorityFor, sha1, stripHtml, type AppSettings, type CompiledGate } from "@ava/core";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { makeFetchContext, aiBudgetExceeded } from "../context";
import { loadUserSettingsMany } from "../settings";
import { log } from "../log";

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
        if ((!text || text.length < 200) && !(await aiBudgetExceeded(deps))) {
          const rawText = stripHtml(res.body).slice(0, 20_000);
          const cleaned = await deps.ai.cleanDescription({ title: job.title, rawText }, { refType: "job", refId: job.id });
          // The model may cut and tidy the page, never write it: its text is shared with every
          // follower and read by their gates, so it is kept only when the page says it.
          if (cleaned?.descriptionText && anchoredInPage(cleaned.descriptionText, rawText)) {
            text = cleaned.descriptionText;
            descriptionSource = "model";
            extra = { salaryText: cleaned.salaryText ?? job.salaryText, employmentType: cleaned.employmentType ?? job.employmentType, remote: cleaned.remote ?? job.remote };
          } else if (cleaned?.descriptionText) {
            log.warn("model description not found on the page; kept the page's own text", { jobId, url: job.url });
          }
        }
      }
    } catch (err) {
      log.warn("description fetch failed", { jobId, url: job.url, error: (err as Error).message });
    }
  }

  const followers = await deps.db.select({ userId: schema.companySubscriptions.userId }).from(schema.companySubscriptions)
    .where(and(eq(schema.companySubscriptions.companyId, job.companyId), ne(schema.companySubscriptions.status, "archived")));
  // A posting pasted from a host that is not the company's is kept for the account that pasted it.
  const eligible = followers.map(f => f.userId).filter(id => job.shared || id === job.addedBy);
  const outcome = await deps.db.transaction(async (tx) => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    const db = tx as unknown as WorkerDeps["db"];
    // The gates first, before anything is written: a settings save holds its gate row while it
    // re-evaluates that account's views, so taking the share locks after writing views here could
    // leave each waiting on the other.
    const settings = await loadUserSettingsMany(db, eligible, { lockGates: true });
    if (!text) {
      await tx.update(schema.jobs).set({ descriptionFetchedAt: deps.now() }).where(eq(schema.jobs.id, job.id));
      // A new role's score waits for this task (the scan does not score what it is fetching text
      // for), so no text still means the gate runs and the role is scored on what there is.
      await refreshFollowers(db, deps.now(), { ...job }, settings, false);
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
    const changed = hash !== job.descriptionHash;
    // A changed description invalidates every follower's score for the role, and with it the record
    // that a scoring of the old text completed: the new text is new input.
    if (changed && followers.length) {
      await tx.update(schema.userJobs).set({ fitScore: null, scoredAt: null, updatedAt: deps.now() })
        .where(and(eq(schema.userJobs.jobId, job.id), inArray(schema.userJobs.userId, followers.map(f => f.userId))));
    }
    await tx.insert(schema.jobEvents).values({ jobId: job.id, type: "description_fetched", payload: { chars: trimmed.length } });
    await refreshFollowers(db, deps.now(), { ...job, ...extra, descriptionText: trimmed }, settings, changed);
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
async function refreshFollowers(
  db: WorkerDeps["db"],
  now: Date,
  job: Pick<typeof schema.jobs.$inferSelect, "id" | "title" | "department" | "descriptionText" | "location" | "locations" | "remote" | "status" | "addedBy">,
  settings: Map<string, AppSettings>,
  descriptionChanged: boolean,
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

  const compiled = new Map<string, CompiledGate>();
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<typeof schema.userJobs.$inferInsert> = [];
  const scoring: string[] = [];
  for (const userId of eligible) {
    const own = settings.get(userId)!;
    const key = JSON.stringify(own.gate);
    let gate = compiled.get(key);
    if (!gate) compiled.set(key, gate = compileGate(own.gate));
    const verdict = gate.evaluate({ title: job.title, department: job.department, description: job.descriptionText, location: job.location, locations: job.locations, remote: job.remote });
    const view = viewOf.get(userId);
    // Asked for by name (the paste that created it, or one that found it stored): in the table
    // whatever the gate says.
    const inTable = verdict.inTable || job.addedBy === userId || view?.addedByUrl === true;
    const values = { keywordMatched: verdict.keywordMatched, keywordTerms: verdict.keywordTerms, excluded: verdict.excluded, locationOk: verdict.locationOk, inTable, hidden: false };
    if (view) {
      const restore = inTable && isGateArchive(view);
      if (restore || view.nearMiss || (Object.keys(values) as Array<keyof typeof values>).some(k => JSON.stringify(values[k]) !== JSON.stringify(view[k]))) {
        updates.push({ userId, ...values, restore });
      }
      // Scores were cleared above when the text changed, so a stored score here still stands.
      const unscored = descriptionChanged || (view.fitScore === null && view.scoredAt === null);
      if (job.status === "open" && unscored && (inTable || shortlisted.has(userId))) scoring.push(userId);
    } else if (inTable) {
      inserts.push({ userId, jobId: job.id, ...values, nearMiss: false, seeded: true, createdAt: now, updatedAt: now });
      if (job.status === "open") scoring.push(userId);
    }
  }
  if (updates.length) {
    await db.execute(sql`with changed as (
      update user_jobs uj set keyword_matched = v."keywordMatched", keyword_terms = v."keywordTerms", excluded = v.excluded,
        location_ok = v."locationOk", in_table = v."inTable", near_miss = false, hidden = v.hidden, ${restoreGateArchive}, updated_at = ${now}
      from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
      as v("userId" uuid, "keywordMatched" boolean, "keywordTerms" jsonb, excluded boolean, "locationOk" boolean, "inTable" boolean, hidden boolean, restore boolean)
      where uj.job_id = ${job.id} and uj.user_id = v."userId"
      returning uj.user_id, (v.restore and uj.archived_at is null) as restored
    )
    insert into job_events (job_id, user_id, type, payload)
    select ${job.id}::uuid, user_id, 'updated', ${GATE_RESTORE_EVENT}::jsonb from changed where restored`);
  }
  if (inserts.length) await db.insert(schema.userJobs).values(inserts).onConflictDoNothing();
  if (scoring.length) {
    await db.insert(schema.tasks).values(scoring.map(userId => {
      const payload = { userId, jobId: job.id };
      return { type: "score_job" as const, payload, dedupeKey: dedupeKeyFor("score_job", payload), priority: priorityFor("score_job") };
    })).onConflictDoNothing();
    // Say so on the view as well, so the table reads "scoring" rather than a blank.
    await db.update(schema.userJobs).set({ scoreState: "queued", scoreStateAt: now })
      .where(and(eq(schema.userJobs.jobId, job.id), inArray(schema.userJobs.userId, scoring)));
  }
}

/**
 * Whether every sentence of the model's cleaned text is in the page it was given, compared with
 * case, punctuation and spacing set aside. A4 is asked to tidy a description, not to write one:
 * text that is not on the page is not the posting's, and it would reach every follower's gate.
 */
export function anchoredInPage(cleaned: string, rawText: string): boolean {
  const normalise = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const page = ` ${normalise(rawText)} `;
  const sentences = cleaned.split(/(?<=[.!?])\s+|\n+/).map(normalise).filter(Boolean);
  if (!sentences.length) return false;
  return sentences.every(sentence => page.includes(` ${sentence} `));
}

/**
 * Moved to @ava/core (`posting-page.ts`), where the same reading serves a posting a
 * follower pastes the URL of. Re-exported so the worker's own callers keep their import.
 */
export { extractMainText };
