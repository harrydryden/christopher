/**
 * Background scoring through the Message Batches API, against the database: the collector that
 * gathers queued scores into one batch, the poll task that applies its results, the switch
 * between live and batch scoring, and the ledger the batch leaves.
 *
 * The provider is a fake batch resource the test ends by hand, so a batch that is still running,
 * one that ended with every kind of result, and one that could not be sent are all reachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aiUsageByAccount, costPerScoredRole, createDb, enqueueTask, queueScoring, schema, totalAiSpend, type Db, type Task } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { parseScoreBatchCustomId, type ScoreBatchRecord } from "@ava/core";
import {
  BATCH_ERROR_PREFIX, PROMPTS, estimateBatchCostUsd, estimateCostUsd,
  type AiBatchesLike, type AiBatchLike, type AiBatchMeta, type AiBatchResultLike, type AiCallMeta, type AiClientLike, type ParseResponse,
} from "@ava/ai";
import { and, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { claimTask, sleep, TaskDeferred, TaskQueue } from "./queue";
import { TaskWakeup } from "./task-wakeup";
import { requeueScoresLive } from "./handlers/score-batch-recovery";
import { handleCollectScoreBatch, handlePollScoreBatch } from "./handlers/score-batch";
import { handleScoreJob } from "./handlers/learning";
import { onAbandon } from "./handlers/abandon";
import { schedulerTick } from "./scheduler";
import { ensureTestUser, TEST_DATABASE_URL } from "./test-users";

const MODEL = "claude-sonnet-5";
const now = new Date("2026-09-27T09:00:00Z");

/** A scripted provider: live A5 calls answer at once; batches wait until the test ends them. */
const provider = {
  live: [] as Array<{ params: Record<string, unknown>; meta?: AiCallMeta }>,
  sent: [] as Array<{ params: Parameters<AiBatchesLike["create"]>[0]; meta?: AiBatchMeta }>,
  batches: new Map<string, { batch: AiBatchLike; results: AiBatchResultLike[] }>(),
  refuseBatches: false,
  reset() {
    this.live = []; this.sent = []; this.batches = new Map(); this.refuseBatches = false;
  },
  end(id: string, results: AiBatchResultLike[]) {
    const held = this.batches.get(id)!;
    held.batch = { ...held.batch, processing_status: "ended" };
    held.results = results;
  },
};
const answer = (score = 72): ParseResponse => ({
  parsed_output: { score, verdict: score >= 70 ? "strong" : "possible", rationale: "Operations fit.", flags: [] },
  usage: { input_tokens: 1_500, output_tokens: 150, cache_creation_input_tokens: 900, cache_read_input_tokens: 0 },
  stop_reason: "end_turn", model: MODEL,
});
const batchResource: AiBatchesLike = {
  async create(params, _options, meta) {
    if (provider.refuseBatches) throw new Error("batch endpoint unavailable");
    provider.sent.push({ params, meta });
    const batch: AiBatchLike = { id: `msgbatch_${String(provider.sent.length).padStart(4, "0")}`, processing_status: "in_progress" };
    provider.batches.set(batch.id, { batch, results: [] });
    return { ...batch };
  },
  async retrieve(id) { return { ...provider.batches.get(id)!.batch }; },
  async results(id) {
    const results = provider.batches.get(id)!.results;
    return { async *[Symbol.asyncIterator]() { yield* results; } };
  },
};
const client: AiClientLike = {
  messages: {
    create: async (params, _options, meta) => { provider.live.push({ params, meta }); return answer(64); },
    batches: batchResource,
  },
};

let deps: WorkerDeps;
let db: Db;
let alice: string;
let bob: string;

beforeAll(async () => {
  const bootstrap = createDb(TEST_DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0, aiClient: client });
  db = deps.db;
  alice = (await ensureTestUser(db, "batch-alice@example.com")).id;
  bob = (await ensureTestUser(db, "batch-bob@example.com")).id;
}, 60_000);

