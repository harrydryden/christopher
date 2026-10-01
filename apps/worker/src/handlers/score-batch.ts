/**
 * Background fit scoring through the Message Batches API (`scoringMode: "batch"`).
 *
 * Live scoring asks the model once per role as the role enters an account's table. In batch mode
 * the queue leaves a queued `score_job` alone, and every `scoringBatchMinutes` the collector
 * gathers them: each is prepared exactly as the live handler prepares it (still open, still this
 * account's to score, room in its budget, inputs changed since the stored score), and the ones
 * that still need the model go into one batch request at half the token price. Each account's share
 * is held against that account's own budget at the batch price, and a poll task watches the batch
 * and applies its results once it has ended — releasing the hold as each result lands, recording
 * each call in `ai_calls` at the batch price, and handing back a request that expired or errored
 * as an ordinary live `score_job`.
 *
 * A score only orders the table: it is written to the fit fields of the account's view and never
 * to `in_table`, which the account's gate alone decides. A score that arrives an hour late
 * therefore moves a row, and never adds or removes one.
 */
import { createHash } from "node:crypto";
import { enqueueStandard, notifyTaskWorkers, recordAiCall, schema, type Task } from "@ava/db";
import {
  scoreBatchCustomId, scoreBatchHolds, scoreBatchPollDelayMs,
  SCORE_BATCH_HOLD_MINUTES, SCORE_BATCH_MAX_ITEMS, type ScoreBatchItem, type ScoreBatchRecord, type TaskPayloads,
} from "@ava/core";
import type { AiUsageRecord, BatchScoreRequest, ScoreJobResult } from "@ava/ai";
import { and, eq, sql } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { budgetLimits, tryReserveAi, type AiHold } from "../budget";
import { log } from "../log";
import { TaskDeferred } from "../queue";
import { checkScorePublication, markScoreState, markScoredWithoutResult, prepareScoreJob, writeScore, type PreparedScore } from "./learning";
import { releaseScoreBatchHolds, requeueScoresLive } from "./score-batch-recovery";

/**
 * How many times a poll task may fail — the provider unreachable, the results stream cut off —
 * before it is given up on and its roles are scored live. With the queue's back-off that is about
 * five hours of trying; a poll that finds the batch still running is not a failure and spends none.
 */
export const SCORE_BATCH_POLL_ATTEMPTS = 10;
/** How long a role whose batch the deployment's day cap refused waits before it is collected again. */
const DEPLOYMENT_CAP_RETRY_MS = 30 * 60_000;

/** The reservation a batch's holds are filed under: the collector task that took them. */
const holdRef = (collectorTaskId: string) => `score_batch:${collectorTaskId}`;

/**
 * Claim up to `limit` queued roles for this collection, in the order the queue would have run
 * them. The rows are this collector's while it prepares them: running, locked under the
 * collector's own slot, so a crash hands them back through the ordinary stale-task recovery. A
 * role marked `live`, and one whose key already has a task running, is left for the queue. With
 * `backgroundOnly` (scoring is live) only a rescore pass's roles, marked `background`, are taken.
 */
async function claimQueuedScores(deps: WorkerDeps, lockedBy: string, limit: number, backgroundOnly: boolean): Promise<Task[]> {
  const rows = await deps.db
    .update(schema.tasks)
    .set({ status: "running", lockedAt: sql`now()`, lockedBy, attempts: sql`${schema.tasks.attempts} + 1`, startedAt: sql`now()` })
    .where(sql`${schema.tasks.id} in (
      select id from tasks t
      where t.type = 'score_job' and t.status = 'queued' and t.run_after <= now() and t.attempts < t.max_attempts
        and coalesce(t.payload->>'live', '') <> 'true'
        and (${!backgroundOnly} or t.payload->>'background' = 'true')
        and (t.dedupe_key is null or not exists (select 1 from tasks r where r.dedupe_key = t.dedupe_key and r.status = 'running'))
      order by t.priority asc, t.run_after asc, t.created_at asc
      limit ${limit}
      for update skip locked)`)
    .returning();
  // `returning` keeps no order; the batch is sent in the order the queue would have run it.
  return rows.sort((a, b) => a.priority - b.priority || a.runAfter.getTime() - b.runAfter.getTime()
    || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/** The fence a collector writes a claimed role through: still running, still under this collection. */
const claimedBy = (task: Task) => and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, "running"),
  eq(schema.tasks.lockedBy, task.lockedBy ?? ""), eq(schema.tasks.attempts, task.attempts));

