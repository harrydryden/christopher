/**
 * The operations report: what `ai_calls` adds up to once it is grouped by account, feature and
 * model. Call sites are the spec's A1–A10 and CV; two of them can carry one feature, and shared
 * work carries no account at all, so both have to survive the trip to the table.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { aiFeatureLabel } from "@christopher/core";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { getAiUsage, getTotalAiSpend } from "./health";
import { totalAiUsage } from "@/lib/ai-usage";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate ai_calls, users restart identity cascade`);
  user = await ensureTestUser(database, "usage@example.com");
});

it("adds AI calls up by account, feature and model, dearest first, and leaves the window behind", async () => {
  const since = new Date(Date.now() - 3_600_000);
  const inWindow = new Date(Date.now() - 60_000);
  const before = new Date(Date.now() - 7_200_000);
  const tokens = { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 5 };
  await database.insert(schema.aiCalls).values([
    // Discovery is two call sites (A1 and A2): one line, both calls, tokens added up.
    { userId: user.id, callSite: "A1", model: "claude-sonnet-5", ...tokens, costUsd: 0.5, at: inWindow },
    { userId: user.id, callSite: "A2", model: "claude-sonnet-5", ...tokens, costUsd: 0.5, at: inWindow },
    // A call that returned nothing usable was still billed, so it is still counted.
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", ...tokens, costUsd: 3, ok: false, error: "schema", at: inWindow },
    // Shared work (extraction) belongs to no account.
    { userId: null, callSite: "A3", model: "claude-sonnet-5", ...tokens, costUsd: 0.25, at: inWindow },
    // Older than the window: on nobody's report and in nobody's total.
    { userId: user.id, callSite: "A5", model: "claude-sonnet-5", ...tokens, costUsd: 99, at: before },
  ]);

  const rows = await getAiUsage(since);
  expect(rows.map((row) => [row.userId, row.feature, row.model, row.calls, row.costUsd])).toEqual([
    [user.id, aiFeatureLabel("CV"), "claude-fable-5-1", 1, 3],
    [user.id, aiFeatureLabel("A1"), "claude-sonnet-5", 2, 1],
    [null, aiFeatureLabel("A3"), "claude-sonnet-5", 1, 0.25],
  ]);
  expect(aiFeatureLabel("A2")).toBe(aiFeatureLabel("A1"));
  const discovery = rows[1]!;
  expect(discovery).toMatchObject({ failed: 0, inputTokens: 2_000, outputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 10 });
  expect(rows[0]!.failed).toBe(1);

  expect(totalAiUsage(rows)).toEqual({ calls: 4, failed: 1, inputTokens: 4_000, outputTokens: 400, cacheReadTokens: 40, cacheWriteTokens: 20, costUsd: 4.25 });
  // Operations reports every account's calls and the unattributed ones together.
  expect(await getTotalAiSpend(since)).toBe(4.25);
  expect(await getAiUsage(new Date(Date.now() + 60_000))).toEqual([]);
  expect(totalAiUsage([])).toMatchObject({ calls: 0, costUsd: 0 });
});

/* ---------------------------------------------------------------------------------------------
 * Worker observability
 *
 * The incident these cover: the worker crash-looped for ten hours, the heartbeat was rewritten on
 * every boot so Operations said "reported 1 minute ago", and nothing named the 41 MB listing that
 * was killing the process or the CV build that died with it on every restart.
 * ------------------------------------------------------------------------------------------- */

import {
  getLastCrashRecovery,
  getWorkerHeartbeat,
  getWorkerStatus,
  listLargestScanInputs,
  listRecentWorkerEvents,
  listRetryingTasks,
  listRunningTasks,
  taskSubjectRef,
} from "./health";

