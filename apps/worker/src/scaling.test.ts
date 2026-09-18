import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { accountAiSpend, aiUsageByAccount, createDb, schema, totalAiSpend } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { aiBudgetWindowStart } from "@christopher/core";
import { sql } from "drizzle-orm";
import { reserveAi } from "./budget";
import { ensureTestUser } from "./test-users";
import { selectExamples } from "./recommendation-context";
const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate ai_calls, ai_reservations`));
afterAll(() => pool.end());
const recordCall = (costUsd: number, callSite = "A10") => db.insert(schema.aiCalls).values({ callSite, model: "fixture", costUsd });

it("atomically reserves concurrent spend and returns capacity the call never used", async () => {
  const limits = { daily: 1, discovery: 1 };
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
it("keeps the operator's day and discovery caps over the deployment, whoever a call is for", async () => {
  const user = await ensureTestUser(db, "capped@example.com");
  await db.insert(schema.aiCalls).values({ callSite: "A10", model: "fixture", costUsd: 0.8 });
  // This account has spent nothing and has plenty of budget; the caps still bind, and they count
  // every account's calls together with the work that belongs to nobody.
  const account = { userId: user.id, budgetUsd: 1000, since: new Date(Date.now() - 86_400_000) };
  expect(await reserveAi(db, "A10", 0.3, { account, daily: 0.85, discovery: 10 })).toBeNull();
  expect(await reserveAi(db, "A10", 0.1, { account, daily: 10, discovery: 0.85 })).toBeNull();
  expect(await reserveAi(db, "A10", 0.1, { daily: 10, discovery: 0.85 })).toBeNull();
  // Only discovery call sites are measured against the discovery cap.
  expect(await reserveAi(db, "CV", 0.1, { account, daily: 10, discovery: 0.85 })).not.toBeNull();
  // Unlimited is what an operator who sets neither gets.
  expect(await reserveAi(db, "A10", 5, { daily: 1_000_000, discovery: 1_000_000 })).not.toBeNull();
});
it("holds one account's capacity against its own budget and window, and marks the hold with the account", async () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const monthStart = new Date("2026-09-01T00:00:00Z");
  const user = await ensureTestUser(db, "reserver@example.com");
  const other = await ensureTestUser(db, "bystander@example.com");
  await db.insert(schema.aiCalls).values([
    { userId: user.id, callSite: "CV", model: "fixture", costUsd: 0.8, at: new Date("2026-09-17T09:00:00Z") },
    // Another account's spend, and work that belongs to nobody, never touch this account's budget.
    { userId: other.id, callSite: "CV", model: "fixture", costUsd: 50, at: monthStart },
    { callSite: "A3", model: "fixture", costUsd: 50, at: monthStart },
  ]);
  const spender = (budgetUsd: number, since = monthStart) => ({ account: { userId: user.id, budgetUsd, since }, daily: 1_000_000, discovery: 1_000_000 });
  // $0.80 of this account's $1 is gone this month.
  expect(await reserveAi(db, "CV", 0.3, spender(1), now)).toBeNull();
  // A reset made at 10:00 moves this account's window past that spend, so the same call now fits.
  const reset = new Date("2026-09-17T10:00:00.000Z");
  const held = await reserveAi(db, "CV", 0.3, spender(1, reset), now);
  expect(held).not.toBeNull();
  // The hold names the account, so its own next call sees it while the deployment is unaffected.
  const holders = await db.execute<{ userId: string | null }>(sql`select user_id as "userId" from ai_reservations`);
  expect(holders.rows.map((row) => row.userId)).toEqual([user.id]);
  expect(await reserveAi(db, "CV", 0.8, spender(1, reset), now)).toBeNull();
  // Another account, and work with no account behind it, are not refused by this account's hold.
  expect(await reserveAi(db, "CV", 0.8, { account: { userId: other.id, budgetUsd: 100, since: monthStart }, daily: 1_000_000, discovery: 1_000_000 }, now)).not.toBeNull();
  expect(await reserveAi(db, "A3", 0.8, { daily: 1_000_000, discovery: 1_000_000 }, now)).not.toBeNull();
  // Released capacity comes back to the account that held it.
  await held!();
  expect(await reserveAi(db, "CV", 0.8, spender(1, reset), now)).not.toBeNull();
});

it("zeroes every account's spend counter as the account-budget migration lands, and does nothing on a second run", async () => {
  const statements = (await readFile(new URL("../../../packages/db/drizzle/0021_account_ai_budgets.sql", import.meta.url), "utf8"))
    .split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
  const user = await ensureTestUser(db, "budget-migration@example.com");
  // The state the migration meets: spend on the books and no reset marker for anyone. The spend is
  // dated a minute ago so the assertions below cannot turn on which side of one millisecond the
  // marker landed; the migration records it at the moment it runs.
  const spentBefore = new Date(Date.now() - 60_000);
  await db.execute(sql`delete from user_settings where key in ('aiBudgetResetAt', 'aiBudgetUsd')`);
  await db.insert(schema.aiCalls).values({ userId: user.id, callSite: "A5", model: "fixture", costUsd: 7, at: spentBefore });
  for (const statement of statements) await db.execute(sql.raw(statement));

  const marker = async (userId: string) => (await db.execute<{ at: string | null }>(
    sql`select value #>> '{}' as at from user_settings where user_id = ${userId} and key = 'aiBudgetResetAt'`)).rows[0]?.at ?? null;
  const own = await marker(user.id);
  expect(own).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(Math.abs(Date.parse(own!) - Date.now())).toBeLessThan(5 * 60_000);
  // Every account carries its own marker; the budget itself is not stored, because its default is in code.
  const missing = await db.execute<{ n: number }>(sql`select count(*)::int as n from users u
    where not exists (select 1 from user_settings s where s.user_id = u.id and s.key = 'aiBudgetResetAt')`);
  expect(missing.rows[0]!.n).toBe(0);
  const budgets = await db.execute<{ n: number }>(sql`select count(*)::int as n from user_settings where key = 'aiBudgetUsd'`);
  expect(budgets.rows[0]!.n).toBe(0);
  // There is no shared budget and no shared marker: the migration writes nothing to `settings`.
  const shared = await db.execute<{ n: number }>(sql`select count(*)::int as n from settings where key in ('aiBudgetResetAt', 'monthlyAiBudgetUsd')`);
  expect(shared.rows[0]!.n).toBe(0);

  // The $7 was recorded before the marker, so this month now reads as unspent for that account,
  // while the deployment's own report of the month still shows every call ever made.
  const window = aiBudgetWindowStart(new Date(), own);
  expect(window.toISOString()).toBe(own);
  expect(await accountAiSpend(db, user.id, window)).toBe(0);
  expect(await accountAiSpend(db, user.id, spentBefore)).toBe(7);
  expect(await totalAiSpend(db, aiBudgetWindowStart(new Date(), null))).toBe(7);

  // Applying it again is a no-op: a marker already in place is never moved.
  for (const statement of statements) await db.execute(sql.raw(statement));
  expect(await marker(user.id)).toBe(own);
});