async function finishClaimed(db: WorkerDeps["db"], task: Task, result: unknown): Promise<void> {
  await db.update(schema.tasks)
    .set({ status: "done", finishedAt: new Date(), result: result as object, error: null, lockedAt: null })
    .where(claimedBy(task));
}

/**
 * Put claimed roles back on the queue with their attempt returned. `live` marks them for the queue
 * to score as ordinary calls — a role this collection could not batch — and `runAfter` holds them
 * back, for a role a deployment cap refused.
 */
async function handBack(db: WorkerDeps["db"], tasks: Task[], why: string, opts: { live?: boolean; runAfter?: Date } = {}): Promise<void> {
  // One transaction, so a role handed back to live scoring wakes a listening worker as it commits
  // (the queue claims it at once, rather than on its next idle poll up to 30 s away).
  await db.transaction(async tx => {
    let returned = 0;
    for (const task of tasks) {
      const rows = await tx.update(schema.tasks)
        .set({
          status: "queued", lockedAt: null, lockedBy: null, attempts: Math.max(0, task.attempts - 1), error: why.slice(0, 2000),
          ...(opts.live ? { payload: { ...task.payload, live: true } } : {}),
          ...(opts.runAfter ? { runAfter: opts.runAfter } : {}),
        })
        .where(claimedBy(task))
        .returning({ id: schema.tasks.id });
      returned += rows.length;
    }
    if (opts.live && !opts.runAfter && returned) await notifyTaskWorkers(tx);
  });
}

interface Collected {
  task: Task;
  prepared: PreparedScore;
  customId: string;
  request: BatchScoreRequest;
}

