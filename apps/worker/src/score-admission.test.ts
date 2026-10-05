import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, queueScoring, requestScores, schema, type Db, type Task } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { AccountVerificationRequiredError, createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { ensureTestUser } from "./test-users";
import { admitScores, handleAdmitScores } from "./score-admission";
import { onAbandon } from "./handlers/abandon";
import { handleRescoreAll, handleScoreJob, prepareScoreJob } from "./handlers/learning";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
let deps: WorkerDeps;
let db: Db;
const now = new Date("2026-09-29T12:00:00Z");

beforeAll(async () => {
  const bootstrap = createDb(url, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = url;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);
afterAll(async () => { await deps?.close(); });
beforeEach(async () => {
  await db.execute(sql`truncate tasks, companies, career_sources, jobs, user_jobs, decisions, settings, user_settings, ai_calls, ai_reservations restart identity cascade`);
  deps.invalidateSettings();
});

async function role(email = "admission@example.com") {
  const user = await ensureTestUser(db, email);
  const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: `${email.split("@")[0]}.example`, homepageUrl: "https://acme.example" }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs" }).returning();
  const [job] = await db.insert(schema.jobs).values({ companyId: company!.id, sourceId: source!.id,
    externalKey: "id:1", title: "Operations Manager", normalizedTitle: "operations manager", url: "https://acme.example/jobs/1",
    location: "London", locations: ["London"] }).returning();
  await db.insert(schema.userJobs).values({ userId: user.id, jobId: job!.id, inTable: true, keywordMatched: true });
  return { userId: user.id, jobId: job!.id };
}

async function view(userId: string, jobId: string) {
  return (await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))))[0]!;
}
async function task(type: "admit_scores" | "score_job") {
  return (await db.select().from(schema.tasks).where(eq(schema.tasks.type, type)))[0]!;
}

it("blocks legacy score requests for an unconfirmed member without a model call or budget hold", async () => {
  const pair = await role("unconfirmed-admission@example.com");
  await db.update(schema.users).set({ role: "member", emailVerifiedAt: null }).where(eq(schema.users.id, pair.userId));
  await requestScores(db, [pair], now);
  const scoreJob = vi.fn().mockResolvedValue({ score: 80, verdict: "strong", rationale: "Fits." });
  const ai = { ...deps, ai: { ...deps.ai, enabled: true, scoreJob } } as unknown as WorkerDeps;
  expect(await handleAdmitScores(await task("admit_scores"), ai)).toMatchObject({ queued: 0, blockedVerification: 1 });
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("verification");
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"))).toHaveLength(0);
  expect(await prepareScoreJob(ai, pair.userId, pair.jobId)).toEqual({ done: { skipped: "email confirmation required" } });
  expect(await handleScoreJob({ payload: pair } as unknown as Task, ai)).toEqual({ skipped: "email confirmation required" });
  expect(await handleRescoreAll({ payload: { userId: pair.userId }, type: "rescore_all" } as unknown as Task, ai))
    .toEqual({ skipped: "email confirmation required" });
  expect(scoreJob).not.toHaveBeenCalled();
  expect(await db.select().from(schema.aiReservations).where(eq(schema.aiReservations.userId, pair.userId))).toHaveLength(0);
});

it("rejects a direct per-account engine call before reserving for an unconfirmed member", async () => {
  const pair = await role("unconfirmed-direct-ai@example.com");
  await db.update(schema.users).set({ role: "member", emailVerifiedAt: null }).where(eq(schema.users.id, pair.userId));
  const create = vi.fn();
  const direct = await createDeps({ ...readEnv(), databaseUrl: url }, {
    now: () => now,
    aiClient: { messages: { create } } as unknown as WorkerDeps["aiClient"],
  });
  try {
    await expect(direct.ai.tagReason({ reason: "Wrong location", decision: "skip", job: { title: "Operations Manager", company: "Acme" }, vocabulary: [] },
      { userId: pair.userId, refType: "decision", refId: pair.jobId })).rejects.toBeInstanceOf(AccountVerificationRequiredError);
    expect(create).not.toHaveBeenCalled();
    expect(await db.select().from(schema.aiReservations).where(eq(schema.aiReservations.userId, pair.userId))).toHaveLength(0);
    expect(await db.select().from(schema.aiCalls).where(eq(schema.aiCalls.userId, pair.userId))).toHaveLength(0);
  } finally {
    await direct.close();
  }
});

it("retries a verification-blocked view after confirmation even with the last pass's input hash", async () => {
  const pair = await role("confirmation-retry@example.com");
  const ai = { ...deps, ai: { ...deps.ai, enabled: true } } as WorkerDeps;
  const rescore = { payload: { userId: pair.userId }, type: "rescore_all" } as unknown as Task;
  const first = await handleRescoreAll(rescore, ai) as { queued: number; inputsHash: string };
  expect(first.queued).toBe(1);
  await db.delete(schema.tasks);
  await db.insert(schema.tasks).values({ type: "rescore_all", payload: { userId: pair.userId }, status: "done",
    result: first, finishedAt: new Date(now.getTime() - 86_400_000) });
  await db.update(schema.userJobs).set({ scoreState: "verification" })
    .where(and(eq(schema.userJobs.userId, pair.userId), eq(schema.userJobs.jobId, pair.jobId)));
  expect(await handleRescoreAll(rescore, ai)).toMatchObject({ queued: 1, inputsHash: first.inputsHash });
});

