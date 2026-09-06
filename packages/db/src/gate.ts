import { evaluateGate, dedupeKeyFor, priorityFor, type AppSettings } from "@christopher/core";
import { eq, gte, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import * as schema from "./schema";
import { enqueueTask } from "./tasks";

/** Shared by synchronous settings saves and background maintenance. */
export async function reevaluateGate(db: Db, settings: AppSettings, now = new Date()) {
  const cutoff = new Date(now.getTime() - Math.max(30, settings.showClosedDays) * 86_400_000);
  const rows = await db.select().from(schema.jobs).where(or(eq(schema.jobs.status, "open"), gte(schema.jobs.closedAt, cutoff)));
  let changed = 0;
  let queuedForScoring = 0;
  for (const job of rows) {
    const gate = evaluateGate({ ...job, description: job.descriptionText }, settings.gate);
    const nearMiss = false;
    const hidden = settings.hideThreshold !== null && gate.inTable && job.fitScore !== null && job.fitScore < settings.hideThreshold;
    const values = { keywordMatched: gate.keywordMatched, keywordTerms: gate.keywordTerms,
      excluded: gate.excluded, locationOk: gate.locationOk, inTable: gate.inTable, nearMiss, hidden };
    if (Object.entries(values).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(job[k as keyof typeof job]))) {
      await db.update(schema.jobs).set({ ...values, updatedAt: now }).where(eq(schema.jobs.id, job.id));
      changed++;
    }
    if ((gate.inTable || nearMiss) && job.fitScore === null && job.status === "open") {
      const payload = { jobId: job.id, nearMiss };
      if (await enqueueTask(db, "score_job", payload, { dedupeKey: dedupeKeyFor("score_job", payload), priority: priorityFor("score_job") })) queuedForScoring++;
    }
  }
  const removed = await pruneNonMatches(db);
  return { removed, examined: rows.length, changed, queuedForScoring };
}

/** Retain every decision (including superseded decisions), CV and explicitly archived role. */
export async function pruneNonMatches(db: Db, sourceId?: string): Promise<number> {
  const result = await db.execute(sql`
    delete from jobs j where j.in_table = false and j.archived_at is null
    and (${sourceId ?? null}::uuid is null or j.source_id = ${sourceId ?? null}::uuid)
    and not exists (select 1 from decisions d where d.job_id = j.id)
    and not exists (select 1 from cv_drafts c where c.job_id = j.id)
    returning j.id`);
  return result.rows.length;
}
