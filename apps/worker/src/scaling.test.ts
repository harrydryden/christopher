import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { accountAiSpend, aiUsageByAccount, createDb, schema, sharedAiSpend } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { aiBudgetWindowStart } from "@christopher/core";
import { sql } from "drizzle-orm";
import { reserveAi } from "./budget";
import { ensureTestUser } from "./test-users";
import { selectExamples } from "./recommendation-context";
const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate ai_calls, ai_reservations, ai_spend_periods`));
afterAll(() => pool.end());
const recordCall = (costUsd: number, callSite = "A10") => db.insert(schema.aiCalls).values({ callSite, model: "fixture", costUsd });

it("atomically reserves concurrent spend and returns capacity the call never used", async () => {
  const limits = { monthly: 1, daily: 1, discovery: 1 };
  const reservations = await Promise.all(Array.from({ length: 10 }, () => reserveAi(db, "A10", 0.6, limits)));
  expect(reservations.filter(Boolean)).toHaveLength(1);
  // The engine records the call's real cost before releasing its hold, so only that cost counts.
  await recordCall(0.2);
  await reservations.find(Boolean)!();
  const second = await reserveAi(db, "A10", 0.6, limits);
  expect(second).not.toBeNull();
  await second!();
  // The second call recorded nothing, so its capacity comes back rather than being burned.
  expect(await reserveAi(db, "A10", 0.7, limits)).not.toBeNull();
});
it("counts recorded spend and protects the discovery allowance", async () => {
  await db.insert(schema.aiCalls).values({ callSite: "A10", model: "fixture", costUsd: 0.8 });
  expect(await reserveAi(db, "A10", 0.3, { monthly: 1, daily: 10, discovery: 10 })).toBeNull();
  expect(await reserveAi(db, "A10", 0.1, { monthly: 10, daily: 10, discovery: 0.85 })).toBeNull();
  expect(await reserveAi(db, "CV", 0.1, { monthly: 10, daily: 10, discovery: 0.85 })).not.toBeNull();
});
it("counts the shared budget from its reset marker, leaving the day's allowance whole", async () => {
  const now = new Date("2026-09-17T12:00:00Z");
  await db.insert(schema.aiCalls).values({ callSite: "A10", model: "fixture", costUsd: 0.8, at: new Date("2026-09-17T09:00:00Z") });
  // Without a marker the month has $0.80 of its $1 gone.
  expect(await reserveAi(db, "A10", 0.3, { monthly: 1, daily: 10, discovery: 10 }, now)).toBeNull();
  // A reset made at 10:00 moves the window past that spend, so the same call now fits.
  const held = await reserveAi(db, "A10", 0.3, { monthly: 1, daily: 10, discovery: 10, resetAt: "2026-09-17T10:00:00.000Z" }, now);
  expect(held).not.toBeNull();
  await held!();
  // The daily and discovery allowances keep their own day, which the reset does not move.
  expect(await reserveAi(db, "A10", 0.3, { monthly: 1, daily: 0.85, discovery: 10, resetAt: "2026-09-17T10:00:00.000Z" }, now)).toBeNull();
  expect(await reserveAi(db, "A10", 0.3, { monthly: 1, daily: 10, discovery: 0.85, resetAt: "2026-09-17T10:00:00.000Z" }, now)).toBeNull();
  // An unusable marker is no marker: the month start still bounds the window.
  expect(await reserveAi(db, "A10", 0.3, { monthly: 1, daily: 10, discovery: 10, resetAt: "not a date" }, now)).toBeNull();
});

it("zeroes every spend counter as the account-budget migration lands, and does nothing on a second run", async () => {
  const statements = (await readFile(new URL("../../../packages/db/drizzle/0021_account_ai_budgets.sql", import.meta.url), "utf8"))
    .split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
  const user = await ensureTestUser(db, "budget-migration@example.com");
  // The state the migration meets: spend on the books and no reset marker anywhere.
  await db.execute(sql`delete from settings where key = 'aiBudgetResetAt'`);
  await db.execute(sql`delete from user_settings where key in ('aiBudgetResetAt', 'aiBudgetUsd')`);
  await db.insert(schema.aiCalls).values({ userId: user.id, callSite: "A5", model: "fixture", costUsd: 7 });
  for (const statement of statements) await db.execute(sql.raw(statement));

  const marker = async () => (await db.execute<{ at: string | null }>(sql`select value #>> '{}' as at from settings where key = 'aiBudgetResetAt'`)).rows[0]?.at ?? null;
  const shared = await marker();
  expect(shared).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(Math.abs(Date.parse(shared!) - Date.now())).toBeLessThan(5 * 60_000);
  // Every account carries its own marker; the budget itself is not stored, because its default is in code.
  const missing = await db.execute<{ n: number }>(sql`select count(*)::int as n from users u
    where not exists (select 1 from user_settings s where s.user_id = u.id and s.key = 'aiBudgetResetAt')`);
  expect(missing.rows[0]!.n).toBe(0);
  const budgets = await db.execute<{ n: number }>(sql`select count(*)::int as n from user_settings where key = 'aiBudgetUsd'`);
  expect(budgets.rows[0]!.n).toBe(0);

  // The $7 was recorded before the marker, so this month now reads as unspent for that account.
  const window = aiBudgetWindowStart(new Date(), shared);
  expect(window.toISOString()).toBe(shared);
  expect(await accountAiSpend(db, user.id, window)).toBe(0);
  expect(await sharedAiSpend(db, window)).toBe(0);
  expect(await accountAiSpend(db, user.id, new Date(Date.parse(shared!) - 60_000))).toBe(7);

  // Applying it again is a no-op: a marker already in place is never moved.
  for (const statement of statements) await db.execute(sql.raw(statement));
  expect(await marker()).toBe(shared);
});