// The last test leaves scoring in batch mode, and a file that runs after this one reads the same
// settings table: its live claims would then skip every score task. Put the setting back.
afterAll(async () => {
  await db.execute(sql`truncate settings`);
  await deps?.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate tasks, companies, career_sources, jobs, settings, user_settings, company_subscriptions, user_jobs,
    job_events, decisions, preference_profiles, ai_calls, ai_reservations, cv_libraries restart identity cascade`);
  provider.reset();
  await setMode("batch");
});

async function setMode(mode: "live" | "batch", minutes = 10) {
  // A tick at nine on a Sunday would also queue the daily run and the week's jobs; this suite's
  // queues carry only scoring handlers, so both are moved out of the way.
  for (const [key, value] of [["scoringMode", mode], ["scoringBatchMinutes", minutes], ["scanTime", "23:59"], ["weeklyDay", 3]] as const)
    await db.insert(schema.settings).values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } });
  deps.invalidateSettings();
}

let postings = 0;
/** One open posting, with `userId`'s view of it in the table (or out of it, shortlisted). */
async function seedRole(userId: string, over: { title?: string; inTable?: boolean } = {}) {
  const n = ++postings;
  const [company] = await db.insert(schema.companies).values({ name: `Acme ${n}`, domain: `acme${n}.test`, homepageUrl: `https://acme${n}.test` }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: `https://acme${n}.test/jobs` }).returning();
  const title = over.title ?? "Operations Manager";
  const [job] = await db.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: `id:${n}`, title, normalizedTitle: title.toLowerCase(),
    url: `https://acme${n}.test/jobs/${n}`, location: "London", locations: ["London"], status: "open",
  }).returning();
  await db.insert(schema.userJobs).values({ userId, jobId: job!.id, keywordMatched: true, keywordTerms: ["operations"], inTable: over.inTable ?? true, createdAt: now, updatedAt: now });
  return job!;
}

const queueScore = async (userId: string, jobId: string) => {
  const payload = { userId, jobId };
  return (await enqueueTask(db, "score_job", payload, { dedupeKey: `score_job:${userId}:${jobId}`, priority: 4 }))!;
};
const viewOf = async (userId: string, jobId: string) =>
  (await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))))[0]!;
const tasksOf = (type: Task["type"]) => db.select().from(schema.tasks).where(eq(schema.tasks.type, type));
const holds = () => db.select().from(schema.aiReservations);
/** A collector as the queue would hand it over: claimed, under a slot's lock. */
async function collectorTask(): Promise<Task> {
  await enqueueTask(db, "collect_score_batch", { reason: "schedule" }, { dedupeKey: "collect_score_batch", priority: 4 });
  return (await claimTask(db, "collector-test#0", "all", [], { batchScoring: true }))!;
}
async function pollTask(): Promise<Task> {
  await db.update(schema.tasks).set({ runAfter: sql`now()` }).where(eq(schema.tasks.type, "poll_score_batch"));
  const task = (await claimTask(db, "poll-test#0", "all", [], { batchScoring: true }))!;
  expect(task.type).toBe("poll_score_batch");
  return task;
}
const succeeded = (customId: string, score = 72): AiBatchResultLike => ({ custom_id: customId, result: { type: "succeeded", message: answer(score) } });

