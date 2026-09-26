/**
 * The call ledger's newer columns: written when the database has them, and left out — with the
 * call and its cost still recorded — when it does not yet, which is a release running a few
 * minutes ahead of the migration that adds them.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { recordAiCall, resetAiCallColumnsProbe } from "./ai-budget";
import { aiCalls } from "./schema";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test", { max: 1 });
beforeAll(() => runMigrations(db));
beforeEach(() => resetAiCallColumnsProbe());
afterAll(async () => {
  resetAiCallColumnsProbe();
  await pool.end();
});

const call = (id: string) => ({
  id, callSite: "CV", model: "claude-fable-5-1", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
  costUsd: 0.01, durationMs: 1200, ok: true, stage: "review_candidate",
  promptId: "cv.review_candidate", promptVersion: "abc123def0", ttftMs: 812.4, maxEventGapMs: 30_000.6,
  stopReason: "end_turn", requestId: "req_1", attempt: 2, stepId: "step-7",
});

it("records the prompt and the stream's figures on every call", async () => {
  const id = randomUUID();
  await recordAiCall(db, null, call(id));
  const [row] = await db.select().from(aiCalls).where(eq(aiCalls.id, id));
  expect(row).toMatchObject({
    promptId: "cv.review_candidate", promptVersion: "abc123def0", ttftMs: 812, maxEventGapMs: 30_001,
    stopReason: "end_turn", requestId: "req_1", attempt: 2, stepId: "step-7", stage: "review_candidate",
  });
  await db.delete(aiCalls).where(eq(aiCalls.id, id));
});

it("still records the call and its cost on a database without the newer columns", async () => {
  const id = randomUUID();
  let landed: unknown[] = [];
  await db.transaction(async tx => {
    // Undone by the rollback: DDL is transactional, and so is what the probe reads.
    for (const column of ["prompt_id", "prompt_version", "ttft_ms", "max_event_gap_ms", "stop_reason", "request_id", "attempt", "step_id"])
      await tx.execute(sql`alter table ai_calls drop column ${sql.identifier(column)}`);
    await recordAiCall(tx, null, call(id));
    landed = (await tx.execute(sql`select cost_usd, stage from ai_calls where id = ${id}`)).rows;
    tx.rollback();
  }).catch(error => {
    if (!landed.length) throw error;
  });
  expect(landed).toEqual([{ cost_usd: 0.01, stage: "review_candidate" }]);
  // The probe asks again once the columns are back, rather than remembering their absence.
  const again = randomUUID();
  await recordAiCall(db, null, call(again));
  const [row] = await db.select().from(aiCalls).where(eq(aiCalls.id, again));
  expect(row!.promptId).toBe("cv.review_candidate");
  await db.delete(aiCalls).where(eq(aiCalls.id, again));
});
