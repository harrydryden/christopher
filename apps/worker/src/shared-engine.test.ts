import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { STREAM_CEILING_MS, SDK_MAX_RETRIES, type AiClientLike, type ParseResponse } from "@ava/ai";
import { createDeps, holdMinutesFor, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { ensureTestUser } from "./test-users";

/**
 * The shared engine as the worker builds it: which model it picks, and how long the hold each of
 * its calls takes lives.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
let deps: WorkerDeps;
let db: Db;
let userId: string;
const asked: Array<Record<string, unknown>> = [];
let release: () => void = () => {};
let heldOpen = false;
const client: AiClientLike = { messages: { create: async params => {
  asked.push(params);
  if (heldOpen) await new Promise<void>(resolve => { release = resolve; });
  return { parsed_output: { score: 60, verdict: "possible", rationale: "Maybe.", flags: [] }, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" } satisfies ParseResponse;
} } };

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { aiClient: client });
  db = deps.db;
  userId = (await ensureTestUser(db, "shared-engine@example.com")).id;
}, 60_000);
afterAll(async () => { await db.execute(sql`truncate ai_calls, ai_reservations, settings`); await deps?.close(); });
beforeEach(async () => {
  asked.length = 0;
  heldOpen = false;
  await db.execute(sql`truncate ai_calls, ai_reservations, settings`);
  deps.invalidateSettings();
});

const score = () => deps.ai.scoreJob({ profileMarkdown: "", decisionDigest: "", job: { title: "Operations Manager", company: "Acme" } }, { userId });

it("uses the administrator's model for the first call after the settings cache was cleared", async () => {
  await db.insert(schema.settings).values([{ key: "defaultModel", value: "claude-haiku-4-5" }, { key: "modelOverrides", value: { A5: "claude-opus-5" } }]);
  deps.invalidateSettings();
  expect(await score()).toMatchObject({ score: 60 });
  expect(asked[0]!.model).toBe("claude-opus-5");
  const [row] = await db.select().from(schema.aiCalls);
  expect(row!.model).toBe("claude-opus-5");
});

it("holds a call for as long as the call may run, not the default fifteen minutes", async () => {
  heldOpen = true;
  const pending = score();
  for (let tick = 0; tick < 200 && !asked.length; tick++) await new Promise(resolve => setTimeout(resolve, 5));
  const rows = await db.execute<{ minutes: number }>(sql`select extract(epoch from (expires_at - created_at)) / 60 as minutes from ai_reservations`);
  // Three attempts at A5's thirty-second wait to begin, the stream's ceiling, and a minute's slack.
  const expected = Math.ceil(((SDK_MAX_RETRIES + 1) * 30_000 + STREAM_CEILING_MS + 60_000) / 60_000);
  expect(Math.round(Number(rows.rows[0]!.minutes))).toBe(expected);
  expect(expected).toBeGreaterThan(15);
  release();
  await pending;
  expect(holdMinutesFor(undefined)).toBe(15);
});