it("records exact requests, then a no-key worker settles them without futile score jobs", async () => {
  const pair = await role();
  expect(await requestScores(db, [pair], now)).toBe(1);
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("requested");
  const admission = await task("admit_scores");
  expect(admission.payload).toMatchObject({ userId: pair.userId, jobIds: [pair.jobId] });
  expect(await handleAdmitScores(admission, { ...deps, ai: { ...deps.ai, enabled: false } } as WorkerDeps)).toMatchObject({ queued: 0, unavailable: 1 });
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("unavailable");
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"))).toHaveLength(0);
});

it("does not lose identical requests or one whose view changed after the request", async () => {
  const pair = await role();
  await requestScores(db, [pair], now);
  await requestScores(db, [pair], new Date(now.getTime() + 1000));
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "admit_scores"))).toHaveLength(1);
  await db.update(schema.userJobs).set({ scoreState: "scored", scoreStateAt: new Date(now.getTime() + 2000),
    fitScore: 77, scoredAt: new Date(now.getTime() + 2000) }).where(and(eq(schema.userJobs.userId, pair.userId), eq(schema.userJobs.jobId, pair.jobId)));
  const ai = { ...deps, ai: { ...deps.ai, enabled: true } } as WorkerDeps;
  expect(await handleAdmitScores(await task("admit_scores"), ai)).toMatchObject({ queued: 1 });
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("queued");
});

it("rechecks automatic only-unscored requests under the view lock", async () => {
  const pair = await role();
  await requestScores(db, [pair], now, { onlyUnscored: true });
  await db.update(schema.userJobs).set({ scoreState: "scored", fitScore: 85, scoredAt: now })
    .where(and(eq(schema.userJobs.userId, pair.userId), eq(schema.userJobs.jobId, pair.jobId)));
  const ai = { ...deps, ai: { ...deps.ai, enabled: true } } as WorkerDeps;
  expect(await handleAdmitScores(await task("admit_scores"), ai)).toMatchObject({ queued: 0, skipped: 1 });
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("scored");
});

it("keeps automatic and explicit requests for the same role as distinct durable intents", async () => {
  const pair = await role();
  await requestScores(db, [pair], now, { onlyUnscored: true });
  await requestScores(db, [pair], new Date(now.getTime() + 1000));
  const requests = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "admit_scores"));
  expect(requests).toHaveLength(2);
  expect(new Set(requests.map(request => request.dedupeKey)).size).toBe(2);
  await db.update(schema.userJobs).set({ scoreState: "scored", fitScore: 85, scoredAt: now })
    .where(and(eq(schema.userJobs.userId, pair.userId), eq(schema.userJobs.jobId, pair.jobId)));
  const ai = { ...deps, ai: { ...deps.ai, enabled: true } } as WorkerDeps;
  const automatic = requests.find(request => request.payload.onlyUnscored === true)!;
  const explicit = requests.find(request => request.payload.onlyUnscored !== true)!;
  expect(await handleAdmitScores(automatic, ai)).toMatchObject({ queued: 0, skipped: 1 });
  expect(await handleAdmitScores(explicit, ai)).toMatchObject({ queued: 1 });
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("queued");
});