const MINUTE = 60_000;
async function resetWorkerFixtures() {
  await database.execute(sql`truncate companies, tasks, worker_events, settings, users restart identity cascade`);
}
async function writeHeartbeat(value: Record<string, unknown>) {
  await database.insert(schema.settings).values({ key: "internal:workerHeartbeat", value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

it("reads both heartbeat shapes, and calls a crash-looping worker restarting however fresh its report", async () => {
  await resetWorkerFixtures();
  // The shape an older release wrote: no worker id, no boot time, no memory reading.
  await writeHeartbeat({ at: new Date().toISOString(), aiConfigured: true, browserAvailable: false });
  const legacy = await getWorkerHeartbeat();
  expect(legacy).toMatchObject({ aiConfigured: true, browserAvailable: false, workerId: null, bootedAt: null, vitals: null, active: null });

  await writeHeartbeat({
    at: new Date().toISOString(), workerId: "worker-a", aiConfigured: true, browserAvailable: true,
    commit: "a".repeat(40), bootedAt: new Date(Date.now() - 2 * MINUTE).toISOString(),
    vitals: { heapUsedMb: 230, heapLimitMb: 258, heapFraction: 0.89, rssMb: 470, externalMb: 41, uptimeSeconds: 120 },
    active: 3,
  });
  const full = await getWorkerHeartbeat();
  expect(full).toMatchObject({ workerId: "worker-a", active: 3 });
  expect(full!.vitals).toMatchObject({ heapUsedMb: 230, heapLimitMb: 258, heapFraction: 0.89 });

  // Healthy until the ledger says otherwise; the heap reading is reported but does not change the state.
  const quiet = await getWorkerStatus();
  expect(quiet.state).toBe("healthy");
  expect(quiet.heapPressure).toBe(true);
  expect(quiet.restartsLastDay).toBe(0);

  await database.insert(schema.workerEvents).values([
    { workerId: "worker-a", kind: "crash_recovery", detail: { suspects: [] }, at: new Date(Date.now() - 5 * MINUTE) },
    { workerId: "worker-a", kind: "crash_recovery", detail: { suspects: [] }, at: new Date(Date.now() - 10 * MINUTE) },
    // Yesterday's: counted in neither window.
    { workerId: "worker-a", kind: "crash_recovery", detail: { suspects: [] }, at: new Date(Date.now() - 30 * 60 * MINUTE) },
    // Older than the hour, inside the day.
    { workerId: "worker-a", kind: "crash_recovery", detail: { suspects: [] }, at: new Date(Date.now() - 200 * MINUTE) },
  ]);
  const looping = await getWorkerStatus();
  expect(looping.state).toBe("restarting");
  expect(looping.restartsLastHour).toBe(2);
  expect(looping.restartsLastDay).toBe(3);

  // The concurrency the heartbeat does not carry comes from the same worker's boot line.
  await database.insert(schema.workerEvents).values({ workerId: "worker-a", kind: "boot", detail: { concurrency: 3, commit: "a".repeat(40) } });
  expect((await getWorkerStatus()).heartbeat?.concurrency).toBe(3);

  // Four missed heartbeats and it is stopped, whatever the ledger says.
  await writeHeartbeat({ at: new Date(Date.now() - 5 * MINUTE).toISOString(), workerId: "worker-a" });
  expect((await getWorkerStatus()).state).toBe("stopped");
});

it("names the crash suspects a person can act on, likeliest first", async () => {
  await resetWorkerFixtures();
  const account = await ensureTestUser(database, "suspects@example.com");
  const [company] = await database.insert(schema.companies)
    .values({ name: "Monzo", homepageUrl: "https://monzo.com", domain: "monzo.com" }).returning();
  const [cv] = await database.insert(schema.cvDrafts).values({
    userId: account.id, jobTitle: "Staff Engineer", companyName: "Monzo", jobDescription: "…",
    libraryVersion: 1, librarySnapshot: {} as never, model: "claude-fable-5-1",
  }).returning();

  await database.insert(schema.workerEvents).values({
    workerId: "worker-b", kind: "crash_recovery",
    detail: {
      likely: { id: "11111111-1111-4111-8111-111111111111" },
      suspects: [
        { id: "22222222-2222-4222-8222-222222222222", type: "generate_cv", attempts: 28, lockedBy: "worker-a", lockedAt: new Date().toISOString(), subject: `generate_cv:${cv!.id}` },
        { id: "11111111-1111-4111-8111-111111111111", type: "scan_company", attempts: 109, lockedBy: "worker-a", lockedAt: new Date().toISOString(), subject: `scan_company:${company!.id}` },
      ],
    },
  });

  const crash = await getLastCrashRecovery();
  expect(crash!.workerId).toBe("worker-b");
  // The one that had been retried 109 times is put first and marked.
  expect(crash!.suspects.map((s) => [s.subject, s.attempts, s.likely])).toEqual([
    ["Monzo", 109, true],
    [`CV: Monzo · Staff Engineer`, 28, false],
  ]);
});

it("shows what is running against its deadline, and what a crash handed back", async () => {
  await resetWorkerFixtures();
  const account = await ensureTestUser(database, "queue@example.com");
  const [company] = await database.insert(schema.companies)
    .values({ name: "Stripe", homepageUrl: "https://stripe.com", domain: "stripe.com" }).returning();
  const started = new Date(Date.now() - 4 * MINUTE);
  await database.insert(schema.tasks).values([
    { type: "scan_company", payload: { companyId: company!.id }, status: "running", startedAt: started, lockedAt: started, lockedBy: "worker-a", attempts: 109, dedupeKey: "scan_company:x" },
    // Queued, tried once already and carrying the error the crash left: a retry, not a fresh task.
    { type: "suggest_filters", payload: { userId: account.id }, status: "queued", attempts: 2, error: "worker restarted", runAfter: new Date(Date.now() + MINUTE) },
    // Queued and never tried: ordinary backlog, not a retry.
    { type: "scan_company", payload: { companyId: company!.id }, status: "queued", attempts: 0 },
  ]);

  const [running] = await listRunningTasks();
  expect(running).toMatchObject({ type: "scan_company", subject: "Stripe", attempts: 109 });
  // scan_company's three minutes, from the shared table in @christopher/core.
  expect(running!.deadlineMs).toBe(3 * MINUTE);
  expect(Date.now() - running!.startedAt!.getTime()).toBeGreaterThan(running!.deadlineMs);

  const retrying = await listRetryingTasks();
  expect(retrying.map((t) => [t.type, t.subject, t.attempts, t.error])).toEqual([
    ["suggest_filters", "queue@example.com", 2, "worker restarted"],
  ]);

  expect(taskSubjectRef("generate_cv", { draftId: "33333333-3333-4333-8333-333333333333" }))
    .toEqual({ kind: "cv", id: "33333333-3333-4333-8333-333333333333" });
  // Work that names an account and nothing resolvable still says whose queue is stuck.
  expect(taskSubjectRef("score_job", { userId: account.id })).toEqual({ kind: "user", id: account.id });
  expect(taskSubjectRef("run_daily", { trigger: "schedule" })).toBeNull();
});

it("lists the largest listing each source returned, biggest first", async () => {
  await resetWorkerFixtures();
  const [big, small] = await database.insert(schema.companies).values([
    { name: "Greenhouse Co", homepageUrl: "https://a.example", domain: "a.example" },
    { name: "Small Co", homepageUrl: "https://b.example", domain: "b.example" },
  ]).returning();
  const [bigSource, smallSource] = await database.insert(schema.careerSources).values([
    { companyId: big!.id, type: "greenhouse", url: "https://boards.greenhouse.io/a" },
    { companyId: small!.id, type: "html", url: "https://b.example/careers" },
  ]).returning();
  await database.insert(schema.scans).values([
    // Two scans of the same source: only its largest appears, so one board cannot fill the table.
    { sourceId: bigSource!.id, status: "ok", startedAt: new Date(Date.now() - 60 * MINUTE), fetchedBytes: 41_000_000 },
    { sourceId: bigSource!.id, status: "ok", startedAt: new Date(Date.now() - 30 * MINUTE), fetchedBytes: 900_000 },
    { sourceId: smallSource!.id, status: "ok", startedAt: new Date(Date.now() - 30 * MINUTE), fetchedBytes: 120_000 },
    // Outside the window, and one that never recorded a size.
    { sourceId: bigSource!.id, status: "ok", startedAt: new Date(Date.now() - 30 * 24 * 60 * MINUTE), fetchedBytes: 99_000_000 },
    { sourceId: smallSource!.id, status: "failed", startedAt: new Date(Date.now() - 10 * MINUTE), fetchedBytes: null },
  ]);

  const rows = await listLargestScanInputs(7, 10);
  expect(rows.map((r) => [r.companyName, r.sourceType, r.bytes])).toEqual([
    ["Greenhouse Co", "greenhouse", 41_000_000],
    ["Small Co", "html", 120_000],
  ]);
});

it("reads the worker's own ledger into a timeline, and survives a database without one", async () => {
  await resetWorkerFixtures();
  const account = await ensureTestUser(database, "events@example.com");
  const [company] = await database.insert(schema.companies)
    .values({ name: "Figma", homepageUrl: "https://figma.com", domain: "figma.com" }).returning();
  await database.insert(schema.workerEvents).values([
    { workerId: "worker-a", kind: "boot", detail: { concurrency: 3, commit: "b".repeat(40), vitals: { heapUsedMb: 40, heapLimitMb: 258, heapFraction: 0.16 } }, at: new Date(Date.now() - 3 * MINUTE) },
    { workerId: "worker-a", kind: "task_abandoned", taskType: "scan_company", userId: account.id, at: new Date(Date.now() - 2 * MINUTE),
      detail: { attempts: 3, maxAttempts: 3, subject: `scan_company:${company!.id}`, error: "JavaScript heap out of memory" } },
    { workerId: "worker-a", kind: "holds_released", detail: { count: 2, amountUsd: 6, reason: "boot" }, at: new Date(Date.now() - MINUTE) },
  ]);

  const timeline = await listRecentWorkerEvents(30);
  expect(timeline.map((e) => e.kind)).toEqual(["holds_released", "task_abandoned", "boot"]);
  expect(timeline[0]!.detail).toBe("2 AI budget holds released on boot");
  expect(timeline[1]).toMatchObject({ subject: "Figma", taskType: "scan_company" });
  expect(timeline[1]!.detail).toBe("attempt 3 of 3 · JavaScript heap out of memory");
  expect(timeline[2]!.detail).toContain("heap ceiling 258 MB");

  // The interface can be serving before the worker has run the migration that creates the ledger.
  await database.execute(sql`alter table worker_events rename to worker_events_hidden`);
  try {
    expect(await listRecentWorkerEvents(30)).toEqual([]);
    expect(await getLastCrashRecovery()).toBeNull();
    expect((await getWorkerStatus()).restartsLastDay).toBe(0);
  } finally {
    await database.execute(sql`alter table worker_events_hidden rename to worker_events`);
  }
});
