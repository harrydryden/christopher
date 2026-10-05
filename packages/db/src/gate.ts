import { compileGate, type AppSettings, type CompiledGate, type GateInput, type GateResult, type GateSettings } from "@col/core";
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";
import { requestScores } from "./tasks";
import { requestLocationEnrichment } from "./location-enrichment";

export interface GateScope {
  /** One posting only (a description just arrived). */
  jobId?: string;
  /** One company's postings (a new subscription, or a filter suggestion about that company). */
  companyId?: string;
}

interface GateRow extends Record<string, unknown> {
  id: string;
  sourceId: string | null;
  externalKey: string;
  url: string | null;
  manualOwnerId: string | null;
  locationLabel: string | null;
  title: string;
  /** The account that added this posting by pasting its URL, when one did. */
  addedBy: string | null;
  /** This account asked for the posting by pasting its URL (the view's own marker). */
  addedByUrl: boolean | null;
  department: string | null;
  descriptionText: string | null;
  location: string | null;
  locations: string[];
  locationResolution: "pending" | "resolved" | "unavailable" | null;
  locationRevision: string | null;
  locationFetchedAt: Date | null;
  remote: boolean | null;
  status: "open" | "closed";
  viewed: boolean;
  keywordMatched: boolean | null;
  keywordTerms: string[] | null;
  excluded: boolean | null;
  locationOk: boolean | null;
  inTable: boolean | null;
  hidden: boolean | null;
  fitScore: number | null;
  scoredAt: Date | string | null;
  archivedAt: Date | string | null;
  gateArchivedAt: Date | string | null;
}

/** The days a closed role stays within reach of a changed gate (R-5.4), as the table shows them. */
export const REEVALUATE_CLOSED_DAYS = 30;

/** Whether the view's archive is the gate's own, still untouched by the person. */
export function isGateArchive(view: { archivedAt: Date | string | null; gateArchivedAt: Date | string | null }): boolean {
  if (view.archivedAt === null || view.gateArchivedAt === null) return false;
  return new Date(view.archivedAt).getTime() === new Date(view.gateArchivedAt).getTime();
}

/**
 * Set on an update of `user_jobs uj` from a recordset `v` with an `"inTable"` column: a view the
 * gate archived comes back the moment the gate admits it again. Only the gate's own archive
 * (`archived_at` still equal to `gate_archived_at`) is undone; one a person made never is.
 */
const restoreGateArchive = sql`archived_at = case when v."inTable" and uj.archived_at is not null and uj.archived_at = uj.gate_archived_at then null else uj.archived_at end,
  gate_archived_at = case when v."inTable" and uj.archived_at is not null and uj.archived_at = uj.gate_archived_at then null else uj.gate_archived_at end`;

/** The event a view the gate brought back carries, beside the one its archive recorded. */
const GATE_RESTORE_EVENT = '{"action":"unarchived","actor":"system","reason":"Matches your criteria again"}';

/**
 * Compiled gates by their settings, so accounts with the same gate share one compilation for a
 * whole pass instead of building its patterns once per account or per posting.
 */
export function gateCompiler(): (gate: GateSettings) => CompiledGate {
  const compiled = new Map<string, CompiledGate>();
  return gate => {
    const key = JSON.stringify(gate);
    let found = compiled.get(key);
    if (!found) compiled.set(key, found = compileGate(gate));
    return found;
  };
}

/**
 * A refreshed counted listing has unknown current places. Its last verified names may preserve
 * an existing qualified view while detail is pending, but cannot admit a new follower. Re-run the
 * current gate on those names so a changed keyword or location filter still takes effect.
 */
export function gateWithRetainedLocations(
  gate: CompiledGate,
  input: GateInput,
  evidence: { status: "open" | "closed"; locationFetchedAt: Date | string | null },
  view?: { inTable: boolean | null; locationOk: boolean | null } | null,
): { verdict: GateResult; held: boolean } {
  const verdict = gate.evaluate(input);
  if (evidence.status !== "open" || view?.inTable !== true || view.locationOk !== true
      || !evidence.locationFetchedAt || !input.locations?.length
      || (input.locationResolution !== "pending" && input.locationResolution !== "unavailable"))
    return { verdict, held: false };
  const retained = gate.evaluate({ ...input, locationResolution: "resolved" });
  return retained.inTable ? { verdict: retained, held: true } : { verdict, held: false };
}

/**
 * Whether an account's view of a posting is in its table: the gate admits it, or the account
 * asked for it by name, by pasting its URL, whether the paste created the posting or found it
 * already stored (and whether or not a scan later adopted the row). The same exemption
 * `archiveNonMatches` makes for a role the person decided on or wrote a CV for.
 */