it("reports what each account spent, by call site and model, dearest first", async () => {
  const user = await ensureTestUser(db, "budget-usage@example.com");
  const since = new Date(Date.now() - 60_000);
  await db.insert(schema.aiCalls).values([
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 3.5, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 7 },
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 0.5, inputTokens: 10, outputTokens: 2, ok: false, error: "no parseable output" },
    { userId: user.id, callSite: "A5", model: "claude-sonnet-5", costUsd: 0.25 },
    // Shared work carries no account: it counts against the ceiling, never against a person.
    { callSite: "A3", model: "claude-sonnet-5", costUsd: 1 },
    // Older than the window, so out of every figure below.
    { userId: user.id, callSite: "A5", model: "claude-sonnet-5", costUsd: 99, at: new Date(Date.now() - 3 * 60_000) },
  ]);
  expect(await accountAiSpend(db, user.id, since)).toBeCloseTo(4.25, 5);
  expect(await sharedAiSpend(db, since)).toBeCloseTo(5.25, 5);
  const usage = await aiUsageByAccount(db, since);
  expect(usage.map((row) => [row.userId, row.callSite, row.model, row.costUsd])).toEqual([
    [user.id, "CV", "claude-fable-5-1", 4],
    [null, "A3", "claude-sonnet-5", 1],
    [user.id, "A5", "claude-sonnet-5", 0.25],
  ]);
  expect(usage[0]).toMatchObject({ calls: 2, failed: 1, inputTokens: 110, outputTokens: 22, cacheReadTokens: 5, cacheWriteTokens: 7 });
});

it("selects bounded, deterministic examples across sectors and document relevance", () => {
  const rows = Array.from({ length: 1000 }, (_, n) => ({ name: `Company ${n}`, domain: `${n}.test`, sector: n > 950 ? "Robotics" : `Sector ${n % 15}` }));
  const examples = selectExamples(rows, "Robotics expansion in London");
  expect(examples).toHaveLength(40);
  expect(examples[0]!.sector).toBe("Robotics");
  expect(new Set(examples.map(r => r.sector)).size).toBeGreaterThan(10);
  expect(selectExamples([...rows].reverse(), "Robotics expansion in London")).toEqual(examples);
});

it("holds capacity for a crashed process, then returns what its call never spent", async () => {
  const limits = { monthly: 1, daily: 1, discovery: 1 };
  expect(await reserveAi(db, "A10", 0.8, limits)).not.toBeNull();
  // While the hold stands the same capacity is never lent twice.
  expect(await reserveAi(db, "A10", 0.3, limits)).toBeNull();
  await db.execute(sql`update ai_reservations set expires_at=now()-interval '1 minute'`);
  expect(await reserveAi(db, "A10", 0.3, limits)).not.toBeNull();
});

it("does not charge the budget for a call that failed without spending", async () => {
  const limits = { monthly: 1, daily: 1, discovery: 1 };
  // What a timeout leaves behind: a released hold and a recorded call that cost nothing. Charging
  // the estimate instead used to refuse every later call while Health reported the month unused.
  const settle = await reserveAi(db, "A10", 0.9, limits);
  await recordCall(0);
  await settle!();
  expect(await reserveAi(db, "A10", 0.9, limits)).not.toBeNull();
});

it("fences a reclaimed operation without holding a database transaction across external work", async () => {
  const { withResourceLease, LeaseBusyError } = await import("./lease");
  const deps = { db } as unknown as import("./context").WorkerDeps;
  const key = `test-operation-${Date.now()}`;
  await withResourceLease(deps, key, async locked => {
    await expect(withResourceLease(deps, key, async () => true)).rejects.toBeInstanceOf(LeaseBusyError);
    const transactions = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'`);
    expect(transactions.rows[0]!.n).toBe(0);
    await db.execute(sql`update resource_leases set owner=gen_random_uuid() where key=${key}`);
    await expect(db.transaction(async tx => locked.assertOwnership!(tx as unknown as typeof db))).rejects.toThrow("lease lost");
  });
  await db.execute(sql`delete from resource_leases where key=${key}`);
});
