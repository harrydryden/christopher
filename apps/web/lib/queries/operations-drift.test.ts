/**
 * Operations' figures for CV builds that must be computed by the database rather than folded in
 * JavaScript: percentiles (which cannot be added up), cost per build by week, and the three rates
 * watched for drift.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { aiFeatureLabel } from "@ava/core";
import { sql } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { cvDriftRate, getAiUsage, getCvBuildMotions, getCvBuildWeeks, getCvDriftRates } from "./health";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate ai_calls, cv_drafts, users restart identity cascade`);
  user = await ensureTestUser(database, "drift@example.com");
});

const tokens = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };

it("takes a folded feature's p95 over the union of its call sites, not a mean of their p95s", async () => {
  const at = new Date(Date.now() - 60_000);
  // A1: ten fast calls. A2: ten slow ones. The union's p95 is in the slow half; the old
  // calls-weighted mean of the two p95s (1 s and 10 s, ten calls each) said 5.5 s.
  await database.insert(schema.aiCalls).values([
    ...Array.from({ length: 10 }, () => ({ userId: user.id, callSite: "A1", model: "m", ...tokens, costUsd: 0.01, durationMs: 1_000, at })),
    ...Array.from({ length: 10 }, () => ({ userId: user.id, callSite: "A2", model: "m", ...tokens, costUsd: 0.01, durationMs: 10_000, at })),
  ]);
  const [line] = await getAiUsage(new Date(Date.now() - 3_600_000));
  expect(line!.feature).toBe(aiFeatureLabel("A1"));
  expect(line!.calls).toBe(20);
  expect(line!.p95DurationMs).toBe(10_000);
  expect(line!.p50DurationMs).toBe(5_500);
});

it("reports each motion's median and 95th percentile from the database", async () => {
  const [draft] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobTitle: "Role", companyName: "Co", jobDescription: "x", libraryVersion: 1,
    librarySnapshot: { name: "x", contact: "", profile: "", entries: [] }, model: "m", status: "ready",
  }).returning();
  await database.insert(schema.cvBuildSteps).values(
    Array.from({ length: 20 }, (_, i) => ({
      draftId: draft!.id, userId: user.id, attempt: 1, seq: i + 1, stage: "writing" as const, motion: "write" as const, title: "Writing",
      status: "done" as const, ms: (i + 1) * 1_000, detail: { usd: 0.1 },
    })),
  );
  const [write] = await getCvBuildMotions(30);
  expect(write).toMatchObject({ motion: "write", runs: 20, failed: 0 });
  // 1 s … 20 s: the median is 10.5 s and the p95 is 19.05 s.
  expect(write!.medianMs).toBe(10_500);
  expect(write!.p95Ms).toBe(19_050);
});

it("totals CV builds by week, dating each by its first call", async () => {
  const monday = new Date("2026-09-14T10:00:00.000Z");
  const daysAgo = Math.floor((Date.now() - monday.getTime()) / 86_400_000);
  if (daysAgo > 60) return; // The window is twelve weeks back from now; this suite runs near its date.
  await database.insert(schema.aiCalls).values([
    { userId: user.id, callSite: "CV", model: "m", ...tokens, costUsd: 1, refType: "cv-build", refId: "d1", at: monday },
    // A retry of d1 three days later adds to d1, in d1's week.
    { userId: user.id, callSite: "CV", model: "m", ...tokens, costUsd: 2, refType: "cv-build", refId: "d1", at: new Date(monday.getTime() + 3 * 86_400_000) },
    { userId: user.id, callSite: "CV", model: "m", ...tokens, costUsd: 5, refType: "cv-build", refId: "d2", at: new Date(monday.getTime() + 86_400_000) },
  ]);
  const weeks = await getCvBuildWeeks(12);
  const week = weeks.find((row) => row.week.toISOString().startsWith("2026-09-14"));
  expect(week).toMatchObject({ builds: 2, totalUsd: 8, medianUsd: 4 });
});

it("computes the three drift rates and flags only a rate resting on enough events", async () => {
  const [draft] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobTitle: "Role", companyName: "Co", jobDescription: "x", libraryVersion: 1,
    librarySnapshot: { name: "x", contact: "", profile: "", entries: [] }, model: "m", status: "ready",
  }).returning();
  // Twelve comparisons, one revision kept: 8% acceptance, under the 20% threshold.
  await database.insert(schema.cvBuildSteps).values(
    Array.from({ length: 12 }, (_, i) => ({
      draftId: draft!.id, userId: user.id, attempt: 1, seq: i + 1, stage: "assessing" as const, motion: "compare_content" as const, title: "Comparing",
      status: "done" as const, detail: { accepted: i === 0 },
    })),
  );
  const at = new Date(Date.now() - 60_000);
  const call = (stage: string, error?: string) => ({ userId: user.id, callSite: "CV", model: "m", ...tokens, costUsd: 0.1, refType: "cv-build", refId: "d", stage, at, ...(error ? { ok: false, error } : {}) });
  await database.insert(schema.aiCalls).values([
    ...Array.from({ length: 20 }, () => call("review")),
    ...Array.from({ length: 2 }, () => call("review_retry")),
    call("author", "refusal: the model declined"),
  ]);
  const rates = await getCvDriftRates(30);
  const byKey = Object.fromEntries(rates.map((rate) => [rate.key, rate]));
  expect(byKey.improvement_acceptance).toMatchObject({ numerator: 1, denominator: 12, flagged: true, direction: "below" });
  expect(byKey.correction_rerun).toMatchObject({ numerator: 2, denominator: 20, flagged: false });
  expect(byKey.refusal).toMatchObject({ numerator: 1, denominator: 23, flagged: true });
  expect(byKey.refusal!.rate).toBeCloseTo(1 / 23, 6);
  // Fewer than ten events is noise: shown, never flagged.
  expect(cvDriftRate("refusal", 1, 5).flagged).toBe(false);
  expect(cvDriftRate("correction_rerun", 0, 0).rate).toBeNull();
});
