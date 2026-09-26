/**
 * The record → replay → grade gate, end to end against the scripted client: a published draft is
 * recorded through the real handler, replayed from the recording with no client and no key, and
 * graded — and neither run leaves a trace in the database.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createScriptedAiClient } from "../../web/test/scripted-ai-client";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { TaskQueue } from "./queue";
import { handleGenerateCv } from "./handlers/cv";
import { onAbandon } from "./handlers/abandon";
import { ensureTestUser } from "./test-users";
import { seedReplayFixtureDraft } from "./cv-replay-fixture";
import { mergeStageRoutes, recordCvDraft, replayFromRecording } from "./cv-replay";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

let deps: WorkerDeps;
let db: Db;
let userId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv());
  await runMigrations(deps.db);
  db = deps.db;
  userId = (await ensureTestUser(db, "cv-replay@example.com")).id;
}, 60_000);
afterAll(async () => { await deps?.close(); });
beforeEach(async () => {
  await db.execute(sql`truncate tasks, applications, cv_build_steps, cv_share_comments, cv_shares, cv_drafts, ai_calls, ai_reservations, worker_events`);
  deps.userSettings = (async () => ({ aiBudgetUsd: 1000, aiBudgetResetAt: null })) as unknown as WorkerDeps["userSettings"];
  deps.aiClient = undefined;
  deps.env.anthropicApiKey = "fixture-key";
});

/** A published fixture draft, built through the queue against the scripted client. */
async function publishedDraft() {
  const draft = await seedReplayFixtureDraft(db, userId);
  deps.aiClient = createScriptedAiClient({ barrierMs: 200 }).client;
  await new TaskQueue(deps, { generate_cv: handleGenerateCv }, { concurrency: 1, workerId: "replay-test", onAbandon }).drain();
  deps.aiClient = undefined;
  const [row] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(row!.status).toBe("ready");
  return row!;
}

/** Everything a rebuild could have touched, so a test can say it touched none of it. */
async function footprint() {
  const count = async (table: string) => Number((await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]!.n);
  return {
    drafts: await db.select().from(schema.cvDrafts).orderBy(schema.cvDrafts.createdAt),
    users: await count("users"), aiCalls: await count("ai_calls"), holds: await count("ai_reservations"),
    tasks: await count("tasks"), steps: await count("cv_build_steps"), plans: await count("cv_tailoring_plans"),
    leases: await count("resource_leases"), versions: await count("cv_versions"),
  };
}

it("records a build through the real handler, replays it with no key and no client, grades it, and leaves nothing behind", async () => {
  const draft = await publishedDraft();
  const before = await footprint();
  const path = join(mkdtempSync(join(tmpdir(), "ava-replay-")), "recording.jsonl");

  deps.aiClient = createScriptedAiClient({ barrierMs: 200 }).client;
  const recorded = await recordCvDraft(deps, draft.id, { path });
  deps.aiClient = undefined;
  expect(recorded.report).toMatchObject({ outcome: "published", source: "live", unverified: true, misses: [] });
  expect(recorded.report.calls).toBeGreaterThan(0);
  expect(recorded.report.grade?.passed).toBe(true);
  const lines = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string });
  expect(lines[0]).toMatchObject({ kind: "meta", draftId: draft.id, client: "injected" });
  expect(lines.at(-1)).toMatchObject({ kind: "baseline" });
  expect(lines.filter(line => line.kind === "call")).toHaveLength(recorded.report.calls);
  expect(readFileSync(path, "utf8")).not.toContain("fixture-key");

  // No key, no client: every answer comes from the recording.
  deps.env.anthropicApiKey = undefined;
  const replay = await replayFromRecording(deps, draft.id, path);
  expect(replay.report).toMatchObject({ outcome: "published", source: "recording", misses: [], unverified: true });
  expect(replay.report.calls).toBe(recorded.report.calls);
  expect(replay.report.costUsd).toBeCloseTo(recorded.report.costUsd, 6);
  expect(replay.report.baseline?.source).toBe("recording");
  expect(replay.report.grade).toMatchObject({
    passed: true,
    invariants: { claimsSupported: true, coverageNotLower: true, pageLimitMet: true, noEssentialRegressed: true },
  });
  expect(replay.report.promptSetVersion).toMatch(/^[0-9a-f]{12}$/);
  expect(replay.report.routes["cv.review"]).toEqual({ model: "cvModel", resolvedModel: draft.model, effort: "high" });

  // Neither the recording nor the replay wrote anything that outlived it.
  expect(await footprint()).toEqual(before);
}, 120_000);

it("fails a replay asked for another route, naming the prompt and version the recording does not hold", async () => {
  const draft = await publishedDraft();
  const path = join(mkdtempSync(join(tmpdir(), "ava-replay-")), "recording.jsonl");
  deps.aiClient = createScriptedAiClient({ barrierMs: 200 }).client;
  await recordCvDraft(deps, draft.id, { path });
  deps.aiClient = undefined;

  const routes = { "cv.review": { effort: "medium" as const }, "cv.review_candidate": { effort: "medium" as const } };
  const replay = await replayFromRecording(deps, draft.id, path, routes);
  expect(replay.report.outcome).toBe("failed");
  expect(replay.report.routes["cv.review"]!.effort).toBe("medium");
  expect(replay.report.routeOverrides).toEqual(routes);
  expect(replay.report.misses.map(miss => miss.promptId)).toContain("cv.review");
  expect(replay.report.grade).toBeNull();
}, 120_000);

it("lays the command's routes over the deployment's, field by field", () => {
  expect(mergeStageRoutes({ "cv.review": { model: "claude-sonnet-5" }, "cv.author": { effort: "xhigh" } }, { "cv.review": { effort: "medium" } }))
    .toEqual({ "cv.review": { model: "claude-sonnet-5", effort: "medium" }, "cv.author": { effort: "xhigh" } });
});
