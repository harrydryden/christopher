/**
 * Each account's own AI budget: its limit, and the window its spend is counted in. The limit is a
 * `user_settings` key with a default, and the window starts at the later of the month and the
 * account's reset marker, so a reset stops old spend counting without deleting any of it.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { DEFAULT_ACCOUNT_AI_BUDGET_USD, MAX_ACCOUNT_AI_BUDGET_USD } from "@ava/core";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/db", () => ({ db: () => { reads.n++; return database; } }));
import { accountAiSpend } from "@ava/db";
import { accountAiBudget, accountAiBudgets } from "./accounts";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate ai_calls, user_settings, users restart identity cascade`);
  user = await ensureTestUser(database, "spender@example.com");
  other = await ensureTestUser(database, "quiet@example.com", "member");
});

it("counts one account's own spend this month against its own budget", async () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  await database.insert(schema.aiCalls).values([
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 4, at: monthStart },
    // Last month's spend, shared work and another account are all somebody else's problem.
    { userId: user.id, callSite: "A5", model: "claude-sonnet-5", costUsd: 8, at: new Date(monthStart.getTime() - 1_000) },
    { userId: null, callSite: "A3", model: "claude-sonnet-5", costUsd: 7, at: monthStart },
    { userId: other.id, callSite: "A5", model: "claude-sonnet-5", costUsd: 2, at: monthStart },
  ]);

  const budgets = await accountAiBudgets([user.id, other.id], now);
  expect(budgets.get(user.id)).toMatchObject({ limitUsd: DEFAULT_ACCOUNT_AI_BUDGET_USD, spentUsd: 4, countingSince: null });
  expect(budgets.get(user.id)!.since.getTime()).toBe(monthStart.getTime());
  expect(budgets.get(other.id)).toMatchObject({ spentUsd: 2 });
  expect(await accountAiBudgets([], now)).toEqual(new Map());

  // A raised budget is read back; an impossible one is clamped rather than believed.
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 60 });
  expect((await accountAiBudget(user.id, now)).limitUsd).toBe(60);
  await database.update(schema.userSettings).set({ value: 10_000_000 }).where(sql`user_id = ${user.id} and key = 'aiBudgetUsd'`);
  expect((await accountAiBudget(user.id, now)).limitUsd).toBe(MAX_ACCOUNT_AI_BUDGET_USD);
});

it("counts from the reset marker once an administrator has moved it, and never past the month", async () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const reset = new Date(now.getTime() - 3_600_000);
  await database.insert(schema.aiCalls).values([
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 4, at: monthStart },
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 1, at: new Date(now.getTime() - 60_000) },
  ]);
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetResetAt", value: reset.toISOString() });

  const after = await accountAiBudget(user.id, now);
  expect(after.spentUsd).toBe(1);
  expect(after.countingSince?.getTime()).toBe(reset.getTime());

  // A marker from before this month, or an unusable one, cannot widen the window past the month.
  for (const value of [new Date(monthStart.getTime() - 86_400_000).toISOString(), "not a date"]) {
    await database.update(schema.userSettings).set({ value }).where(sql`user_id = ${user.id} and key = 'aiBudgetResetAt'`);
    const budget = await accountAiBudget(user.id, now);
    expect(budget.countingSince).toBeNull();
    expect(budget.spentUsd).toBe(5);
  }
});

it("counts one account's window from its own marker alone, whatever another account carries", async () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const reset = new Date(monthStart.getTime() + 60_000);
  await database.insert(schema.aiCalls).values([
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 5, at: monthStart },
    { userId: other.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 3, at: monthStart },
  ]);
  // Resetting one account moves that account's window and nobody else's: there is no marker
  // anywhere else for an account to inherit.
  await database.insert(schema.userSettings).values({ userId: other.id, key: "aiBudgetResetAt", value: reset.toISOString() });

  const untouched = await accountAiBudget(user.id, now);
  expect(untouched.since.getTime()).toBe(monthStart.getTime());
  expect(untouched.countingSince).toBeNull();
  expect(untouched.spentUsd).toBe(5);
  expect(await accountAiBudget(other.id, now)).toMatchObject({ spentUsd: 0, countingSince: reset });
});

it("reads any number of accounts' budgets in one statement, each in its own window", async () => {
  // Admin › Accounts used to send one spend query per listed account into a three-connection pool.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const accounts = [user, other];
  for (let n = 0; n < 58; n++) accounts.push(await ensureTestUser(database, `listed-${n}@example.com`, "member"));
  await database.insert(schema.aiCalls).values(accounts.flatMap((account, n) => [
    { userId: account.id, callSite: "CV", model: "claude-fable-5-1", costUsd: n + 1, at: monthStart },
    { userId: account.id, callSite: "A5", model: "claude-sonnet-5", costUsd: 0.5, at: new Date(now.getTime() - 60_000) },
  ]));
  // Every third account was reset an hour ago, so only its last minute counts.
  const reset = new Date(now.getTime() - 3_600_000);
  await database.insert(schema.userSettings).values(accounts.filter((_, n) => n % 3 === 0).map((account) => ({ userId: account.id, key: "aiBudgetResetAt", value: reset.toISOString() })));
  await database.insert(schema.userSettings).values({ userId: other.id, key: "aiBudgetUsd", value: 40 });

  reads.n = 0;
  const budgets = await accountAiBudgets(accounts.map((account) => account.id), now);
  expect(reads.n).toBe(1);
  expect(budgets.size).toBe(accounts.length);
  for (const [n, account] of accounts.entries()) {
    const budget = budgets.get(account.id)!;
    expect(budget.spentUsd).toBeCloseTo(await accountAiSpend(database, account.id, budget.since), 6);
    expect(budget.spentUsd).toBeCloseTo(n % 3 === 0 ? 0.5 : n + 1.5, 6);
    expect(budget.countingSince?.getTime() ?? null).toBe(n % 3 === 0 ? reset.getTime() : null);
  }
  expect(budgets.get(other.id)!.limitUsd).toBe(40);
});

it("sums again by core's rule when the database would read a marker differently", async () => {
  // PostgreSQL reads "tomorrow" as a time; core does not, and core's reading is the budget.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  await database.insert(schema.aiCalls).values({ userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 3, at: monthStart });
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetResetAt", value: "tomorrow" });
  reads.n = 0;
  const budget = (await accountAiBudgets([user.id], now)).get(user.id)!;
  expect(budget).toMatchObject({ spentUsd: 3, countingSince: null });
  expect(budget.since.getTime()).toBe(monthStart.getTime());
  expect(reads.n).toBe(2);
});