export function inTableFor(verdict: GateResult, userId: string, job: { addedBy: string | null; manualOwnerId?: string | null }, view?: { addedByUrl: boolean | null } | null): boolean {
  return verdict.inTable || job.addedBy === userId || job.manualOwnerId === userId || view?.addedByUrl === true;
}

/** The verdict columns a gate decision writes onto a view. `hidden` is written only when given. */
export interface ViewVerdict {
  keywordMatched: boolean;
  keywordTerms: string[];
  excluded: boolean;
  locationOk: boolean;
  inTable: boolean;
  hidden?: boolean;
}

export function viewVerdict(verdict: GateResult, inTable: boolean, opts: { hidden?: boolean } = {}): ViewVerdict {
  return { keywordMatched: verdict.keywordMatched, keywordTerms: verdict.keywordTerms, excluded: verdict.excluded, locationOk: verdict.locationOk, inTable,
    ...(opts.hidden === undefined ? {} : { hidden: opts.hidden }) };
}

/** A new view of a posting, for an account whose gate (or paste) put it in the table. */
export function newView(userId: string, jobId: string, values: ViewVerdict, seeded: boolean, now: Date): typeof schema.userJobs.$inferInsert {
  return { userId, jobId, ...values, seeded, createdAt: now, updatedAt: now };
}

export type ViewUpdate = ViewVerdict & { userId: string; jobId: string; restore: boolean };

/**
 * The write an existing view needs for `values`, or null when nothing moved: most views of most
 * roles are the same every day, and `updated_at` dates a change the person sees. A view the gate
 * archived and now admits again is a change even when every verdict column already agrees (an
 * earlier widening set `in_table` and left the archive in place), and so is a legacy near-miss
 * row when the caller read `nearMiss`, which the write clears.
 */
export function viewUpdate(userId: string, jobId: string, view: Record<string, unknown> & {
  nearMiss?: boolean | null; archivedAt: Date | string | null; gateArchivedAt: Date | string | null;
}, values: ViewVerdict): ViewUpdate | null {
  const restore = values.inTable && isGateArchive(view);
  const moved = (Object.keys(values) as Array<keyof ViewVerdict>).some(key => JSON.stringify(values[key]) !== JSON.stringify(view[key]));
  return restore || view.nearMiss || moved ? { userId, jobId, ...values, restore } : null;
}

/**
 * Write verdict columns onto existing views, 250 to a statement. Every write clears the retired
 * near-miss flag; `hidden` is set only on rows that carry it. A view whose gate archive this undoes
 * (`restoreGateArchive`) gets the event that says so, in the same statement.
 */
export async function writeViewUpdates(db: Pick<Db, "execute">, updates: ViewUpdate[], now: Date): Promise<void> {
  for (let offset = 0; offset < updates.length; offset += 250) {
    await db.execute(sql`with changed as (
      update user_jobs uj set keyword_matched = v."keywordMatched", keyword_terms = v."keywordTerms", excluded = v.excluded,
        location_ok = v."locationOk", in_table = v."inTable", near_miss = false, hidden = coalesce(v.hidden, uj.hidden),
        ${restoreGateArchive}, updated_at = ${now}
      from jsonb_to_recordset(${JSON.stringify(updates.slice(offset, offset + 250))}::jsonb) as v("userId" uuid, "jobId" uuid,
        "keywordMatched" boolean, "keywordTerms" jsonb, excluded boolean, "locationOk" boolean, "inTable" boolean, hidden boolean, restore boolean)
      where uj.user_id = v."userId" and uj.job_id = v."jobId"
      returning uj.user_id, uj.job_id, (v.restore and uj.archived_at is null) as restored
    )
    insert into job_events (job_id, user_id, type, payload)
    select job_id, user_id, 'updated', ${GATE_RESTORE_EVENT}::jsonb from changed where restored`);
  }
}

export interface ReevaluateOptions {
  /**
   * Runs each 250-row page, its read and its writes, and then the closing archive, handing each
   * the database to use. A caller that does not want one account's whole walk in one transaction
   * passes one that opens a short transaction per call (and can renew a lease between them);
   * without it every page runs on the `db` given.
   */
  eachPage?: <T>(work: (db: Db) => Promise<T>) => Promise<T>;
  /** Worker callers supply their runtime admission. Web callers use durable neutral requests. */
  scoreCandidates?: (db: Db, pairs: Array<{ userId: string; jobId: string }>, now: Date) => Promise<number>;
}

