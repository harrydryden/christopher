/**
 * Admin › Operations sends its queries into a web pool of three connections, where a query still
 * waiting for one after ten seconds fails the whole page. A render must stay under twenty
 * statements with every card populated, and never more than eight of them at once.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin", role: "admin" })), requireUser: vi.fn() }));
import AdminOperationsPage from "./page";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, worker_events, settings, scan_runs, ai_calls, users restart identity cascade`);
});

it("renders every card in fewer than twenty statements, at most eight at a time", async () => {
  // Every list has a row that names a subject, so each would once have looked its names up itself.
  const spender = await ensureTestUser(database, "spender@example.com", "member");
  const [company] = await database.insert(schema.companies).values({ name: "Acme", homepageUrl: "https://acme.example", domain: "acme.example" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs", status: "failing" }).returning();
  const [run] = await database.insert(schema.scanRuns).values({ runDate: "2026-09-23", trigger: "schedule", companiesTotal: 1 }).returning();
  await database.insert(schema.scans).values({ sourceId: source!.id, scanRunId: run!.id, status: "failed", fetchedBytes: 2048 });
  await database.insert(schema.settings).values({ key: "internal:workerHeartbeat", value: { at: new Date().toISOString(), workerId: "worker-a" } });
  await database.insert(schema.workerEvents).values([
    { workerId: "worker-a", kind: "crash_recovery", detail: { suspects: [{ id: "11111111-1111-4111-8111-111111111111", type: "scan_company", subject: `scan_company:${company!.id}` }] } },
    { workerId: "worker-a", kind: "task_abandoned", taskType: "scan_company", detail: { subject: `scan_company:${company!.id}` } },
  ]);
  await database.insert(schema.tasks).values([
    { type: "scan_company", payload: { companyId: company!.id }, status: "running", startedAt: new Date(), lockedBy: "worker-a" },
    { type: "suggest_filters", payload: { userId: spender.id }, status: "queued", attempts: 1, error: "worker restarted" },
    { type: "discover", payload: { companyId: company!.id }, status: "failed", error: "gave up", finishedAt: new Date() },
  ]);
  await database.insert(schema.aiCalls).values([
    { userId: spender.id, callSite: "A5", model: "claude-sonnet-5", costUsd: 1.25, at: new Date() },
    { userId: null, callSite: "A3", model: "claude-sonnet-5", costUsd: 0.5, at: new Date() },
  ]);

  let inFlight = 0;
  let widest = 0;
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
    inFlight++;
    widest = Math.max(widest, inFlight);
    return query(...args).finally(() => { inFlight--; });
  }) as never);
  try {
    const page = await AdminOperationsPage();
    expect(page).toBeTruthy();
    expect(spy.mock.calls.length).toBeLessThan(20);
    expect(widest).toBeLessThanOrEqual(8);
  } finally {
    spy.mockRestore();
  }
});
