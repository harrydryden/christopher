/**
 * Each account's own AI budget: its limit, and the window its spend is counted in. The limit is a
 * `user_settings` key with a default, and the window starts at the later of the month and the
 * account's reset marker, so a reset stops old spend counting without deleting any of it.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { DEFAULT_ACCOUNT_AI_BUDGET_USD, MAX_ACCOUNT_AI_BUDGET_USD } from "@christopher/core";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { accountAiBudget, accountAiBudgets } from "./accounts";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
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

it("counts from the shared reset marker when the account has none of its own, and from its own when it has", async () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const shared = new Date(monthStart.getTime() + 60_000);
  await database.insert(schema.settings).values({ key: "aiBudgetResetAt", value: shared.toISOString() });
  try {
    await database.insert(schema.aiCalls).values([
      { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 5, at: monthStart },
      { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 1, at: new Date(shared.getTime() + 1_000) },
    ]);
    // One shared reset starts every account afresh, exactly as the worker admits their work.
    const inherited = await accountAiBudget(user.id, now);
    expect(inherited.since.getTime()).toBe(shared.getTime());
    expect(inherited.countingSince?.getTime()).toBe(shared.getTime());
    expect(inherited.spentUsd).toBe(1);
    // An account's own marker wins over the shared one.
    await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetResetAt", value: new Date(shared.getTime() + 2_000).toISOString() });
    expect((await accountAiBudget(user.id, now)).spentUsd).toBe(0);
  } finally {
    await database.delete(schema.settings).where(sql`key = 'aiBudgetResetAt'`);
  }
});