/**
 * Re-run one account's keyword and location gate over the shared postings of the companies it
 * follows (a posting pasted from a host that is not the company's is offered only to whoever asked
 * for it by its URL). A posting that passes gets a `user_jobs` row if it had none (store matching roles only,
 * per account); a row that stops passing is archived unless it carries a decision or a saved CV,
 * or the account added the posting itself by pasting its URL.
 * Shared by synchronous settings saves, new subscriptions and the background `reevaluate_gate` task.
 */
export async function reevaluateGate(db: Db, userId: string, settings: AppSettings, now = new Date(), scope: GateScope = {}, opts: ReevaluateOptions = {}) {
  const run = opts.eachPage ?? (<T>(work: (db: Db) => Promise<T>) => work(db));
  // Only a gate that matches on the description needs it, and it is the largest column on `jobs`:
  // reading it for every posting of every followed company was most of this loop's traffic for the
  // accounts that match on title and location alone.
  const matchesDescription = settings.gate.matchFields.includes("description");
  // Built once for the whole walk rather than per posting.
  const gateOf = gateCompiler()(settings.gate);
  // The walk covers open roles and roles closed in the last thirty days (R-5.4), plus every role
  // this account already has a view of, so a narrowed gate still puts older views away. A role
  // that closed months ago is not one to create a view for, and walking the whole history of every
  // followed company for each account is what made re-evaluation grow without bound.
  const closedSince = new Date(now.getTime() - REEVALUATE_CLOSED_DAYS * 86_400_000);
  let cursor: string | undefined;
  let examined = 0;
  let changed = 0;
  let created = 0;
  let queuedForScoring = 0;
  while (true) {
    const last = await run(async (db) => {
    const page = await db.execute<GateRow>(sql`
      select j.id, j.source_id as "sourceId", j.external_key as "externalKey", j.url, j.title, j.added_by as "addedBy", j.manual_owner_id as "manualOwnerId", j.department, ${matchesDescription ? sql`j.description_text` : sql`null::text`} as "descriptionText", j.location, j.locations, j.location_label as "locationLabel", j.location_resolution as "locationResolution", j.location_revision as "locationRevision", j.location_fetched_at as "locationFetchedAt", j.remote, j.status,
        (uj.job_id is not null) as viewed, uj.keyword_matched as "keywordMatched", uj.keyword_terms as "keywordTerms",
        uj.excluded, uj.location_ok as "locationOk", uj.in_table as "inTable", uj.hidden, uj.fit_score as "fitScore",
        uj.added_by_url as "addedByUrl", uj.scored_at as "scoredAt", uj.archived_at as "archivedAt", uj.gate_archived_at as "gateArchivedAt"
      from jobs j
      left join user_jobs uj on uj.job_id = j.id and uj.user_id = ${userId}
      where ${scope.jobId ? sql`j.id = ${scope.jobId}` : sql`(j.manual_owner_id = ${userId} or (exists (
          select 1 from company_subscriptions s where s.company_id = j.company_id and s.user_id = ${userId} and s.status <> 'archived')
        and (j.status = 'open' or j.closed_at >= ${closedSince} or uj.job_id is not null)))`}
        and (${scope.companyId ?? null}::uuid is null or j.company_id = ${scope.companyId ?? null}::uuid)
        and (j.shared or j.added_by = ${userId} or j.manual_owner_id = ${userId} or uj.added_by_url)
        and (${cursor ?? null}::uuid is null or j.id > ${cursor ?? null}::uuid)
      order by j.id limit 250`);
    const rows = page.rows;
    if (!rows.length) return null;
    examined += rows.length;
    const updates: ViewUpdate[] = [];
    const inserts: Array<typeof schema.userJobs.$inferInsert> = [];
    const scoring: Array<{ userId: string; jobId: string }> = [];
    for (const job of rows) {
      const input = { title: job.title, department: job.department, description: job.descriptionText,
        location: job.location, locations: job.locations, locationResolution: job.locationResolution, remote: job.remote };
      const { verdict: gate, held } = gateWithRetainedLocations(gateOf, input, job, job.viewed ? job : null);
      if (job.status === "open" && job.sourceId && job.url && job.locationResolution === "pending" && job.locationLabel && settings.gate.locationTerms.length > 0
          && gate.keywordMatched && !gate.excluded)
        await requestLocationEnrichment(db, { ...job, sourceId: job.sourceId, url: job.url, locationLabel: job.locationLabel }, now);
      const inTable = inTableFor(gate, userId, job, job);
      const values = viewVerdict(gate, inTable, { hidden: false });
      if (job.viewed) {
        // The walk does not read `near_miss`, so a legacy near-miss row alone is not rewritten.
        const update = viewUpdate(userId, job.id, job, values);
        if (update) {
          updates.push(update);
          changed++;
        }
      } else if (inTable) {
        // The scan had already seen this posting: new to this account, not a new vacancy.
        inserts.push(newView(userId, job.id, values, true, now));
        created++;
      } else continue;
      // A view whose scoring completed without a score is not asked again for the same inputs.
      if (!held && inTable && job.fitScore === null && job.scoredAt === null && job.status === "open") scoring.push({ userId, jobId: job.id });
    }
    await writeViewUpdates(db, updates, now);
    for (let offset = 0; offset < inserts.length; offset += 250) {
      await db.insert(schema.userJobs).values(inserts.slice(offset, offset + 250)).onConflictDoNothing();
    }
    queuedForScoring += await (opts.scoreCandidates ?? ((writer, pairs, at) => requestScores(writer, pairs, at, { onlyUnscored: true })))(db, scoring, now);
    return rows.at(-1)!.id;
    });
    if (last === null) break;
    cursor = last;
    if (scope.jobId) break;
  }
  const archived = await run(db => archiveNonMatches(db, { userId, jobId: scope.jobId, companyId: scope.companyId }));
  return { removed: 0, archived, examined, changed, created, queuedForScoring };
}

