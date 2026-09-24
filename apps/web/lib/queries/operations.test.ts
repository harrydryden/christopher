/**
 * Operations' worker and queue cards, read the way the page reads them: the worker's state in one
 * statement, the two task lists, and one statement naming everything they mention. The answer must
 * be exactly what the separate readers give, which the Health page and the tests of each still use.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import {
  getLastCrashRecovery,
  getWorkerStatus,
  listRecentWorkerEvents,
  listRetryingTasks,
  listRunningTasks,
  operationsActivity,
  resolveSubjects,
} from "./health";

const MINUTE = 60_000;
let account: User;
let ids: { company: string; cv: string; source: string; job: string };

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());

beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, worker_events, settings, cv_drafts, users restart identity cascade`);
  account = await ensureTestUser(database, "operations@example.com");
  const [company] = await database.insert(schema.companies).values({ name: "Stripe", homepageUrl: "https://stripe.com", domain: "stripe.com" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "greenhouse", url: "https://boards.greenhouse.io/stripe" }).returning();
  const [job] = await database.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: "id:1", title: "Staff Engineer", normalizedTitle: "staff engineer", url: "https://stripe.com/jobs/1",
  }).returning();
  const [cv] = await database.insert(schema.cvDrafts).values({
    userId: account.id, jobTitle: "Staff Engineer", companyName: "Stripe", jobDescription: "…",
    libraryVersion: 1, librarySnapshot: {} as never, model: "claude-fable-5-1",
  }).returning();
  ids = { company: company!.id, cv: cv!.id, source: source!.id, job: job!.id };

  const now = Date.now();
  await database.insert(schema.settings).values({ key: "internal:workerHeartbeat", value: { at: new Date(now).toISOString(), workerId: "worker-a", aiConfigured: true, browserAvailable: true } });
  await database.insert(schema.workerEvents).values([
    { workerId: "worker-a", kind: "boot", detail: { concurrency: 3, commit: "c".repeat(40) }, at: new Date(now - 20 * MINUTE) },
    {
      workerId: "worker-a", kind: "crash_recovery", at: new Date(now - 10 * MINUTE),
      detail: {
        likely: { id: "11111111-1111-4111-8111-111111111111" },
        suspects: [
          { id: "22222222-2222-4222-8222-222222222222", type: "generate_cv", attempts: 4, lockedBy: "worker-a", subject: `generate_cv:${ids.cv}` },
          { id: "11111111-1111-4111-8111-111111111111", type: "scan_company", attempts: 9, lockedBy: "worker-a", subject: `scan_company:${ids.company}` },
        ],
      },
    },
    { workerId: "worker-a", kind: "task_abandoned", taskType: "scan_company", userId: account.id, at: new Date(now - 5 * MINUTE),
      detail: { attempts: 3, maxAttempts: 3, subject: `scan_company:${ids.company}`, error: "heap" } },
  ]);
  const started = new Date(now - 2 * MINUTE);
  await database.insert(schema.tasks).values([
    { type: "scan_company", payload: { companyId: ids.company }, status: "running", startedAt: started, lockedAt: started, lockedBy: "worker-a", attempts: 1 },
    { type: "monitor_source", payload: { sourceId: ids.source }, status: "running", startedAt: new Date(started.getTime() + 1000), lockedAt: started, lockedBy: "worker-a", attempts: 1 },
    { type: "suggest_filters", payload: { userId: account.id }, status: "queued", attempts: 2, error: "worker restarted" },
    { type: "score_job", payload: { jobId: ids.job, userId: account.id }, status: "queued", attempts: 1, error: "timed out" },
  ]);
});

/** Statements sent to the database while `read` runs. */
async function statements<T>(read: () => Promise<T>): Promise<{ value: T; count: number }> {
  const spy = vi.spyOn(pool, "query");
  try {
    const value = await read();
    return { value, count: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

it("answers exactly what the separate readers answer, in four statements", async () => {
  const now = new Date();
  const { value: activity, count } = await statements(() => operationsActivity(now, Promise.resolve([account.id, null])));
  expect(count).toBe(4);

  expect(activity.status).toEqual(await getWorkerStatus(now));
  expect(activity.status.heartbeat?.concurrency).toBe(3);
  expect(activity.status.restartsLastHour).toBe(1);
  expect(activity.crash).toEqual(await getLastCrashRecovery());
  expect(activity.crash!.suspects.map((s) => [s.subject, s.likely])).toEqual([["Stripe", true], ["CV: Stripe · Staff Engineer", false]]);
  expect(activity.running).toEqual(await listRunningTasks(25));
  expect(activity.running.map((t) => t.subject)).toEqual(["Stripe", "Stripe (greenhouse)"]);
  expect(activity.retrying).toEqual(await listRetryingTasks(25));
  expect(activity.retrying.map((t) => t.subject)).toEqual(["operations@example.com", "Stripe · Staff Engineer"]);
  expect(activity.events).toEqual(await listRecentWorkerEvents(30));
  expect(activity.events.map((e) => [e.kind, e.subject])).toEqual([["task_abandoned", "Stripe"], ["crash_recovery", null], ["boot", null]]);
  // The spend table's accounts are named in the same statement.
  expect(activity.accountEmail(account.id)).toBe("operations@example.com");
  expect(activity.accountEmail("33333333-3333-4333-8333-333333333333")).toBeNull();
});

it("reads the worker's status in one statement and names every kind of subject in one more", async () => {
  expect((await statements(() => getWorkerStatus())).count).toBe(1);
  const { value: names, count } = await statements(() => resolveSubjects([
    { kind: "company", id: ids.company }, { kind: "cv", id: ids.cv }, { kind: "user", id: account.id },
    { kind: "source", id: ids.source }, { kind: "job", id: ids.job }, null,
  ]));
  expect(count).toBe(1);
  expect([...names.values()].sort()).toEqual(["CV: Stripe · Staff Engineer", "Stripe", "Stripe (greenhouse)", "Stripe · Staff Engineer", "operations@example.com"]);
  expect((await statements(() => resolveSubjects([null]))).count).toBe(0);
});

it("still reads the heartbeat and the queue on a database without the worker's ledger", async () => {
  await database.execute(sql`alter table worker_events rename to worker_events_hidden`);
  try {
    const activity = await operationsActivity(new Date(), Promise.resolve([]));
    expect(activity.status.heartbeat?.workerId).toBe("worker-a");
    expect(activity.status.restartsLastDay).toBe(0);
    expect(activity.crash).toBeNull();
    expect(activity.events).toEqual([]);
    expect(activity.running).toHaveLength(2);
  } finally {
    await database.execute(sql`alter table worker_events_hidden rename to worker_events`);
  }
});