it("gives reservations an account column that a hold may leave empty", async () => {
  // Migration 0022, applied by runMigrations above: a hold says whose budget it is against, and
  // work that belongs to nobody records none.
  const column = await db.execute<{ dataType: string; nullable: string }>(sql`select data_type as "dataType", is_nullable as nullable
    from information_schema.columns where table_name = 'ai_reservations' and column_name = 'user_id'`);
  expect(column.rows[0]).toMatchObject({ dataType: "uuid", nullable: "YES" });
  const user = await ensureTestUser(db, "reservation-column@example.com");
  const limits = { daily: 1_000_000, discovery: 1_000_000 };
  expect(await reserveAi(db, "A3", 0.1, limits)).not.toBeNull();
  expect(await reserveAi(db, "CV", 0.1, { ...limits, account: { userId: user.id, budgetUsd: 10, since: new Date(Date.now() - 86_400_000) } })).not.toBeNull();
  const holds = await db.execute<{ userId: string | null; callSite: string }>(sql`select user_id as "userId", call_site as "callSite" from ai_reservations order by call_site`);
  expect(holds.rows).toEqual([{ userId: null, callSite: "A3" }, { userId: user.id, callSite: "CV" }]);
  // Deleting the account takes its holds with it; the call log is another matter and is kept.
  await db.execute(sql`delete from users where id = ${user.id}`);
  expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from ai_reservations`)).rows[0]!.n).toBe(1);
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
  expect(await totalAiSpend(db, since)).toBeCloseTo(5.25, 5);
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
  const limits = { daily: 1, discovery: 1 };
  expect(await reserveAi(db, "A10", 0.8, limits)).not.toBeNull();
  // While the hold stands the same capacity is never lent twice.
  expect(await reserveAi(db, "A10", 0.3, limits)).toBeNull();
  await db.execute(sql`update ai_reservations set expires_at=now()-interval '1 minute'`);
  expect(await reserveAi(db, "A10", 0.3, limits)).not.toBeNull();
});

it("does not charge the budget for a call that failed without spending", async () => {
  const limits = { daily: 1, discovery: 1 };
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