it("separates account budgets and live holds, and counts repeated refusal even without a changed state", async () => {
  const zero = await role("zero-admission@example.com");
  const held = await role("held-admission@example.com");
  const allowed = await role("allowed-admission@example.com");
  await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at)
    values (${held.userId}::uuid, 'CV', 1, now() + interval '5 minutes')`);
  const settingsFor = await Promise.all([zero.userId, held.userId, allowed.userId].map(async userId =>
    [userId, { ...await deps.userSettings(userId), aiBudgetUsd: userId === zero.userId ? 0 : 1 }] as const));
  const settings = new Map(settingsFor);
  const ai = { ...deps, ai: { ...deps.ai, enabled: true } } as WorkerDeps;
  const pairs = [zero, held, allowed];
  expect(await admitScores(ai, pairs, { settings })).toMatchObject({ queued: 1, budget: 2, blockedBudget: 2, skipped: 0 });
  expect((await view(zero.userId, zero.jobId)).scoreState).toBe("budget");
  expect((await view(held.userId, held.jobId)).scoreState).toBe("budget");
  expect((await view(allowed.userId, allowed.jobId)).scoreState).toBe("queued");
  expect(await admitScores(ai, [zero, held], { settings })).toMatchObject({ queued: 0, budget: 0, blockedBudget: 2 });
  await db.execute(sql`update ai_reservations set expires_at = now() - interval '1 minute' where user_id = ${held.userId}::uuid`);
  expect(await admitScores(ai, [held], { settings })).toMatchObject({ queued: 1, blockedBudget: 0 });
  expect((await view(held.userId, held.jobId)).scoreState).toBe("queued");
});

it("promotes an identical background admission request to interactive without duplicating it", async () => {
  const pair = await role();
  await requestScores(db, [pair], now, { background: true });
  await requestScores(db, [pair], new Date(now.getTime() + 1000), { priority: 1 });
  const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.type, "admit_scores"));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ priority: 1 });
  expect(rows[0]!.payload.background).toBeUndefined();
});

it("does not clobber a score when the only score task was deduplicated", async () => {
  const pair = await role();
  await queueScoring(db, [pair], now);
  await db.update(schema.userJobs).set({ scoreState: "scored", fitScore: 81 }).where(and(eq(schema.userJobs.userId, pair.userId), eq(schema.userJobs.jobId, pair.jobId)));
  expect(await queueScoring(db, [pair], new Date(now.getTime() + 1000))).toBe(0);
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("scored");
});

it("takes the role lock before inserting a score task", async () => {
  const pair = await role();
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const holder = db.transaction(async tx => {
    await tx.execute(sql`select job_id from user_jobs where user_id = ${pair.userId}::uuid and job_id = ${pair.jobId}::uuid for update`);
    locked();
    await gate;
  });
  await ready;
  const scoring = queueScoring(db, [pair], now);
  try {
    let waiting = false;
    for (let n = 0; n < 40 && !waiting; n++) {
      const result = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
        where pid <> pg_backend_pid() and wait_event_type = 'Lock'
          and query like 'select uj.user_id, uj.job_id from user_jobs uj%') as waiting`);
      waiting = result.rows[0]?.waiting === true;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(true);
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"))).toHaveLength(0);
  } finally {
    release();
  }
  await holder;
  expect(await scoring).toBe(1);
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("queued");
});

it("terminal abandonment marks only orphaned current requests and queued scores failed", async () => {
  const pair = await role();
  await requestScores(db, [pair], now);
  const admission = await task("admit_scores");
  await db.update(schema.tasks).set({ status: "failed" }).where(eq(schema.tasks.id, admission.id));
  await onAbandon.admit_scores!(admission as Task, deps, "exhausted");
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("failed");
  await queueScoring(db, [pair], now);
  const score = await task("score_job");
  await db.update(schema.tasks).set({ status: "failed" }).where(eq(schema.tasks.id, score.id));
  await onAbandon.score_job!(score as Task, deps, "exhausted");
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("failed");
});

it("does not fail a role still covered by a newer admission or score task", async () => {
  const pair = await role();
  await requestScores(db, [pair], now);
  const oldAdmission = await task("admit_scores");
  await db.update(schema.tasks).set({ status: "failed" }).where(eq(schema.tasks.id, oldAdmission.id));
  await requestScores(db, [pair], new Date(now.getTime() + 1000));
  await onAbandon.admit_scores!(oldAdmission as Task, deps, "old failure");
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("requested");

  await db.update(schema.tasks).set({ status: "failed" }).where(eq(schema.tasks.type, "admit_scores"));
  await queueScoring(db, [pair], now);
  const oldScore = await task("score_job");
  await db.update(schema.tasks).set({ status: "failed" }).where(eq(schema.tasks.id, oldScore.id));
  await queueScoring(db, [pair], new Date(now.getTime() + 1000));
  await onAbandon.score_job!(oldScore as Task, deps, "old failure");
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("queued");
});

it("settles abandonment after a concurrent request commits behind the same role lock", async () => {
  const pair = await role();
  await requestScores(db, [pair], now);
  const old = await task("admit_scores");
  await db.update(schema.tasks).set({ status: "failed" }).where(eq(schema.tasks.id, old.id));
  let release!: () => void;
  let locked!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const newer = db.transaction(async tx => {
    await tx.execute(sql`select job_id from user_jobs where user_id = ${pair.userId}::uuid and job_id = ${pair.jobId}::uuid for update`);
    locked();
    await held;
    await requestScores(tx as unknown as Db, [pair], new Date(now.getTime() + 1000));
  });
  await ready;
  const abandoning = onAbandon.admit_scores!(old as Task, deps, "old failure");
  try {
    let waiting = false;
    for (let n = 0; n < 40 && !waiting; n++) {
      const result = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
        where pid <> pg_backend_pid() and wait_event_type = 'Lock'
          and query like 'select job_id from user_jobs where user_id =%') as waiting`);
      waiting = result.rows[0]?.waiting === true;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(true);
  } finally {
    release();
  }
  await newer;
  await abandoning;
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("requested");
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "admit_scores"))).toHaveLength(2);
});

it("does not report unavailable while a provider batch still owns the score", async () => {
  const pair = await role();
  await requestScores(db, [pair], now);
  await db.insert(schema.tasks).values({ type: "poll_score_batch", status: "queued", payload: {
    batchId: "batch-1", items: [{ userId: pair.userId, jobId: pair.jobId }],
  } });
  const noAi = { ...deps, ai: { ...deps.ai, enabled: false } } as WorkerDeps;
  expect(await handleAdmitScores(await task("admit_scores"), noAi)).toMatchObject({ unavailable: 0 });
  expect((await view(pair.userId, pair.jobId)).scoreState).toBe("requested");
});
