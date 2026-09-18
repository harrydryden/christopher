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
