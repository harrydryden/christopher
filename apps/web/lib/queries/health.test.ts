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
import { getAiUsage, getCvBuildCosts, getCvBuildFailureKinds, getCvBuildMotions, getScoredRoleCost, getTotalAiSpend } from "./health";
import { totalAiUsage } from "@/lib/ai-usage";
import { aiOutcome } from "@christopher/db";

/** The string packages/ai writes when it stops paying for a batch whose sibling has failed. */
const CANCELLED = "Cancelled because another call in the same task failed.";

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
    { userId: user.id, callSite: "A1", model: "claude-sonnet-5", ...tokens, costUsd: 0.5, durationMs: 1_000, at: inWindow },
    { userId: user.id, callSite: "A2", model: "claude-sonnet-5", ...tokens, costUsd: 0.5, durationMs: 3_000, at: inWindow },
    // A call that returned nothing usable was still billed, so it is still counted.
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", ...tokens, costUsd: 3, ok: false, error: "schema", durationMs: 9_000, at: inWindow },
    // Shared work (extraction) belongs to no account.
    { userId: null, callSite: "A3", model: "claude-sonnet-5", ...tokens, costUsd: 0.25, durationMs: 500, at: inWindow },
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
  // Latency and the cache ratio explain a dear line; the ratio is cache reads over the whole prompt.
  expect(discovery.p50DurationMs).toBe(2_000);
  expect(discovery.cacheHitRatio).toBeCloseTo(20 / (2_000 + 20 + 10), 6);
  expect(rows[0]!.p95DurationMs).toBe(9_000);

  expect(totalAiUsage(rows)).toEqual({ calls: 4, failed: 1, cancelled: 0, stalled: 0, inputTokens: 4_000, outputTokens: 400, cacheReadTokens: 40, cacheWriteTokens: 20, costUsd: 4.25 });
  // Operations reports every account's calls and the unattributed ones together.
  expect(await getTotalAiSpend(since)).toBe(4.25);
  expect(await getAiUsage(new Date(Date.now() + 60_000))).toEqual([]);
  expect(totalAiUsage([])).toMatchObject({ calls: 0, costUsd: 0 });
});

it("keeps a cancelled sibling and a stalled stream out of the model's failure count", async () => {
  // One CV build whose second batch failed: the engine cancels the other three. Counting those as
  // failures turns one bad build into four broken calls, which is the figure an operator acts on.
  const since = new Date(Date.now() - 3_600_000);
  const at = new Date(Date.now() - 60_000);
  await database.insert(schema.aiCalls).values([
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 1, ok: false, error: "Request timed out.", at },
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 0.1, ok: false, error: CANCELLED, at },
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 0.1, ok: false, error: CANCELLED, at },
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 0.2, ok: false, error: "Stream timed out: no complete response after 15 minutes.", at },
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 2, ok: true, at },
  ]);
  const [line] = await getAiUsage(since);
  expect(line).toMatchObject({ calls: 5, failed: 1, cancelled: 2, stalled: 1 });
  // The taxonomy is derived, and one row classifies the same way the aggregate counted it.
  expect(aiOutcome({ ok: true })).toBe("ok");
  expect(aiOutcome({ ok: false, error: CANCELLED })).toBe("cancelled");
  expect(aiOutcome({ ok: false, error: "Stream timed out: no complete response after 15 minutes." })).toBe("stalled");
  expect(aiOutcome({ ok: false, error: "Request timed out." })).toBe("failed");
  expect(aiOutcome({ ok: false, error: null })).toBe("failed");
});

