import { compileGate, dedupeKeyFor, priorityFor, type AppSettings } from "@ava/core";
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";

export interface GateScope {
  /** One posting only (a description just arrived). */
  jobId?: string;
  /** One company's postings (a new subscription, or a filter suggestion about that company). */
  companyId?: string;
}

interface GateRow extends Record<string, unknown> {
  id: string;
  title: string;
  /** The account that added this posting by pasting its URL, when one did. */
  addedBy: string | null;
  /** This account asked for the posting by pasting its URL (the view's own marker). */
  addedByUrl: boolean | null;
  department: string | null;
  descriptionText: string | null;
  location: string | null;
  locations: string[];
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
export const restoreGateArchive = sql`archived_at = case when v."inTable" and uj.archived_at is not null and uj.archived_at = uj.gate_archived_at then null else uj.archived_at end,
  gate_archived_at = case when v."inTable" and uj.archived_at is not null and uj.archived_at = uj.gate_archived_at then null else uj.gate_archived_at end`;

/** The event a view the gate brought back carries, beside the one its archive recorded. */
export const GATE_RESTORE_EVENT = '{"action":"unarchived","actor":"system","reason":"Matches your criteria again"}';

export interface ReevaluateOptions {
  /**
   * Runs each 250-row page, its read and its writes, and then the closing archive, handing each
   * the database to use. A caller that does not want one account's whole walk in one transaction
   * passes one that opens a short transaction per call (and can renew a lease between them);
   * without it every page runs on the `db` given.
   */
  eachPage?: <T>(work: (db: Db) => Promise<T>) => Promise<T>;
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
  const gateOf = compileGate(settings.gate);
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
      select j.id, j.title, j.added_by as "addedBy", j.department, ${matchesDescription ? sql`j.description_text` : sql`null::text`} as "descriptionText", j.location, j.locations, j.remote, j.status,
        (uj.job_id is not null) as viewed, uj.keyword_matched as "keywordMatched", uj.keyword_terms as "keywordTerms",
        uj.excluded, uj.location_ok as "locationOk", uj.in_table as "inTable", uj.hidden, uj.fit_score as "fitScore",
        uj.added_by_url as "addedByUrl", uj.scored_at as "scoredAt", uj.archived_at as "archivedAt", uj.gate_archived_at as "gateArchivedAt"
      from jobs j
      left join user_jobs uj on uj.job_id = j.id and uj.user_id = ${userId}
      where ${scope.jobId ? sql`j.id = ${scope.jobId}` : sql`exists (
          select 1 from company_subscriptions s where s.company_id = j.company_id and s.user_id = ${userId} and s.status <> 'archived')
        and (j.status = 'open' or j.closed_at >= ${closedSince} or uj.job_id is not null)`}
        and (${scope.companyId ?? null}::uuid is null or j.company_id = ${scope.companyId ?? null}::uuid)
        and (j.shared or j.added_by = ${userId} or uj.added_by_url)
        and (${cursor ?? null}::uuid is null or j.id > ${cursor ?? null}::uuid)
      order by j.id limit 250`);
    const rows = page.rows;
    if (!rows.length) return null;
    examined += rows.length;
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<typeof schema.userJobs.$inferInsert> = [];
    const scoring: Array<typeof schema.tasks.$inferInsert> = [];
    for (const job of rows) {
      const gate = gateOf.evaluate({ title: job.title, department: job.department, description: job.descriptionText, location: job.location, locations: job.locations, remote: job.remote });
      // A role this account added by pasting its URL stays in their table whatever the gate says:
      // they asked for that one by name, whether the paste created the posting or found it already
      // stored. The same exemption `archiveNonMatches` already makes for a role they decided on or
      // wrote a CV for — work the person did on that role.
      const inTable = gate.inTable || job.addedBy === userId || job.addedByUrl === true;
      const values = { keywordMatched: gate.keywordMatched, keywordTerms: gate.keywordTerms, excluded: gate.excluded, locationOk: gate.locationOk, inTable, hidden: false };
      if (job.viewed) {
        // A view the gate archived and now admits again is a change even when every verdict column
        // already agrees: an earlier widening set `in_table` and left the archive in place.
        const restore = inTable && isGateArchive(job);
        if (restore || Object.entries(values).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(job[k as keyof GateRow]))) {
          updates.push({ jobId: job.id, ...values, restore });
          changed++;
        }
      } else if (inTable) {
        // The scan had already seen this posting: new to this account, not a new vacancy.
        inserts.push({ userId, jobId: job.id, ...values, seeded: true, createdAt: now, updatedAt: now });
        created++;
      } else continue;
      // A view whose scoring completed without a score is not asked again for the same inputs.
      if (inTable && job.fitScore === null && job.scoredAt === null && job.status === "open") {
        const payload = { userId, jobId: job.id };
        scoring.push({ type: "score_job", payload, dedupeKey: dedupeKeyFor("score_job", payload), priority: priorityFor("score_job") });
      }
    }
    for (let offset = 0; offset < updates.length; offset += 250) {
      await db.execute(sql`with changed as (
        update user_jobs uj set keyword_matched = v."keywordMatched", keyword_terms = v."keywordTerms",
          excluded = v.excluded, location_ok = v."locationOk", in_table = v."inTable", near_miss = false, hidden = v.hidden,
          ${restoreGateArchive}, updated_at = ${now}
        from jsonb_to_recordset(${JSON.stringify(updates.slice(offset, offset + 250))}::jsonb)
        as v("jobId" uuid, "keywordMatched" boolean, "keywordTerms" jsonb, excluded boolean, "locationOk" boolean, "inTable" boolean, hidden boolean, restore boolean)
        where uj.user_id = ${userId} and uj.job_id = v."jobId"
        returning uj.job_id, (v.restore and uj.archived_at is null) as restored
      )
      insert into job_events (job_id, user_id, type, payload)
      select job_id, ${userId}::uuid, 'updated', ${GATE_RESTORE_EVENT}::jsonb from changed where restored`);
    }
    for (let offset = 0; offset < inserts.length; offset += 250) {
      await db.insert(schema.userJobs).values(inserts.slice(offset, offset + 250)).onConflictDoNothing();
    }
    for (let offset = 0; offset < scoring.length; offset += 250) {
      const queued = await db.insert(schema.tasks).values(scoring.slice(offset, offset + 250)).onConflictDoNothing().returning({ id: schema.tasks.id });
      queuedForScoring += queued.length;
    }
    // Say so on the view as well as in the queue: a role waiting for its score reads "scoring"
    // rather than as a blank the reader cannot tell from "not scored: budget spent".
    if (scoring.length) {
      await db.execute(sql`update user_jobs set score_state = 'queued', score_state_at = ${now}
        where user_id = ${userId}
          and job_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(scoring.map(row => (row.payload as { jobId: string }).jobId))}::jsonb))`);
    }
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
