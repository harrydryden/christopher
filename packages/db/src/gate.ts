import { evaluateGate, dedupeKeyFor, priorityFor, type AppSettings } from "@christopher/core";
import { eq, gt, sql } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";


/** Shared by synchronous settings saves and background maintenance. */
export async function reevaluateGate(db: Db, settings: AppSettings, now = new Date(), jobId?: string) {
  let cursor: string | undefined;
  let examined = 0;
  let changed = 0;
  let queuedForScoring = 0;
  while (true) {
  const rows = await db.select().from(schema.jobs).where(jobId ? eq(schema.jobs.id, jobId) : cursor ? gt(schema.jobs.id, cursor) : undefined)
    .orderBy(schema.jobs.id).limit(250);
  if (!rows.length) break;
  examined += rows.length;
  const updates: Array<Record<string, unknown>> = [];
  const scoring: Array<typeof schema.tasks.$inferInsert> = [];
  for (const job of rows) {
    const gate = evaluateGate({ ...job, description: job.descriptionText }, settings.gate);
    const nearMiss = false;
    const hidden = settings.hideThreshold !== null && gate.inTable && job.fitScore !== null && job.fitScore < settings.hideThreshold;
    const values = { keywordMatched: gate.keywordMatched, keywordTerms: gate.keywordTerms,
      excluded: gate.excluded, locationOk: gate.locationOk, inTable: gate.inTable, nearMiss, hidden };
    if (Object.entries(values).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(job[k as keyof typeof job]))) {
      updates.push({ id: job.id, ...values });
      changed++;
    }
    if ((gate.inTable || nearMiss) && job.fitScore === null && job.status === "open") {
      const payload = { jobId: job.id, nearMiss };
      scoring.push({ type: "score_job", payload, dedupeKey: dedupeKeyFor("score_job", payload), priority: priorityFor("score_job") });
    }
  }
  for (let offset = 0; offset < updates.length; offset += 250) {
    await db.execute(sql`update jobs j set keyword_matched = v."keywordMatched", keyword_terms = v."keywordTerms",
      excluded = v.excluded, location_ok = v."locationOk", in_table = v."inTable", near_miss = false, hidden = v.hidden, updated_at = ${now}
      from jsonb_to_recordset(${JSON.stringify(updates.slice(offset, offset + 250))}::jsonb)
      as v(id uuid, "keywordMatched" boolean, "keywordTerms" jsonb, excluded boolean, "locationOk" boolean, "inTable" boolean, hidden boolean)
      where j.id = v.id`);
  }
  for (let offset = 0; offset < scoring.length; offset += 250) {
    const queued = await db.insert(schema.tasks).values(scoring.slice(offset, offset + 250)).onConflictDoNothing().returning({ id: schema.tasks.id });
    queuedForScoring += queued.length;
  }
  cursor = rows.at(-1)!.id;
  if (jobId) break;
  }
  const removed = await pruneNonMatches(db, undefined, jobId);
  return { removed, examined, changed, queuedForScoring };
}

/** Retain every decision (including superseded decisions), CV and explicitly archived role. */
export async function pruneNonMatches(db: Db, sourceId?: string, jobId?: string): Promise<number> {
  const result = await db.execute(sql`
    delete from jobs j where j.in_table = false and j.archived_at is null
    and (${sourceId ?? null}::uuid is null or j.source_id = ${sourceId ?? null}::uuid)
    and (${jobId ?? null}::uuid is null or j.id = ${jobId ?? null}::uuid)
    and not exists (select 1 from decisions d where d.job_id = j.id)
    and not exists (select 1 from cv_drafts c where c.job_id = j.id)
    returning j.id`);
  return result.rows.length;
}
