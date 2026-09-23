import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { aiOutcome, aiUsageByAccount, createDb, schema } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import {
  CANCELLED_ERROR, DEADLINE_ERROR_PREFIX, INTERRUPTED_ERROR_PREFIX, NO_OUTPUT_ERROR, OUTPUT_LIMIT_ERROR,
  REFUSAL_ERROR_PREFIX, SCHEMA_ERROR_PREFIX, STREAM_CEILING_MS,
} from "@ava/ai";
import { sql } from "drizzle-orm";
// Not re-exported from the package: its consumer, the outage query, lives beside it.
import { aiProviderFailureSql, isAiProviderFailure } from "../../../packages/db/src/ai-budget";

/**
 * The labels the engine writes, read back by the ledger that classifies them.
 *
 * One taxonomy across two packages: the engine names what happened to a call, and `ai_calls`
 * keeps only the text. These rows are what the engine writes, so a relabelling on either side
 * breaks here rather than quietly moving calls between Operations' columns or into the outage
 * alert.
 */
const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate ai_calls, ai_reservations`));
afterAll(() => pool.end());

const LABELS: Array<{ error: string | null; ok: boolean; outcome: string; provider: boolean }> = [
  { ok: true, error: null, outcome: "ok", provider: false },
  { ok: false, error: CANCELLED_ERROR, outcome: "cancelled", provider: false },
  { ok: false, error: `${DEADLINE_ERROR_PREFIX} score_job exceeded its 120s deadline after 120s and was abandoned`, outcome: "cancelled", provider: false },
  { ok: false, error: `${INTERRUPTED_ERROR_PREFIX} Task lease lost; another worker holds it`, outcome: "cancelled", provider: false },
  { ok: false, error: `Stream timed out: no complete response after ${STREAM_CEILING_MS / 60_000} minutes.`, outcome: "stalled", provider: true },
  { ok: false, error: `${REFUSAL_ERROR_PREFIX}cyber`, outcome: "failed", provider: false },
  { ok: false, error: OUTPUT_LIMIT_ERROR, outcome: "failed", provider: false },
  { ok: false, error: `${SCHEMA_ERROR_PREFIX} score: Invalid input`, outcome: "failed", provider: false },
  { ok: false, error: NO_OUTPUT_ERROR, outcome: "failed", provider: false },
  { ok: false, error: "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}", outcome: "failed", provider: true },
  { ok: false, error: "Connection error.", outcome: "failed", provider: true },
  { ok: false, error: null, outcome: "failed", provider: true },
];

it("classifies every label the engine writes the same way in a row and in SQL", async () => {
  await db.insert(schema.aiCalls).values(LABELS.map(label => ({ callSite: "A5", model: "fixture", costUsd: 0.01, ok: label.ok, error: label.error })));
  for (const label of LABELS) {
    expect(aiOutcome(label)).toBe(label.outcome);
    expect(isAiProviderFailure(label)).toBe(label.provider);
  }
  const [usage] = await aiUsageByAccount(db, new Date(0));
  expect(usage).toMatchObject({ calls: LABELS.length, cancelled: 3, stalled: 1, failed: 7 });
  const rows = await db.execute<{ ok: boolean; error: string | null; provider: boolean }>(sql`select ok, error, ${aiProviderFailureSql} as provider from ai_calls`);
  expect(rows.rows).toHaveLength(LABELS.length);
  for (const row of rows.rows) expect(row.provider).toBe(LABELS.find(label => label.ok === row.ok && label.error === row.error)!.provider);
});
