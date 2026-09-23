/**
 * The sidebar's Health count, within one request. The layout, Health's own count and Health's
 * items all ask for it, so it is read once per request: React's request memo stands in for
 * `cache` here, which outside a server render memoises nothing.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/db", () => ({ db: () => { reads.n++; return database; } }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new Map<string, R>();
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key)!;
    };
  };
  return { ...actual, cache };
});
import { countHealthItems } from "./health";
import { accountAiBudget } from "./accounts";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate ai_calls, user_settings, companies, users restart identity cascade`);
});

it("counts once per request for every caller in the same budget month, in one round trip", async () => {
  const user = await ensureTestUser(database, "health-count@example.com", "member");
  const other = await ensureTestUser(database, "health-other@example.com", "member");
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 1 });
  await database.insert(schema.aiCalls).values({ userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 2, at: monthStart });

  reads.n = 0;
  // The layout's count: the attention union and the budget statement, side by side.
  expect(await countHealthItems(user.id)).toBe(1);
  expect(reads.n).toBe(2);
  // Health's own count, with its own clock, and its items' budget: both already answered.
  expect(await countHealthItems(user.id, new Date(now.getTime() + 1_000))).toBe(1);
  expect((await accountAiBudget(user.id, now)).spentUsd).toBe(2);
  expect(reads.n).toBe(2);
  // Another account is its own answer.
  expect(await countHealthItems(other.id, now)).toBe(0);
  expect(reads.n).toBe(4);
});