it("itemises a CV build by stage and prices one scored role", async () => {
  const at = new Date(Date.now() - 60_000);
  const build = (draftId: string, stages: Array<[string | null, number]>, when: Date) =>
    stages.map(([stage, costUsd]) => ({
      userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd, stage,
      refType: stage === "rubric" ? "cv-rubric" : stage === "author" ? "cv-author" : "cv-review",
      refId: draftId, at: when,
    }));
  const cheap = "11111111-1111-4111-8111-111111111111";
  const dear = "22222222-2222-4222-8222-222222222222";
  await database.insert(schema.aiCalls).values([
    ...build(cheap, [["rubric", 0.4], ["author", 1], ["review", 0.6]], new Date(at.getTime() - 60_000)),
    // The dear one paid twice for a batch whose attribution had to be corrected. That is the line
    // that explains it, and the whole point of recording a stage.
    ...build(dear, [["rubric", 0.4], ["author", 2], ["review", 1.5], ["review_retry", 1.1]], at),
    // A scored role is a different ref type entirely and never lands in a build's bill.
    { userId: user.id, callSite: "A5", model: "claude-haiku-4-5", costUsd: 0.004, refType: "job", refId: "33333333-3333-4333-8333-333333333333", at },
    { userId: user.id, callSite: "A5", model: "claude-haiku-4-5", costUsd: 0.006, refType: "job", refId: "44444444-4444-4444-8444-444444444444", at },
  ]);

  const builds = await getCvBuildCosts(20);
  expect(builds.builds.map((row) => [row.draftId, Number(row.costUsd.toFixed(2))])).toEqual([[dear, 5], [cheap, 2]]);
  expect(builds.builds[0]!.byStage.review_retry).toBeCloseTo(1.1, 5);
  expect(builds.builds[0]!.calls).toBe(4);
  expect(builds.worstUsd).toBeCloseTo(5, 5);
  expect(builds.medianUsd).toBeCloseTo(3.5, 5);
  // Dearest stage first across the sample, so the column order matches where the money went.
  expect(builds.stages).toEqual(["author", "review", "review_retry", "rubric"]);
  // Only the newest build is sampled when the limit says one, and it is still itemised.
  expect((await getCvBuildCosts(1)).builds.map((row) => row.draftId)).toEqual([dear]);

  const scored = await getScoredRoleCost(30);
  expect(scored).toMatchObject({ roles: 2, calls: 2 });
  expect(scored.totalUsd).toBeCloseTo(0.01, 5);
  expect(scored.meanUsd).toBeCloseTo(0.005, 5);
  expect(scored.medianUsd).toBeCloseTo(0.005, 5);
});

/* ---------------------------------------------------------------------------------------------
 * Worker observability
 *
 * The incident these cover: the worker crash-looped for ten hours, the heartbeat was rewritten on
 * every boot so Operations said "reported 1 minute ago", and nothing named the 41 MB listing that
 * was killing the process or the CV build that died with it on every restart.
 * ------------------------------------------------------------------------------------------- */

import { foldOutboundTraffic, hostNeedsAttention, p95FromBuckets } from "@/lib/outbound-traffic";
import {
  getLastCrashRecovery,
  getWorkerHeartbeat,
  getWorkerStatus,
  listLargestScanInputs,
  outboundTraffic,
  listRecentWorkerEvents,
  normaliseCvBuildCosts,
  operationDate,
  requiredOperationDate,
  listRetryingTasks,
  listRunningTasks,
  taskSubjectRef,
} from "./health";

const MINUTE = 60_000;

it("normalises timestamps returned as strings by a pooled serverless query", () => {
  const raw = JSON.parse('{"at":"2026-09-20T13:52:12.128Z"}') as { at: unknown };
  expect(operationDate(raw.at)).toEqual(new Date("2026-09-20T13:52:12.128Z"));
  expect(operationDate(new Date("2026-09-20T13:52:12.128Z"))).toEqual(new Date("2026-09-20T13:52:12.128Z"));
  expect(operationDate("not-a-timestamp")).toBeNull();
  expect(requiredOperationDate(raw.at, "CV build").toISOString()).toBe("2026-09-20T13:52:12.128Z");
  expect(() => requiredOperationDate("not-a-timestamp", "CV build")).toThrow("invalid CV build timestamp");
  const costs = normaliseCvBuildCosts({
    builds: [{ draftId: "draft-1", calls: 1, costUsd: 1, byStage: { author: 1 }, unattributedUsd: 0, at: raw.at as Date }],
    medianUsd: 1, worstUsd: 1, stages: ["author"],
  });
  expect(costs.builds[0]!.at.toISOString()).toBe("2026-09-20T13:52:12.128Z");
});
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
    { sourceId: bigSource!.id, status: "ok", startedAt: new Date(Date.now() - 60 * MINUTE), fetchedBytes: 41_000_000, fetchMethod: "http", requests: 3, revalidated: 1 },
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
  // How it was fetched, and what revalidation spared: a feed read in one request that came back
  // 304 is a scan that cost nothing, however big the board behind it is.
  expect(rows[0]).toMatchObject({ fetchMethod: "http", requests: 3, revalidated: 1 });
  // The ranking is done in SQL now, so a limit really does bound what the database returns.
  expect(await listLargestScanInputs(7, 1)).toHaveLength(1);
  expect((await listLargestScanInputs(7, 1))[0]!.companyName).toBe("Greenhouse Co");
  // A scan from before the columns existed reads as null rather than as zero requests.
  expect(rows[1]).toMatchObject({ requests: null, revalidated: null });
});