export interface ArchiveScope {
  /** One account, or every account when absent (after a shared scan refreshed a source). */
  userId?: string;
  sourceId?: string;
  jobId?: string;
  companyId?: string;
}

/**
 * Put away a person's view of a posting that no longer passes their gate, unless they have decided
 * on it, built a CV for it or asked for it by its URL. Never deletes: the row keeps its history and
 * shows in the Archive view. A saved CV is work the person did on that role; narrowing a filter
 * must not take the role the CV was written for out of their table behind it. The archive is
 * stamped as the gate's own (`gate_archived_at`), so the view comes back when the gate admits it
 * again.
 */
export async function archiveNonMatches(db: Db, scope: ArchiveScope = {}): Promise<number> {
  const userId = scope.userId ?? null;
  const sourceId = scope.sourceId ?? null;
  const jobId = scope.jobId ?? null;
  const companyId = scope.companyId ?? null;
  return db.transaction(async tx => {
    // Lock in the same order as user mutations, then read decisions in a fresh statement.
    // A shortlist committed while we waited for the row lock must win over automation.
    await tx.execute(sql`select uj.user_id, uj.job_id from user_jobs uj join jobs j on j.id = uj.job_id
      where uj.in_table = false and uj.archived_at is null and not uj.added_by_url
      and j.manual_owner_id is distinct from uj.user_id
      and (${userId}::uuid is null or uj.user_id = ${userId}::uuid)
      and (${sourceId}::uuid is null or j.source_id = ${sourceId}::uuid)
      and (${jobId}::uuid is null or uj.job_id = ${jobId}::uuid)
      and (${companyId}::uuid is null or j.company_id = ${companyId}::uuid)
      and not exists (select 1 from cv_drafts c where c.user_id = uj.user_id and c.job_id = uj.job_id)
      order by uj.user_id, uj.job_id for update of uj`);
    const result = await tx.execute(sql`
    with archived as (
      update user_jobs uj set archived_at = now(), gate_archived_at = now(), updated_at = now()
      from jobs j
      where j.id = uj.job_id and uj.in_table = false and uj.archived_at is null and not uj.added_by_url
      and j.manual_owner_id is distinct from uj.user_id
      and (${userId}::uuid is null or uj.user_id = ${userId}::uuid)
      and (${sourceId}::uuid is null or j.source_id = ${sourceId}::uuid)
      and (${jobId}::uuid is null or uj.job_id = ${jobId}::uuid)
      and (${companyId}::uuid is null or j.company_id = ${companyId}::uuid)
      and not exists (select 1 from decisions d where d.user_id = uj.user_id and d.job_id = uj.job_id and d.superseded = false)
      and not exists (select 1 from cv_drafts c where c.user_id = uj.user_id and c.job_id = uj.job_id)
      returning uj.user_id, uj.job_id
    )
    insert into job_events (job_id, user_id, type, payload)
    select job_id, user_id, 'updated', '{"action":"archived","actor":"system","reason":"No longer matches your criteria"}'::jsonb from archived returning job_id
    `);
    return result.rows.length;
  });
}