export async function handleCollectScoreBatch(task: Task, deps: WorkerDeps): Promise<unknown> {
  // Live scoring still batches a rescore pass's roles: nobody is waiting on them.
  const backgroundOnly = (await deps.settings()).scoringMode !== "batch";
  const lockedBy = task.lockedBy ?? `collector:${task.id}`;
  const claimed = await claimQueuedScores(deps, lockedBy, SCORE_BATCH_MAX_ITEMS, backgroundOnly);
  if (!claimed.length) return { collected: 0 };
  // Every claimed role is finished, batched or handed back before this returns; whatever is still
  // here when it throws goes back on the queue as it came, its attempt returned.
  const pending = new Map(claimed.map(row => [row.id, row]));
  const settle = async (rows: Task[], work: () => Promise<void>) => { await work(); for (const row of rows) pending.delete(row.id); };
  const outcome = { collected: claimed.length, done: 0, live: 0, budget: 0, deferred: 0 };
  try {
    const collected: Collected[] = [];
    for (const row of claimed) {
      if (deps.signal?.aborted) throw deps.signal.reason;
      const { userId, jobId } = row.payload as unknown as TaskPayloads["score_job"];
      // The live handler's own checks, in the same order and with the same outcomes.
      const prep = await prepareScoreJob(deps, userId, jobId);
      if ("done" in prep) {
        await settle([row], () => finishClaimed(deps.db, row, prep.done));
        outcome.done++;
        continue;
      }
      const customId = scoreBatchCustomId(row.id, userId, jobId);
      if (!customId || !deps.ai.supportsBatches) {
        await settle([row], () => handBack(deps.db, [row], customId ? "scored live: this model client cannot batch" : "scored live: its ids cannot name a batch request", { live: true }));
        outcome.live++;
        continue;
      }
      collected.push({ task: row, prepared: prep.prepared, customId, request: await deps.ai.scoreJobBatchRequest(prep.prepared.input) });
    }
    if (!collected.length) return outcome;

    // One hold per account, each its share of the batch at the batch price, against that account's
    // own month: an account with no room left is skipped alone, as live scoring skips it.
    const holds = new Map<string, AiHold>();
    const now = deps.now();
    for (const [userId, amount] of scoreBatchHolds(collected.map(item => ({ userId: item.prepared.userId, estimateUsd: item.request.estimateUsd })))) {
      const mine = collected.filter(item => item.prepared.userId === userId);
      const account = await deps.userSettings(userId);
      // No worker id: the batch outlives this worker, so a restart must not release its holds.
      const hold = await tryReserveAi(deps.db, "A5", amount,
        budgetLimits(deps.env, now, { userId, settings: account }, { refId: holdRef(task.id), workerId: undefined }), now, SCORE_BATCH_HOLD_MINUTES);
      if (!("refused" in hold)) {
        holds.set(userId, hold);
        continue;
      }
      if (hold.refused.limit === "account") {
        for (const item of mine) await markScoreState(deps, userId, item.prepared.jobId, "budget");
        await settle(mine.map(item => item.task), async () => { for (const item of mine) await finishClaimed(deps.db, item.task, { skipped: "account ai budget exceeded" }); });
        outcome.budget += mine.length;
      } else {
        // A deployment cap is the operator's, and lifts: the roles wait and are collected again.
        await settle(mine.map(item => item.task), () => handBack(deps.db, mine.map(item => item.task),
          `batch scoring deferred: the deployment's ${hold.refused.limit} AI cap is reached`, { runAfter: new Date(Date.now() + DEPLOYMENT_CAP_RETRY_MS) }));
        outcome.deferred += mine.length;
      }
    }
    const batchable = collected.filter(item => holds.has(item.prepared.userId));
    if (!batchable.length) return outcome;

    let batchId: string;
    try {
      const batch = await deps.ai.submitBatch(batchable.map(item => ({ customId: item.customId, params: item.request.params, meta: item.request.meta })), { signal: deps.signal });
      batchId = batch.id;
    } catch (err) {
      // Nothing was accepted, so nothing is held and nothing waits: every role is scored live.
      for (const hold of holds.values()) await hold.release();
      const why = `scored live: the batch could not be sent (${(err as Error)?.message ?? String(err)})`;
      log.warn("score batch not sent; roles handed back to live scoring", { roles: batchable.length, error: (err as Error)?.message });
      await settle(batchable.map(item => item.task), () => handBack(deps.db, batchable.map(item => item.task), why, { live: true }));
      return { ...outcome, live: outcome.live + batchable.length, sendFailed: (err as Error)?.message ?? String(err) };
    }

    const first = batchable[0]!.request;
    const record: ScoreBatchRecord = {
      batchId,
      submittedAt: deps.now().toISOString(),
      model: first.model,
      promptId: first.meta.promptId,
      promptVersion: first.meta.promptVersion,
      items: batchable.map((item): ScoreBatchItem => ({
        customId: item.customId, taskId: item.task.id, userId: item.prepared.userId, jobId: item.prepared.jobId,
        estimateUsd: item.request.estimateUsd, fingerprint: item.prepared.fingerprint, profileVersion: item.prepared.profileVersion,
        preparedAt: item.prepared.preparedAt.toISOString(),
      })),
      holds: Object.fromEntries([...holds].map(([userId, hold]) => [userId, hold.id])),
    };
    // The batch is the provider's now: its poll task and the hand-over of every role in one
    // transaction, so the record of what was sent and the roles it answers for land together.
    await settle(batchable.map(item => item.task), () => deps.db.transaction(async tx => {
      const writer = tx as unknown as WorkerDeps["db"];
      await enqueueStandard(writer, "poll_score_batch", record,
        { runAfter: new Date(Date.now() + scoreBatchPollDelayMs(0)), maxAttempts: SCORE_BATCH_POLL_ATTEMPTS });
      for (const item of batchable) await finishClaimed(writer, item.task, { batched: batchId });
    }));
    // A backlog longer than one collection is collected again at once rather than in N minutes.
    if (claimed.length >= SCORE_BATCH_MAX_ITEMS)
      await enqueueStandard(deps.db, "collect_score_batch", { reason: "backlog" });
    log.info("score batch sent", { batchId, requests: batchable.length, accounts: holds.size });
    return { ...outcome, batchId, batched: batchable.length, accounts: holds.size,
      heldUsd: Number(batchable.reduce((sum, item) => sum + item.request.estimateUsd, 0).toFixed(6)) };
  } finally {
    if (pending.size) await handBack(deps.db, [...pending.values()], "requeued: the batch collection that claimed it stopped").catch(err =>
      log.error("could not hand back roles a batch collection claimed; the stale sweep will", { roles: pending.size, error: (err as Error)?.message }));
  }
}

