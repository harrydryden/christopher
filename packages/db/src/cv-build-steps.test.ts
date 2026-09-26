/**
 * The motion statistics behind "usually about" and Operations' build card.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { cvBuildSteps, cvDrafts, users } from "./schema";
import { cvBuildMotionStats } from "./cv-build-steps";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test", { max: 1 });
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate users restart identity cascade`));
afterAll(() => pool.end());

it("takes a motion's medians, and the count that gates them, from its finished runs alone", async () => {
  const [user] = await db.insert(users).values({ email: "motion-stats@example.com" }).returning();
  const [draft] = await db.insert(cvDrafts).values({
    userId: user!.id, jobTitle: "Operations Director", companyName: "Example", jobDescription: "Lead a team.",
    libraryVersion: 1, librarySnapshot: {} as never, model: "test-model",
  }).returning();
  const at = new Date(Date.now() - 60_000);
  const base = { draftId: draft!.id, userId: user!.id, attempt: 1, stage: "writing" as const, motion: "write" as const, title: "Writing the CV", startedAt: at };
  await db.insert(cvBuildSteps).values([
    // Three writes that finished, at 100 s, 120 s and 140 s.
    { ...base, seq: 1, status: "done", ms: 100_000, detail: { usd: 1 } },
    { ...base, seq: 2, status: "done", ms: 120_000, detail: { usd: 1.2 } },
    { ...base, seq: 3, status: "done", ms: 140_000, detail: { usd: 1.4 } },
    // Wording reused from a checkpoint took no time; a dropped call and an interrupted one stopped
    // part-way. None of them is how long writing takes.
    { ...base, seq: 4, status: "skipped", ms: 0, detail: { reused: "checkpoint" } },
    { ...base, seq: 5, status: "skipped", ms: 1, detail: { cancelled: true } },
    { ...base, seq: 6, status: "failed", ms: 2_000, detail: { usd: 0.01 }, error: "overloaded" },
  ]);
  const [write] = await cvBuildMotionStats(db, 30);
  expect(write).toMatchObject({ motion: "write", runs: 6, failed: 1, done: 3, medianMs: 120_000 });
  expect(write!.medianUsd).toBeCloseTo(1.2, 5);
});