describe("the collector", () => {
  it("gathers every queued role into one batch, names each by task, account and role, and holds each account's share", async () => {
    const [a1, a2, b1] = [await seedRole(alice), await seedRole(alice, { title: "Head of Operations" }), await seedRole(bob)];
    const tasks = [await queueScore(alice, a1.id), await queueScore(alice, a2.id), await queueScore(bob, b1.id)];

    const outcome = await handleCollectScoreBatch(await collectorTask(), deps) as Record<string, unknown>;
    expect(outcome).toMatchObject({ collected: 3, batched: 3, accounts: 2, batchId: "msgbatch_0001" });
    expect(provider.sent).toHaveLength(1);
    const requests = provider.sent[0]!.params.requests;
    // custom_id = taskId:userId:jobId, in the provider's 64 characters of [a-zA-Z0-9_-].
    // Three tasks queued in the same instant tie on priority, run_after and created_at, and the
    // collector then orders them by id, so the batch's order is not insertion order: compare as a set.
    const byTask = (items: Array<{ taskId?: string; userId?: string; jobId?: string } | null>) =>
      items.map(item => item ?? {}).sort((a, b) => (a.taskId ?? "").localeCompare(b.taskId ?? ""));
    expect(byTask(requests.map(item => parseScoreBatchCustomId(item.custom_id)))).toEqual(byTask([
      { taskId: tasks[0], userId: alice, jobId: a1.id }, { taskId: tasks[1], userId: alice, jobId: a2.id }, { taskId: tasks[2], userId: bob, jobId: b1.id },
    ]));
    for (const item of requests) {
      expect(item.custom_id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(item.params).toMatchObject({ model: MODEL, max_tokens: PROMPTS.A5.maxTokens });
      expect(item.params).not.toHaveProperty("fallbacks");
      expect(provider.sent[0]!.meta!.requests[item.custom_id]).toEqual({ promptId: "A5", promptVersion: PROMPTS.A5.version });
    }
    expect(provider.live).toHaveLength(0);

    // The poll task carries the batch's record; each role's task is handed over, done.
    const [poll] = await tasksOf("poll_score_batch");
    const record = poll!.payload as unknown as ScoreBatchRecord;
    expect(record).toMatchObject({ batchId: "msgbatch_0001", model: MODEL, promptId: "A5", promptVersion: PROMPTS.A5.version });
    expect(record.items.map(item => item.taskId).sort()).toEqual([...tasks].sort());
    expect((await tasksOf("score_job")).map(task => [task.status, task.result])).toEqual(tasks.map(() => ["done", { batched: "msgbatch_0001" }]));

    // One hold per account, the sum of its requests at the batch price, living as long as a batch can.
    const held = await holds();
    expect(held).toHaveLength(2);
    const share = (userId: string) => record.items.filter(item => item.userId === userId).reduce((sum, item) => sum + item.estimateUsd, 0);
    expect(Number(held.find(row => row.userId === alice)!.amount)).toBeCloseTo(share(alice), 5);
    expect(Number(held.find(row => row.userId === bob)!.amount)).toBeCloseTo(share(bob), 5);
    expect(record.holds).toEqual({ [alice]: held.find(row => row.userId === alice)!.id, [bob]: held.find(row => row.userId === bob)!.id });
    for (const row of held) {
      expect(row.workerId).toBeNull();
      expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(24 * 3600_000);
    }
    // At the batch price: the same tokens held live would be twice as much.
    const item = record.items[0]!;
    expect(item.estimateUsd).toBeGreaterThan(0);
    expect(item.estimateUsd).toBeLessThan(estimateCostUsd(MODEL, { inputTokens: 20_000, outputTokens: PROMPTS.A5.maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  });

  it("skips an account with no room left, as live scoring does, and still batches the others", async () => {
    const [a1, b1] = [await seedRole(alice), await seedRole(bob)];
    await queueScore(alice, a1.id);
    await queueScore(bob, b1.id);
    await db.insert(schema.userSettings).values({ userId: alice, key: "aiBudgetUsd", value: 0.000001 });
    deps.invalidateSettings();
    await handleCollectScoreBatch(await collectorTask(), deps);
    expect(provider.sent[0]!.params.requests.map(item => parseScoreBatchCustomId(item.custom_id)!.userId)).toEqual([bob]);
    expect((await viewOf(alice, a1.id)).scoreState).toBe("budget");
    const [aliceTask] = (await tasksOf("score_job")).filter(task => (task.payload as { userId: string }).userId === alice);
    expect(aliceTask).toMatchObject({ status: "done", result: { skipped: "account ai budget exceeded" } });
    expect((await holds()).map(row => row.userId)).toEqual([bob]);
  });

  it("finishes a role live scoring would skip without asking the model, and never batches it", async () => {
    const closed = await seedRole(alice);
    await db.update(schema.jobs).set({ status: "closed" }).where(eq(schema.jobs.id, closed.id));
    await queueScore(alice, closed.id);
    expect(await handleCollectScoreBatch(await collectorTask(), deps)).toMatchObject({ collected: 1, done: 1 });
    expect(provider.sent).toHaveLength(0);
    expect((await tasksOf("score_job"))[0]).toMatchObject({ status: "done", result: { skipped: "job is closed" } });
    expect(await tasksOf("poll_score_batch")).toHaveLength(0);
  });

  it("hands every role back to live scoring, holding nothing, when the batch cannot be sent", async () => {
    const role = await seedRole(alice);
    await queueScore(alice, role.id);
    provider.refuseBatches = true;
    expect(await handleCollectScoreBatch(await collectorTask(), deps)).toMatchObject({ live: 1, sendFailed: "batch endpoint unavailable" });
    const [task] = await tasksOf("score_job");
    expect(task).toMatchObject({ status: "queued", attempts: 0, payload: { userId: alice, jobId: role.id, live: true } });
    expect(await holds()).toHaveLength(0);
    // The queue scores it as an ordinary call, batch mode or not.
    const claimed = await claimTask(db, "w#0", "all", [], { batchScoring: true });
    expect(claimed?.id).toBe(task!.id);
  });
});

describe("the mode switch", () => {
  it("leaves live scoring exactly as it was: the queue claims a score, the model is asked at once, the collector does nothing", async () => {
    await setMode("live");
    const role = await seedRole(alice);
    await queueScore(alice, role.id);
    // With nothing marked background there is nothing for it to take.
    expect(await handleCollectScoreBatch(await collectorTask(), deps)).toEqual({ collected: 0 });
    await schedulerTick(deps);
    expect(await tasksOf("collect_score_batch")).toHaveLength(1); // only the one this test queued
    const queue = new TaskQueue(deps, { score_job: handleScoreJob }, { concurrency: 1, workerId: "live-test" });
    expect(await queue.drain()).toBe(1);
    expect(provider.live).toHaveLength(1);
    expect(provider.sent).toHaveLength(0);
    expect(await viewOf(alice, role.id)).toMatchObject({ fitScore: 64, scoreState: "scored" });
  });

  it("in batch mode leaves a queued score for the collector, but runs one marked live", async () => {
    const [waiting, handedBack] = [await seedRole(alice), await seedRole(alice)];
    await queueScore(alice, waiting.id);
    await enqueueTask(db, "score_job", { userId: alice, jobId: handedBack.id, live: true }, { dedupeKey: `score_job:${alice}:${handedBack.id}`, priority: 4 });
    const queue = new TaskQueue(deps, { score_job: handleScoreJob }, { concurrency: 1, workerId: "batch-test" });
    expect(await queue.drain()).toBe(1);
    expect(provider.live).toHaveLength(1);
    expect((await viewOf(alice, handedBack.id)).fitScore).toBe(64);
    expect((await viewOf(alice, waiting.id)).fitScore).toBeNull();
    expect((await tasksOf("score_job")).find(task => (task.payload as { jobId: string }).jobId === waiting.id)!.status).toBe("queued");
  });

  it("in live mode batches only a rescore pass's roles, and the queue scores the rest at once", async () => {
    await setMode("live");
    const [fresh, rescored, handedBack] = [await seedRole(alice), await seedRole(alice), await seedRole(bob)];
    await queueScore(alice, fresh.id);
    await enqueueTask(db, "score_job", { userId: alice, jobId: rescored.id, background: true }, { dedupeKey: `score_job:${alice}:${rescored.id}`, priority: 4 });
    await enqueueTask(db, "score_job", { userId: bob, jobId: handedBack.id, background: true, live: true }, { dedupeKey: `score_job:${bob}:${handedBack.id}`, priority: 4 });

    // The scheduler queues a collection because a background role is waiting.
    await schedulerTick(deps);
    expect(await tasksOf("collect_score_batch")).toHaveLength(1);
    // Claimed as a slot would, but by type: at the same priority the queue could take a score first.
    const [collector] = await db.update(schema.tasks).set({ status: "running", lockedBy: "collector-test#0", lockedAt: new Date(), attempts: 1 })
      .where(eq(schema.tasks.type, "collect_score_batch")).returning() as [Task];
    expect(await handleCollectScoreBatch(collector, deps)).toMatchObject({ collected: 1, batched: 1 });
    expect(provider.sent[0]!.params.requests.map(item => parseScoreBatchCustomId(item.custom_id)?.jobId)).toEqual([rescored.id]);

    // The queue takes the new role and the handed-back one live, and leaves nothing else behind.
    const queue = new TaskQueue(deps, { score_job: handleScoreJob }, { concurrency: 1, workerId: "live-mixed" });
    expect(await queue.drain()).toBe(2);
    expect(provider.live).toHaveLength(2);
    expect((await viewOf(alice, fresh.id)).fitScore).toBe(64);
    expect((await viewOf(bob, handedBack.id)).fitScore).toBe(64);
  });

  it("promotes a background score someone now waits on out of the collector's hands", async () => {
    await setMode("live");
    const role = await seedRole(alice);
    await enqueueTask(db, "score_job", { userId: alice, jobId: role.id, background: true }, { dedupeKey: `score_job:${alice}:${role.id}`, priority: 4 });
    await queueScoring(db, [{ userId: alice, jobId: role.id, priority: 1 }], now, { promote: true });
    const [task] = await tasksOf("score_job");
    expect(task).toMatchObject({ priority: 1, payload: { userId: alice, jobId: role.id } });
  });

  it("in live mode schedules no collection while no background role waits", async () => {
    await setMode("live");
    await queueScore(alice, (await seedRole(alice)).id);
    await schedulerTick(deps);
    expect(await tasksOf("collect_score_batch")).toHaveLength(0);
  });

  it("schedules one collection every interval, only in batch mode", async () => {
    await schedulerTick(deps);
    await schedulerTick(deps);
    expect(await tasksOf("collect_score_batch")).toHaveLength(1);
  });
});

describe("a hand-back to live scoring", () => {
  /** A listener that has connected, and a wait on it that says when it ended. */
  async function listening() {
    const wakeup = new TaskWakeup(TEST_DATABASE_URL);
    wakeup.start();
    while (!wakeup.listening) await sleep(20);
    let woken = false;
    const started = performance.now();
    let after = 0;
    void wakeup.wait(5_000).then(() => { woken = true; after = performance.now() - started; });
    return { wakeup, woken: () => woken, after: () => after };
  }

  it("wakes a waiting slot at once when the collector hands roles back", async () => {
    const role = await seedRole(alice);
    await queueScore(alice, role.id);
    provider.refuseBatches = true;
    const collector = await collectorTask();
    const watch = await listening();
    try {
      await handleCollectScoreBatch(collector, deps);
      const deadline = Date.now() + 1_000;
      while (!watch.woken() && Date.now() < deadline) await sleep(10);
      expect(watch.woken()).toBe(true);
      expect(watch.after()).toBeLessThan(1_000);
    } finally {
      await watch.wakeup.stop();
    }
  });

  it("wakes a waiting slot when a role already queued is marked live", async () => {
    const role = await seedRole(alice);
    await queueScore(alice, role.id);
    const watch = await listening();
    try {
      // The queued task takes the mark; nothing new is inserted.
      expect(await requeueScoresLive(db, [{ userId: alice, jobId: role.id }])).toBe(1);
      expect(await tasksOf("score_job")).toHaveLength(1);
      const deadline = Date.now() + 1_000;
      while (!watch.woken() && Date.now() < deadline) await sleep(10);
      expect(watch.woken()).toBe(true);
    } finally {
      await watch.wakeup.stop();
    }
  });
});

describe("the poll applier", () => {
  async function submitted(roles: Array<{ userId: string; inTable?: boolean }>) {
    const jobs = [];
    for (const role of roles) {
      const job = await seedRole(role.userId, { inTable: role.inTable });
      if (role.inTable === false) await db.insert(schema.decisions).values({ userId: role.userId, jobId: job.id, decision: "apply", reason: "",
        jobTitle: job.title, companyName: "Acme", createdAt: now });
      await queueScore(role.userId, job.id);
      jobs.push(job);
    }
    await handleCollectScoreBatch(await collectorTask(), deps);
    const [poll] = await tasksOf("poll_score_batch");
    return { jobs, record: poll!.payload as unknown as ScoreBatchRecord };
  }

  it("waits while the batch runs, putting itself back without spending an attempt", async () => {
    await submitted([{ userId: alice }]);
    const task = await pollTask();
    const outcome = await handlePollScoreBatch(task, deps);
    expect(outcome).toBeInstanceOf(TaskDeferred);
    // Through the queue, the same wait is a deferral: queued again, its attempt returned.
    const queue = new TaskQueue(deps, { poll_score_batch: handlePollScoreBatch }, { concurrency: 1, workerId: "poll-q" });
    await db.update(schema.tasks).set({ status: "queued", lockedBy: null, lockedAt: null, attempts: 0 }).where(eq(schema.tasks.id, task.id));
    expect(await queue.drain()).toBe(1);
    const [again] = await tasksOf("poll_score_batch");
    expect(again).toMatchObject({ status: "queued", attempts: 0, result: { status: "in_progress" } });
    expect(again!.runAfter.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it("applies a success: the score on the view, a ledger row at the batch price with the prompt, the hold let go", async () => {
    const { jobs, record } = await submitted([{ userId: alice }]);
    provider.end(record.batchId, [succeeded(record.items[0]!.customId, 88)]);
    expect(await handlePollScoreBatch(await pollTask(), deps)).toMatchObject({ scored: 1, requeued: 0 });
    expect(await viewOf(alice, jobs[0]!.id)).toMatchObject({ fitScore: 88, fitVerdict: "strong", scoreState: "scored", scoreInputHash: record.items[0]!.fingerprint });
    const [call] = await db.select().from(schema.aiCalls);
    const tokens = { inputTokens: 1_500, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 900 };
    expect(call).toMatchObject({ callSite: "A5", model: MODEL, userId: alice, ok: true, promptId: "A5", promptVersion: PROMPTS.A5.version,
      refType: "job", refId: jobs[0]!.id, requestId: record.batchId, ...tokens });
    expect(Number(call!.costUsd)).toBeCloseTo(estimateBatchCostUsd(MODEL, tokens), 6);
    expect(Number(call!.costUsd)).toBeCloseTo(estimateCostUsd(MODEL, tokens) / 2, 6);
    expect(await holds()).toHaveLength(0);
    expect(await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.type, "scored"))).toHaveLength(1);
  });

  it("hands an expired request back to live scoring, billing nothing", async () => {
    const { jobs, record } = await submitted([{ userId: alice }]);
    provider.end(record.batchId, [{ custom_id: record.items[0]!.customId, result: { type: "expired" } }]);
    expect(await handlePollScoreBatch(await pollTask(), deps)).toMatchObject({ expired: 1, requeued: 1 });
    expect(await db.select().from(schema.aiCalls)).toHaveLength(0);
    const live = (await tasksOf("score_job")).filter(task => task.status === "queued");
    expect(live.map(task => task.payload)).toEqual([{ userId: alice, jobId: jobs[0]!.id, live: true }]);
    expect(await holds()).toHaveLength(0);
    expect((await viewOf(alice, jobs[0]!.id)).fitScore).toBeNull();
  });

  it("records an errored request as a failed call that cost nothing, and hands it back to live scoring", async () => {
    const { jobs, record } = await submitted([{ userId: alice }]);
    provider.end(record.batchId, [{ custom_id: record.items[0]!.customId, result: { type: "errored", error: { type: "error", error: { type: "api_error", message: "Internal" } } } }]);
    expect(await handlePollScoreBatch(await pollTask(), deps)).toMatchObject({ failed: 1, requeued: 1 });
    const [call] = await db.select().from(schema.aiCalls);
    expect(call).toMatchObject({ ok: false, costUsd: 0, userId: alice, promptId: "A5", error: `${BATCH_ERROR_PREFIX} api_error: Internal` });
    expect((await tasksOf("score_job")).filter(task => task.status === "queued").map(task => task.payload)).toEqual([{ userId: alice, jobId: jobs[0]!.id, live: true }]);
  });

  it("applies a partial batch — some scored, some expired, one never mentioned — and a second run applies nothing twice", async () => {
    const { jobs, record } = await submitted([{ userId: alice }, { userId: alice }, { userId: bob }, { userId: bob }]);
    const itemFor = (index: number) => record.items.find(item => item.jobId === jobs[index]!.id)!;
    // Results come in any order; the fourth role's never comes at all.
    provider.end(record.batchId, [
      { custom_id: itemFor(2).customId, result: { type: "expired" } },
      succeeded(itemFor(1).customId, 40),
      succeeded(itemFor(0).customId, 90),
    ]);
    const task = await pollTask();
    expect(await handlePollScoreBatch(task, deps)).toMatchObject({ scored: 2, expired: 1, requeued: 2 });
    expect([(await viewOf(alice, jobs[0]!.id)).fitScore, (await viewOf(alice, jobs[1]!.id)).fitScore]).toEqual([90, 40]);
    expect((await tasksOf("score_job")).filter(task => task.status === "queued").map(task => (task.payload as { jobId: string }).jobId).sort())
      .toEqual([jobs[2]!.id, jobs[3]!.id].sort());
    expect(await db.select().from(schema.aiCalls)).toHaveLength(2);
    // A poll retried after a crash re-applies nothing and queues nothing twice.
    expect(await handlePollScoreBatch(task, deps)).toMatchObject({ scored: 0, applied: 2 });
    expect(await db.select().from(schema.aiCalls)).toHaveLength(2);
    expect((await tasksOf("score_job")).filter(task => task.status === "queued")).toHaveLength(2);
  });

  it("takes each result's share off its account's hold as it lands", async () => {
    const { record } = await submitted([{ userId: alice }, { userId: alice }]);
    const before = Number((await holds())[0]!.amount);
    // One result at a time: a results stream that stops after the first.
    provider.end(record.batchId, [succeeded(record.items[0]!.customId)]);
    const results = provider.batches.get(record.batchId)!;
    let observed: number | null = null;
    const original = batchResource.results;
    batchResource.results = async id => {
      const inner = await original(id);
      return { async *[Symbol.asyncIterator]() {
        for await (const result of inner) yield result;
        observed = Number((await holds())[0]!.amount);
      } };
    };
    try {
      await handlePollScoreBatch(await pollTask(), deps);
    } finally {
      batchResource.results = original;
    }
    expect(results.results).toHaveLength(1);
    expect(observed).toBeCloseTo(before - record.items[0]!.estimateUsd, 5);
    expect(await holds()).toHaveLength(0);
  });

  it("never changes table membership: a late score orders a row, and adds or removes none", async () => {
    const { jobs, record } = await submitted([{ userId: alice }, { userId: alice, inTable: false }, { userId: bob }]);
    // Bob's gate is narrowed while the batch runs: his role leaves the table before its score lands.
    await db.update(schema.userJobs).set({ inTable: false }).where(and(eq(schema.userJobs.userId, bob), eq(schema.userJobs.jobId, jobs[2]!.id)));
    const before = await db.select({ userId: schema.userJobs.userId, jobId: schema.userJobs.jobId, inTable: schema.userJobs.inTable }).from(schema.userJobs);
    const scoreFor = new Map([[jobs[0]!.id, 95], [jobs[1]!.id, 10], [jobs[2]!.id, 80]]);
    provider.end(record.batchId, record.items.map(item => succeeded(item.customId, scoreFor.get(item.jobId))));
    expect(await handlePollScoreBatch(await pollTask(), deps)).toMatchObject({ scored: 3 });
    const after = await db.select({ userId: schema.userJobs.userId, jobId: schema.userJobs.jobId, inTable: schema.userJobs.inTable }).from(schema.userJobs);
    expect(after.sort((a, b) => a.jobId.localeCompare(b.jobId))).toEqual(before.sort((a, b) => a.jobId.localeCompare(b.jobId)));
    expect(after.find(row => row.jobId === jobs[0]!.id)!.inTable).toBe(true);
    expect(after.find(row => row.jobId === jobs[1]!.id)!.inTable).toBe(false);
    expect(after.find(row => row.jobId === jobs[2]!.id)!.inTable).toBe(false);
    expect((await viewOf(bob, jobs[2]!.id)).fitScore).toBe(80);
  });

  it("never lets a score from older inputs replace one computed since", async () => {
    const { jobs, record } = await submitted([{ userId: alice }]);
    // A live rescore landed after this batch read its inputs.
    await db.update(schema.userJobs).set({ fitScore: 55, fitScoredAt: new Date(now.getTime() + 60_000) }).where(eq(schema.userJobs.jobId, jobs[0]!.id));
    provider.end(record.batchId, [succeeded(record.items[0]!.customId, 99)]);
    expect(await handlePollScoreBatch(await pollTask(), deps)).toMatchObject({ stale: 1 });
    expect((await viewOf(alice, jobs[0]!.id)).fitScore).toBe(55);
    // It was still billed, so it is still in the ledger.
    expect(await db.select().from(schema.aiCalls)).toHaveLength(1);
  });

  it("puts batch spend in the figures Health reports", async () => {
    const { record } = await submitted([{ userId: alice }, { userId: bob }]);
    provider.end(record.batchId, record.items.map(item => succeeded(item.customId)));
    await handlePollScoreBatch(await pollTask(), deps);
    const expected = 2 * estimateBatchCostUsd(MODEL, { inputTokens: 1_500, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 900 });
    expect(await totalAiSpend(db, new Date(Date.now() - 3600_000))).toBeCloseTo(expected, 6);
    const usage = await aiUsageByAccount(db, new Date(Date.now() - 3600_000));
    expect(usage.filter(row => row.callSite === "A5").reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(expected, 6);
    expect(await costPerScoredRole(db, 1)).toMatchObject({ roles: 2, calls: 2 });
  });

  it("when given up on, scores its roles live and lets its holds go", async () => {
    const { jobs } = await submitted([{ userId: alice }]);
    const [poll] = await tasksOf("poll_score_batch");
    expect(poll!.maxAttempts).toBe(10);
    await onAbandon.poll_score_batch!(poll!, deps, "provider unreachable");
    expect(await holds()).toHaveLength(0);
    expect((await tasksOf("score_job")).filter(task => task.status === "queued").map(task => task.payload)).toEqual([{ userId: alice, jobId: jobs[0]!.id, live: true }]);
  });
});

describe("through the task queue", () => {
  it("collects on schedule, waits for the batch, applies what it answered and scores the rest live", async () => {
    const [a1, a2, b1] = [await seedRole(alice), await seedRole(alice), await seedRole(bob)];
    for (const [userId, job] of [[alice, a1], [alice, a2], [bob, b1]] as const) await queueScore(userId, job.id);
    const queue = new TaskQueue(deps, { score_job: handleScoreJob, collect_score_batch: handleCollectScoreBatch, poll_score_batch: handlePollScoreBatch },
      { concurrency: 1, workerId: "batch-queue" });

    // Nothing is scored live while the collector has not run.
    expect(await queue.drain()).toBe(0);
    await schedulerTick(deps);
    expect(await queue.drain()).toBe(1);
    expect(provider.sent).toHaveLength(1);
    expect(provider.live).toHaveLength(0);

    // The poll finds the batch running and waits.
    await db.update(schema.tasks).set({ runAfter: sql`now()` }).where(eq(schema.tasks.type, "poll_score_batch"));
    expect(await queue.drain()).toBe(1);
    expect((await tasksOf("poll_score_batch"))[0]!.status).toBe("queued");

    // The batch ends: two scored, one expired.
    const [, [record]] = [null, (await tasksOf("poll_score_batch")).map(task => task.payload as unknown as ScoreBatchRecord)];
    const byJob = new Map(record!.items.map(item => [item.jobId, item.customId]));
    provider.end(record!.batchId, [succeeded(byJob.get(a1.id)!, 91), { custom_id: byJob.get(a2.id)!, result: { type: "expired" } }, succeeded(byJob.get(b1.id)!, 33)]);
    await db.update(schema.tasks).set({ runAfter: sql`now()` }).where(eq(schema.tasks.type, "poll_score_batch"));
    // The poll, then the expired role as an ordinary live call.
    expect(await queue.drain()).toBe(2);
    expect((await tasksOf("poll_score_batch"))[0]).toMatchObject({ status: "done", result: { scored: 2, expired: 1, requeued: 1 } });
    expect(provider.live).toHaveLength(1);
    expect([(await viewOf(alice, a1.id)).fitScore, (await viewOf(alice, a2.id)).fitScore, (await viewOf(bob, b1.id)).fitScore]).toEqual([91, 64, 33]);

    // Two calls at the batch price and one at the standard price, each for its own account.
    const calls = await db.select().from(schema.aiCalls);
    expect(calls.map(call => call.requestId?.startsWith("msgbatch_") ? "batch" : "live").sort()).toEqual(["batch", "batch", "live"]);
    expect(await holds()).toHaveLength(0);
  });
});