/** The ledger row id of one batch result: the same result applied twice writes one row. */
function batchRecordId(batchId: string, customId: string): string {
  const hex = createHash("sha1").update(`${batchId}:${customId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Apply one billed or failed result, once: its ledger row at the batch price, its share taken off
 * the account's hold, and — for a usable answer — the score on the account's view. One
 * transaction behind the poll task's fence, so a poll retried after a crash re-applies nothing: a
 * result whose row is already in the ledger was applied in full.
 */
async function applyResult(deps: WorkerDeps, record: ScoreBatchRecord, item: ScoreBatchItem, usage: AiUsageRecord, score: ScoreJobResult | null | undefined): Promise<"scored" | "unscored" | "stale" | "failed" | "applied"> {
  const id = batchRecordId(record.batchId, item.customId);
  const holdId = record.holds[item.userId];
  return deps.db.transaction(async tx => {
    const writer = tx as unknown as WorkerDeps["db"];
    await deps.assertOwnership?.(writer);
    const seen = await writer.execute(sql`select 1 from ai_calls where id = ${id}`);
    if (seen.rows.length) return "applied" as const;
    await recordAiCall(writer, item.userId, { ...usage, id });
    if (holdId) await writer.execute(sql`update ai_reservations set amount = greatest(0, amount - ${item.estimateUsd}) where id = ${holdId}`);
    // `undefined`: the request errored and created no message, so the view is left as it was.
    if (score === undefined) return "failed" as const;
    const now = deps.now();
    const prepared = { ...item, preparedAt: new Date(item.preparedAt) };
    if (!await checkScorePublication(deps, writer, prepared)) return "stale" as const;
    if (score === null) {
      return await markScoredWithoutResult(writer, now, prepared) ? "unscored" as const : "stale" as const;
    }
    return (await writeScore(writer, now, item, score, { preparedAt: prepared.preparedAt })) ? "scored" as const : "stale" as const;
  });
}

export async function handlePollScoreBatch(task: Task, deps: WorkerDeps): Promise<unknown> {
  const record = task.payload as unknown as ScoreBatchRecord;
  const batch = await deps.ai.retrieveBatch(record.batchId, { signal: deps.signal });
  if (batch.processing_status !== "ended") {
    const running = deps.now().getTime() - new Date(record.submittedAt).getTime();
    return new TaskDeferred(new Date(Date.now() + scoreBatchPollDelayMs(running)), { status: batch.processing_status, counts: batch.request_counts ?? null });
  }

  const items = new Map(record.items.map(item => [item.customId, item]));
  const answered = new Set<string>();
  const requeue: ScoreBatchItem[] = [];
  const outcome = { scored: 0, unscored: 0, stale: 0, failed: 0, expired: 0, canceled: 0, applied: 0, requeued: 0 };
  const context = (item: ScoreBatchItem) => ({
    batchId: record.batchId, model: record.model, promptId: record.promptId, promptVersion: record.promptVersion,
    submittedAt: new Date(record.submittedAt), now: deps.now(), userId: item.userId, jobId: item.jobId,
  });
  // Results come in any order; each is matched to its role by `custom_id`, never by position.
  for await (const result of deps.ai.batchResults(record.batchId, { signal: deps.signal })) {
    const item = items.get(result.custom_id);
    if (!item || answered.has(result.custom_id)) continue;
    answered.add(result.custom_id);
    if (result.result.type === "succeeded") {
      const { score, record: usage } = deps.ai.readBatchScore(result.result.message, context(item));
      outcome[await applyResult(deps, record, item, usage, score)]++;
    } else if (result.result.type === "errored") {
      // Recorded as the failed call it was — at no cost, since nothing was billed — and scored live.
      // Handed back even when a retried poll finds it already recorded: the hand-back is idempotent.
      outcome[await applyResult(deps, record, item, deps.ai.batchErrorRecord(result.result.error, context(item)), undefined)]++;
      requeue.push(item);
    } else {
      // Never sent to the model, never billed: scored live instead.
      outcome[result.result.type]++;
      requeue.push(item);
    }
  }
  // A role the results never mentioned is scored live too, rather than left waiting.
  for (const item of record.items) if (!answered.has(item.customId)) requeue.push(item);
  outcome.requeued = await requeueScoresLive(deps.db, requeue);
  // Whatever the holds still carry — the shares of requests that were never billed — is released:
  // a role scored live takes its own hold when it runs.
  await releaseScoreBatchHolds(deps.db, record);
  log.info("score batch applied", { batchId: record.batchId, ...outcome });
  return { batchId: record.batchId, ...outcome };
}
