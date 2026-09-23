/** `/healthz`: one reading of the database serves every caller for a few seconds. */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createDb, enqueueTask, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { startHealthServer } from "./health";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

let deps: WorkerDeps;
let db: Db;

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);

afterAll(async () => { await deps?.close(); });
beforeEach(async () => { await db.execute(sql`truncate tasks, ai_calls, worker_events restart identity cascade`); });

async function serve<T>(work: (url: string) => Promise<T>): Promise<T> {
  const server = startHealthServer(deps, 0, () => ({ active: 0 }));
  await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try { return await work(`http://127.0.0.1:${port}/healthz`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

it("answers with the queue and workload in one reading, and reuses it for a few seconds", async () => {
  await enqueueTask(db, "discover", { companyId: "a" });
  await serve(async url => {
    const first = await (await fetch(url)).json() as { ok: boolean; metrics: Record<string, number>; queue: unknown };
    expect(first.ok).toBe(true);
    expect(first.metrics.ready).toBe(1);
    expect(first.metrics).toMatchObject({
      running: 0, overdueCompanies: 0, overdueDiscovery: 0, reservedUsd: 0,
      crashRecoveries1h: 0, crashRecoveries24h: 0,
      providerCalls1h: 0, providerSuccesses1h: 0, providerFailures1h: 0,
      providerOutageGroups1h: 0, spend24hUsd: 0, spendMonthUsd: 0,
      accountsAtOrOverBudget: 0,
    });
    expect(first.queue).toBeTruthy();

    // Concurrent and immediately repeated polls are answered from the cached reading rather than
    // running the aggregates again — the new task is not visible yet.
    await enqueueTask(db, "discover", { companyId: "b" });
    const again = await Promise.all([fetch(url), fetch(url)].map(async r => (await (await r).json()) as { metrics: Record<string, number> }));
    expect(again.map(r => r.metrics.ready)).toEqual([1, 1]);
  });

  // A fresh server has no cache, so the second task shows at once.
  await serve(async url => {
    const fresh = await (await fetch(url)).json() as { metrics: Record<string, number> };
    expect(fresh.metrics.ready).toBe(2);
  });
});

it("reports persisted restart, provider and spend evidence without exposing call details", async () => {
  await db.insert(schema.workerEvents).values([
    { workerId: "old-a", kind: "crash_recovery" },
    { workerId: "old-b", kind: "crash_recovery" },
  ]);
  await db.insert(schema.aiCalls).values([
    { callSite: "CV", model: "broken", ok: false, error: "transport failure", costUsd: 1 },
    { callSite: "CV", model: "broken", ok: false, error: "Stream timed out: stalled", costUsd: 1 },
    // A failed row written by older/erroring code may have no message; NULL must still be a failure.
    { callSite: "CV", model: "broken", ok: false, error: null, costUsd: 1 },
    // A success in another call-site/model group must not hide the persistent CV failure.
    { callSite: "A3", model: "healthy", ok: true, costUsd: 2 },
    // Cancelled siblings are neither provider attempts nor failures.
    { callSite: "CV", model: "broken", ok: false, error: "Cancelled because another call failed", costUsd: 0 },
  ]);
  await serve(async url => {
    const body = await (await fetch(url)).json() as { metrics: Record<string, number> };
    expect(body.metrics).toMatchObject({
      crashRecoveries1h: 2, crashRecoveries24h: 2,
      providerCalls1h: 4, providerSuccesses1h: 1, providerFailures1h: 3,
      providerOutageGroups1h: 1, spend24hUsd: 5, spendMonthUsd: 5,
    });
    expect(JSON.stringify(body.metrics)).not.toContain("transport failure");
  });
});

it("counts account-budget attention with default, reset and UTC-month windows", async () => {
  const now = new Date();
  const defaulted = await ensureTestUser(db, "ops-default@example.com", "member");
  const zero = await ensureTestUser(db, "ops-zero@example.com", "member");
  const normal = await ensureTestUser(db, "ops-normal@example.com", "member");
  const reset = await ensureTestUser(db, "ops-reset@example.com", "member");
  const old = await ensureTestUser(db, "ops-old@example.com", "member");
  const malformed = await ensureTestUser(db, "ops-malformed-reset@example.com", "member");
  await db.delete(schema.userSettings).where(sql`user_id in (${sql.join([defaulted, zero, normal, reset, old, malformed].map(user => sql`${user.id}`), sql`, `)})`);
  await db.insert(schema.userSettings).values([
    { userId: zero.id, key: "aiBudgetUsd", value: 0 },
    { userId: normal.id, key: "aiBudgetUsd", value: 10 },
    { userId: reset.id, key: "aiBudgetUsd", value: 1 },
    { userId: reset.id, key: "aiBudgetResetAt", value: new Date(now.getTime() - 30 * 60_000).toISOString() },
    { userId: old.id, key: "aiBudgetUsd", value: 1 },
    { userId: malformed.id, key: "aiBudgetUsd", value: 1 },
    // A corrupt legacy/manual value that resembles ISO must not make /healthz return 500.
    { userId: malformed.id, key: "aiBudgetResetAt", value: "2026-99-99T99:99:99Z" },
  ]);
  const previousUtcMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  await db.insert(schema.aiCalls).values([
    // No stored budget means the product default ($25).
    { userId: defaulted.id, callSite: "CV", model: "fixture", costUsd: 25, at: now },
    // Zero budget and zero spend deliberately disables AI and must not create attention.
    { userId: normal.id, callSite: "CV", model: "fixture", costUsd: 9, at: now },
    // Spend before this account's reset is excluded; spend after it reaches the new window's limit.
    { userId: reset.id, callSite: "CV", model: "fixture", costUsd: 20, at: new Date(now.getTime() - 60 * 60_000) },
    { userId: reset.id, callSite: "CV", model: "fixture", costUsd: 1, at: now },
    // A call before the current UTC month is outside an account with no reset marker.
    { userId: old.id, callSite: "CV", model: "fixture", costUsd: 5, at: previousUtcMonth },
    // Invalid reset markers follow the same safe fallback as the product resolver: current UTC month.
    { userId: malformed.id, callSite: "CV", model: "fixture", costUsd: 1, at: now },
  ]);
  await serve(async url => {
    const body = await (await fetch(url)).json() as { metrics: Record<string, number> };
    expect(body.metrics.accountsAtOrOverBudget).toBe(3);
  });
});