/* ---------------------------------------------------------------------------------------------
 * Outbound traffic
 *
 * The question this answers is "is a vendor throttling us", which no per-request log line survives
 * long enough to answer.
 * ------------------------------------------------------------------------------------------- */

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

it("folds the traffic rollup into one line per host, with a week-over-week delta and a bucketed p95", async () => {
  await database.execute(sql`truncate http_host_daily`);
  const zero = {
    ok2xx: 0, notModified304: 0, redirects3xx: 0, client4xx: 0, server5xx: 0, rateLimited: 0,
    blocked: 0, robotsDenied: 0, capRejected: 0, timeouts: 0, networkErrors: 0,
    durationMsSum: 0, durationMsMax: 0, latencyBuckets: [0, 0, 0, 0, 0, 0],
  };
  await database.insert(schema.httpHostDaily).values([
    // One host, both paths, this week: the browser share is reported but the totals are merged.
    { day: day(1), host: "boards.greenhouse.io", via: "http", requests: 80, bytesIn: 8_000_000, ...zero,
      ok2xx: 60, notModified304: 18, rateLimited: 2, latencyBuckets: [70, 5, 3, 1, 1, 0] },
    { day: day(2), host: "boards.greenhouse.io", via: "browser", requests: 20, bytesIn: 4_000_000, ...zero,
      ok2xx: 20, latencyBuckets: [0, 0, 10, 8, 2, 0] },
    // The week before, for the delta.
    { day: day(9), host: "boards.greenhouse.io", via: "http", requests: 50, bytesIn: 5_000_000, ...zero, ok2xx: 50 },
    // A host that is refusing us outright, and one slower than the top bucket's bound.
    { day: day(1), host: "jobs.lever.co", via: "http", requests: 10, bytesIn: 100_000, ...zero,
      blocked: 4, robotsDenied: 3, capRejected: 1, server5xx: 2, latencyBuckets: [0, 0, 0, 0, 0, 10] },
    // Outside both windows entirely.
    { day: day(30), host: "old.example", via: "http", requests: 999, bytesIn: 1, ...zero },
  ]);

  const rows = await outboundTraffic(7);
  expect(rows.map((row) => row.host)).toEqual(["boards.greenhouse.io", "jobs.lever.co"]);
  const greenhouse = rows[0]!;
  expect(greenhouse).toMatchObject({ requests: 100, bytes: 12_000_000, blocked: 0, previousRequests: 50, previousBytes: 5_000_000 });
  expect(greenhouse.browserShare).toBeCloseTo(0.2, 6);
  expect(greenhouse.notModifiedRatio).toBeCloseTo(0.18, 6);
  expect(greenhouse.rateLimitedRatio).toBeCloseTo(0.02, 6);
  // 100 samples, 95th is the 95th: 70 under 500ms, 75 under 1s, 88 under 2s, 97 under 5s.
  expect(greenhouse.p95Ms).toBe(5_000);
  expect(hostNeedsAttention(greenhouse)).toBe(true);

  const lever = rows[1]!;
  expect(lever).toMatchObject({ blocked: 4, robotsDenied: 3, capRejected: 1, errors: 2, previousRequests: 0 });
  // Everything in the open top bucket: "slower than the last bound", not a number we can invent.
  expect(lever.p95Ms).toBeNull();
  expect(hostNeedsAttention(lever)).toBe(true);
  expect(hostNeedsAttention({ ...greenhouse, rateLimitedRatio: 0, blocked: 0 })).toBe(false);

  // Pure, and empty when nothing has been recorded yet — the ledger fills after deploy.
  expect(foldOutboundTraffic([])).toEqual([]);
  expect(p95FromBuckets([0, 0, 0, 0, 0, 0])).toBeNull();
  expect(p95FromBuckets([100, 0, 0, 0, 0, 0])).toBe(500);
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

it("counts build motions and failure kinds, and reads nothing from a database without the ledger", async () => {
  const [cv] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobTitle: "Operations Director", companyName: "Example", jobDescription: "Lead a team.",
    libraryVersion: 1, librarySnapshot: {} as never, model: "claude-fable-5-1",
  }).returning();
  const inWindow = new Date(Date.now() - 2 * MINUTE);
  const old = new Date(Date.now() - 40 * 24 * 60 * MINUTE);
  const base = { draftId: cv!.id, userId: user.id, attempt: 1 };
  const overloaded = { kind: "overloaded", resolvedBy: "system", retryable: true, message: "The model provider is overloaded.", motion: "write", attempt: 1, maxAttempts: 3 } as const;
  await database.insert(schema.cvBuildSteps).values([
    { ...base, seq: 1, stage: "analysing", motion: "rubric", title: "Extracting the role's requirements", status: "done", startedAt: inWindow, ms: 40_000, detail: { usd: 0.2 } },
    { ...base, seq: 2, stage: "analysing", motion: "rubric", title: "Extracting the role's requirements", status: "done", startedAt: inWindow, ms: 60_000, detail: { usd: 0.4 } },
    // One writing attempt the provider dropped, one that worked: the motion's failure rate is 50%.
    { ...base, seq: 3, stage: "writing", motion: "write", title: "Writing the CV", status: "failed", startedAt: inWindow, ms: 10_000, detail: {}, error: "overloaded", failure: overloaded },
    { ...base, seq: 4, attempt: 2, stage: "writing", motion: "write", title: "Writing the CV", status: "done", startedAt: inWindow, ms: 120_000, detail: { usd: 1.2 } },
    // A person's failure, and one older than the window, which belongs to neither card.
    { ...base, seq: 5, stage: "preparing", motion: "admit_budget", title: "Reserving this build's share of your AI budget", status: "failed", startedAt: inWindow, ms: 100,
      detail: {}, error: "budget", failure: { kind: "budget_exhausted", resolvedBy: "user", retryable: false, action: "raise_budget", message: "Not enough budget." } },
    { ...base, seq: 6, stage: "analysing", motion: "rubric", title: "Extracting the role's requirements", status: "failed", startedAt: old, ms: 1_000, detail: {}, error: "old", failure: overloaded },
  ]);

  const motions = await getCvBuildMotions(30);
  // Busiest first; the two that ran as often as each other may arrive either way round, because
  // the ledger's aggregate orders by runs alone.
  expect(motions.map((row) => [row.motion, row.runs, row.failed]).slice(0, 2).sort()).toEqual([
    ["rubric", 2, 0],
    ["write", 2, 1],
  ]);
  expect(motions[2]).toMatchObject({ motion: "admit_budget", runs: 1, failed: 1 });
  // The median of two is their midpoint, and a motion that spent nothing has no median cost.
  const rubric = motions.find((row) => row.motion === "rubric")!;
  expect(rubric.medianMs).toBe(50_000);
  expect(rubric.medianUsd).toBeCloseTo(0.3, 5);
  expect(motions[2]!.medianUsd).toBeNull();

  // Commonest first, then most recent, then by name: two kinds that have happened as often as each
  // other must not swap places between one refresh of the card and the next.
  const failures = await getCvBuildFailureKinds(30);
  expect(failures.map((row) => [row.kind, row.resolvedBy, row.count])).toEqual([
    ["budget_exhausted", "user", 1],
    ["overloaded", "system", 1],
  ]);
  expect(failures[0]!.lastAt!.getTime()).toBeCloseTo(inWindow.getTime(), -3);

  // The interface can be serving before the worker has run the migration that creates the ledger.
  await database.execute(sql`alter table cv_build_steps rename to cv_build_steps_hidden`);
  try {
    expect(await getCvBuildMotions(30)).toEqual([]);
    expect(await getCvBuildFailureKinds(30)).toEqual([]);
  } finally {
    await database.execute(sql`alter table cv_build_steps_hidden rename to cv_build_steps`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * The attention list (R-9.1) and the resolution each item carries (R-9.2)
 *
 * One item per company, only for the companies this account follows and has not paused, and one
 * for the account's own budget. The sidebar's count and the page's list are two readings of the
 * same union, so they are asserted against each other.
 * ------------------------------------------------------------------------------------------- */

import { countHealthItems, healthItemDetail, healthItemHeadline, healthItems, SOURCE_FAILING_AFTER } from "./health";
import { formatUsd } from "@/lib/format";
import { subscribeToCompany } from "@christopher/db";

async function resetAttention() {
  await database.execute(sql`truncate companies, ai_calls, user_settings, users restart identity cascade`);
}

/** A company in the shared catalogue, followed by `account` unless told otherwise. */
async function company(name: string, account?: User, status: "active" | "paused" = "active") {
  const [row] = await database.insert(schema.companies)
    .values({ name, domain: `${name.toLowerCase().replace(/[^a-z]/g, "")}.example`, homepageUrl: `https://${name.toLowerCase().replace(/[^a-z]/g, "")}.example` })
    .returning();
  if (account) {
    await subscribeToCompany(database, account.id, row!.id);
    if (status === "paused") {
      await database.update(schema.companySubscriptions).set({ status })
        .where(sql`user_id = ${account.id} and company_id = ${row!.id}`);
    }
  }
  return row!;
}

const CANDIDATES = [
  { spec: { type: "greenhouse", url: "https://boards.greenhouse.io/moved" }, confidence: 0.98, method: "ats_guess" },
  { spec: { type: "html", url: "https://moved.example/careers" }, confidence: 0.4, method: "heuristic" },
];

it("raises one item per company, for what this account follows and has not paused", async () => {
  await resetAttention();
  const account = await ensureTestUser(database, "attention@example.com");
  const stranger = await ensureTestUser(database, "stranger@example.com", "member");

  const asking = await company("Asking", account);
  const blocked = await company("Blocked Co", account);
  const failing = await company("Failing Co", account);
  const nothing = await company("Nothing Co", account);
  const moved = await company("Moved Co", account);
  const quiet = await company("Quiet Co", account);
  const paused = await company("Paused Co", account, "paused");
  const theirs = await company("Someone Elses", stranger);

  const [blockedSource, failingSource, movedSource, quietSource] = await database.insert(schema.careerSources).values([
    { companyId: blocked.id, type: "html", url: "https://blocked.example/jobs", status: "blocked" },
    { companyId: failing.id, type: "greenhouse", url: "https://boards.greenhouse.io/failing", status: "failing", consecutiveFailures: 4 },
    { companyId: moved.id, type: "lever", url: "https://jobs.lever.co/moved", status: "active", confidence: 0.8 },
    { companyId: quiet.id, type: "ashby", url: "https://jobs.ashbyhq.com/quiet", status: "active" },
  ]).returning();
  // A company nobody follows still has its problems; they are nobody's to see here.
  await database.insert(schema.careerSources).values({ companyId: theirs.id, type: "html", url: "https://theirs.example/jobs", status: "blocked" });

  await database.insert(schema.scans).values([
    { sourceId: blockedSource!.id, status: "failed", error: "403 from the board", startedAt: new Date(Date.now() - 60_000) },
    // Older than the one above: the item quotes what happened last, not what happened first.
    { sourceId: blockedSource!.id, status: "failed", error: "an older error", startedAt: new Date(Date.now() - 600_000) },
    { sourceId: failingSource!.id, status: "failed", error: "the feed timed out", startedAt: new Date(Date.now() - 60_000) },
  ]);

  await database.insert(schema.discoveryRuns).values([
    { companyId: asking.id, status: "needs_confirmation", candidates: CANDIDATES, startedAt: new Date(Date.now() - 60_000) },
    // An earlier run for the same company that found nothing: only the newest one is read.
    { companyId: asking.id, status: "not_found", candidates: [], startedAt: new Date(Date.now() - 600_000) },
    // A source is already scanning, so this one is a proposal rather than a setup step.
    { companyId: moved.id, status: "needs_confirmation", candidates: CANDIDATES, startedAt: new Date(Date.now() - 60_000) },
    { companyId: quiet.id, status: "resolved", candidates: CANDIDATES, chosenSourceId: quietSource!.id, startedAt: new Date(Date.now() - 60_000) },
    { companyId: paused.id, status: "needs_confirmation", candidates: CANDIDATES, startedAt: new Date(Date.now() - 60_000) },
  ]);

  const items = await healthItems(account.id);
  expect(items.map((item) => [item.kind, item.company?.name])).toEqual([
    ["needs_confirmation", "Asking"],
    ["blocked", "Blocked Co"],
    ["failing", "Failing Co"],
    ["no_source", "Nothing Co"],
    ["rediscovery", "Moved Co"],
  ]);
  // The sidebar counts the same union in one statement; the two must never disagree.
  expect(await countHealthItems(account.id)).toBe(items.length);
  expect(await healthItems(stranger.id)).toHaveLength(1);
  expect(await countHealthItems(stranger.id)).toBe(1);

  const [asked, blockedItem, failingItem, noSource, proposal] = items;
  // Candidates arrive with the position `useDiscoveryCandidate` takes, so "Use this" resolves them.
  expect(asked!.runId).not.toBeNull();
  expect(asked!.candidates.map((c) => [c.index, c.type, c.confidence])).toEqual([[0, "greenhouse", 0.98], [1, "html", 0.4]]);
  expect(healthItemHeadline(asked!)).toBe("Discovery found 2 candidates; nobody has picked one");

  expect(healthItemHeadline(blockedItem!)).toBe("The board is refusing our requests");
  expect(healthItemDetail(blockedItem!)).toBe("403 from the board");
  expect(blockedItem!.source).toMatchObject({ id: blockedSource!.id, type: "html" });

  // Named as what it is, with the figure from the source's own counter.
  expect(healthItemHeadline(failingItem!)).toBe("Failed 4 scans in a row");
  expect(healthItemDetail(failingItem!)).toBe("the feed timed out");
  expect(healthItemDetail({ ...failingItem!, reason: null })).toBe(`A source is marked failing after ${SOURCE_FAILING_AFTER} failed scans in a row.`);

  expect(healthItemHeadline(noSource!)).toBe("No careers page to scan");
  expect(noSource!.source).toBeNull();

  expect(healthItemHeadline(proposal!)).toBe("Discovery found another careers page");
  expect(proposal!.candidates).toHaveLength(2);
  expect(proposal!.source).toBeNull();

  // Pausing a company is a resolution: it stops being asked about.
  await database.update(schema.companySubscriptions).set({ status: "paused" })
    .where(sql`user_id = ${account.id} and company_id = ${failing.id}`);
  expect((await healthItems(account.id)).map((item) => item.company?.name)).not.toContain("Failing Co");
  expect(await countHealthItems(account.id)).toBe(4);
  expect(movedSource!.id).toBeTruthy();
});

it("puts a spent AI budget first, and says what stops until it resets", async () => {
  await resetAttention();
  const account = await ensureTestUser(database, "spent@example.com");
  const empty = await healthItems(account.id);
  expect(empty).toEqual([]);

  await database.insert(schema.userSettings).values({ userId: account.id, key: "aiBudgetUsd", value: 5 });
  await database.insert(schema.aiCalls).values([
    { userId: account.id, callSite: "CV", model: "test-model", costUsd: 3 },
    { userId: account.id, callSite: "A5", model: "test-model", costUsd: 2 },
  ]);

  const items = await healthItems(account.id);
  expect(items.map((item) => item.kind)).toEqual(["budget"]);
  expect(items[0]!.company).toBeNull();
  expect(healthItemHeadline(items[0]!)).toBe(`AI budget spent · ${formatUsd(5)} of ${formatUsd(5)} this month`);
  expect(healthItemDetail(items[0]!)).toBe("Scoring, suggestions and CV builds stop for this account until the budget resets on the 1st.");
  expect(await countHealthItems(account.id)).toBe(1);

  // Raising the budget resolves it, which is what the item's link leads to.
  await database.update(schema.userSettings).set({ value: 20 }).where(sql`user_id = ${account.id} and key = 'aiBudgetUsd'`);
  expect(await healthItems(account.id)).toEqual([]);
  expect(await countHealthItems(account.id)).toBe(0);
});
