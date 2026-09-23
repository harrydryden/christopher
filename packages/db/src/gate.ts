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
}

/**
 * Re-run one account's keyword and location gate over the shared postings of the companies it
 * follows. A posting that passes gets a `user_jobs` row if it had none (store matching roles only,
 * per account); a row that stops passing is archived unless it carries a decision or a saved CV,
 * or the account added the posting itself by pasting its URL.
 * Shared by synchronous settings saves, new subscriptions and the background `reevaluate_gate` task.
 */
export async function reevaluateGate(db: Db, userId: string, settings: AppSettings, now = new Date(), scope: GateScope = {}) {
  // Only a gate that matches on the description needs it, and it is the largest column on `jobs`:
  // reading it for every posting of every followed company was most of this loop's traffic for the
  // accounts that match on title and location alone.
  const matchesDescription = settings.gate.matchFields.includes("description");
  // Built once for the whole walk rather than per posting.
  const gateOf = compileGate(settings.gate);
  let cursor: string | undefined;
  let examined = 0;
  let changed = 0;
  let created = 0;
  let queuedForScoring = 0;
  while (true) {
    const page = await db.execute<GateRow>(sql`
      select j.id, j.title, j.added_by as "addedBy", j.department, ${matchesDescription ? sql`j.description_text` : sql`null::text`} as "descriptionText", j.location, j.locations, j.remote, j.status,
        (uj.job_id is not null) as viewed, uj.keyword_matched as "keywordMatched", uj.keyword_terms as "keywordTerms",
        uj.excluded, uj.location_ok as "locationOk", uj.in_table as "inTable", uj.hidden, uj.fit_score as "fitScore"
      from jobs j
      left join user_jobs uj on uj.job_id = j.id and uj.user_id = ${userId}
      where ${scope.jobId ? sql`j.id = ${scope.jobId}` : sql`exists (
          select 1 from company_subscriptions s where s.company_id = j.company_id and s.user_id = ${userId} and s.status <> 'archived')`}
        and (${scope.companyId ?? null}::uuid is null or j.company_id = ${scope.companyId ?? null}::uuid)
        and (${cursor ?? null}::uuid is null or j.id > ${cursor ?? null}::uuid)
      order by j.id limit 250`);
    const rows = page.rows;
    if (!rows.length) break;
    examined += rows.length;
    const updates: Array<Record<string, unknown>> = [];
    const inserts: Array<typeof schema.userJobs.$inferInsert> = [];
    const scoring: Array<typeof schema.tasks.$inferInsert> = [];
    for (const job of rows) {
      const gate = gateOf.evaluate({ title: job.title, department: job.department, description: job.descriptionText, location: job.location, locations: job.locations, remote: job.remote });
      // A role this account added by pasting its URL stays in their table whatever the gate says:
      // they asked for that one by name. The same exemption `archiveNonMatches` already makes for
      // a role they decided on or wrote a CV for — work the person did on that role.
      const inTable = gate.inTable || job.addedBy === userId;
      const values = { keywordMatched: gate.keywordMatched, keywordTerms: gate.keywordTerms, excluded: gate.excluded, locationOk: gate.locationOk, inTable, hidden: false };
      if (job.viewed) {
        if (Object.entries(values).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(job[k as keyof GateRow]))) {
          updates.push({ jobId: job.id, ...values });
          changed++;
        }
      } else if (inTable) {
        // The scan had already seen this posting: new to this account, not a new vacancy.
        inserts.push({ userId, jobId: job.id, ...values, seeded: true, createdAt: now, updatedAt: now });
        created++;
      } else continue;
      if (inTable && job.fitScore === null && job.status === "open") {
        const payload = { userId, jobId: job.id };
        scoring.push({ type: "score_job", payload, dedupeKey: dedupeKeyFor("score_job", payload), priority: priorityFor("score_job") });
      }
    }
    for (let offset = 0; offset < updates.length; offset += 250) {
      await db.execute(sql`update user_jobs uj set keyword_matched = v."keywordMatched", keyword_terms = v."keywordTerms",
        excluded = v.excluded, location_ok = v."locationOk", in_table = v."inTable", near_miss = false, hidden = v.hidden, updated_at = ${now}
        from jsonb_to_recordset(${JSON.stringify(updates.slice(offset, offset + 250))}::jsonb)
        as v("jobId" uuid, "keywordMatched" boolean, "keywordTerms" jsonb, excluded boolean, "locationOk" boolean, "inTable" boolean, hidden boolean)
        where uj.user_id = ${userId} and uj.job_id = v."jobId"`);
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
    cursor = rows.at(-1)!.id;
    if (scope.jobId) break;
  }
  const archived = await archiveNonMatches(db, { userId, jobId: scope.jobId, companyId: scope.companyId });
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
 * on it or built a CV for it. Never deletes: the row keeps its history and shows in the Archive
 * view. A saved CV is work the person did on that role; narrowing a filter must not take the role
 * the CV was written for out of their table behind it.
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
      where uj.in_table = false and uj.archived_at is null
      and (${userId}::uuid is null or uj.user_id = ${userId}::uuid)
      and (${sourceId}::uuid is null or j.source_id = ${sourceId}::uuid)
      and (${jobId}::uuid is null or uj.job_id = ${jobId}::uuid)
      and (${companyId}::uuid is null or j.company_id = ${companyId}::uuid)
      and not exists (select 1 from cv_drafts c where c.user_id = uj.user_id and c.job_id = uj.job_id)
      order by uj.user_id, uj.job_id for update of uj`);
    const result = await tx.execute(sql`
    with archived as (
      update user_jobs uj set archived_at = now(), updated_at = now()
      from jobs j
      where j.id = uj.job_id and uj.in_table = false and uj.archived_at is null
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
