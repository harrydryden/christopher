/** A13 proposals are private pending rows; a worker never turns them into confirmed CV evidence. */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { evidenceDraftFingerprint, type EvidenceDraftInput } from "@col/core";
import type { AiClientLike, ParseResponse } from "@col/ai";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleDraftEvidence } from "./handlers/evidence-draft";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test";
const now = new Date("2026-10-06T12:00:00Z");
const answer = "I helped the team reduce handover time by around 20%.";
const input: EvidenceDraftInput = { source: "library", questionId: "job:1:outcome", question: "What changed?",
  answer, destination: { kind: "employment", id: "job-1" }, baseVersion: 1, facet: "outcome",
  job: { company: "Example Company", title: "Operations lead", startDate: "2022", endDate: "", current: true } };
const safe = { wording: "Helped the team reduce handover time by around 20%.", quotes: [answer] };

let deps: WorkerDeps;
let db: Db;
let userId: string;
let draftId: string;

const task = (attempt = 1) => ({ id: crypto.randomUUID(), type: "draft_evidence",
  payload: { userId, evidenceDraftId: draftId, attempt }, attempts: 1 } as never);
const row = async () => (await db.select().from(schema.evidenceDrafts).where(eq(schema.evidenceDrafts.id, draftId)))[0]!;
const scripted = (output: unknown, onCall?: () => Promise<void>): AiClientLike => ({ messages: {
  async create(params): Promise<ParseResponse> {
    await onCall?.();
    return { parsed_output: output, usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn", model: params.model as string };
  },
} });

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db); await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL; process.env.COL_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
  userId = (await ensureTestUser(db, "evidence-draft-task@example.com")).id;
}, 60_000);
afterAll(async () => { await deps?.close(); });
beforeEach(async () => {
  await db.execute(sql`truncate tasks, evidence_drafts, cv_libraries, ai_calls, ai_reservations, user_settings restart identity cascade`);
  await db.update(schema.users).set({ emailVerifiedAt: now }).where(eq(schema.users.id, userId));
  await db.insert(schema.cvLibraries).values({ userId, version: 1, createdAt: now,
    content: { name: "Example", contact: "", profile: "", structuredExperience: true,
      employment: [{ id: "job-1", company: "Example Company", jobTitle: "Operations lead", startDate: "2022", endDate: "", current: true }], entries: [] } });
  const [draft] = await db.insert(schema.evidenceDrafts).values({ userId, input, fingerprint: evidenceDraftFingerprint(input) }).returning();
  draftId = draft!.id;
  deps.aiClient = undefined; deps.invalidateSettings();
});

it("stores a grounded proposal without changing the Library", async () => {
  deps.aiClient = scripted(safe);
  expect(await handleDraftEvidence(task(), deps)).toMatchObject({ status: "drafted" });
  expect(await row()).toMatchObject({ status: "drafted", wording: safe.wording, supportingQuotes: safe.quotes });
  expect((await db.select().from(schema.cvLibraries))[0]?.content.entries).toEqual([]);
});

it("refuses an unsupported claim and leaves the person's answer available", async () => {
  deps.aiClient = scripted({ wording: "Led the team to cut handover time by 30%.", quotes: [answer] });
  expect(await handleDraftEvidence(task(), deps)).toMatchObject({ status: "failed" });
  expect(await row()).toMatchObject({ status: "failed", wording: null });
  expect((await row()).input.answer).toBe(answer);
});

it("spends no model call when the account budget refuses admission", async () => {
  await db.insert(schema.userSettings).values({ userId, key: "aiBudgetUsd", value: 0 });
  let called = false;
  deps.aiClient = scripted(safe, async () => { called = true; });
  expect(await handleDraftEvidence(task(), deps)).toMatchObject({ status: "failed" });
  expect(called).toBe(false);
  expect((await row()).error).toContain("budget");
});

it("does not overwrite a draft confirmed while the model was in flight", async () => {
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  deps.aiClient = scripted(safe, async () => { started(); await held; });
  const running = handleDraftEvidence(task(), deps);
  await entered;
  await db.update(schema.evidenceDrafts).set({ status: "accepted", acceptedWording: answer,
    acceptedVersion: 2, resolvedAt: now }).where(eq(schema.evidenceDrafts.id, draftId));
  release();
  expect(await running).toMatchObject({ skipped: "draft resolved or superseded" });
  expect(await row()).toMatchObject({ status: "accepted", acceptedWording: answer, wording: null });
});

it("fences the result when task ownership was lost", async () => {
  deps.aiClient = scripted(safe);
  await expect(handleDraftEvidence(task(), { ...deps, assertOwnership: async () => { throw new Error("lease lost"); } }))
    .rejects.toThrow("lease lost");
  expect(await row()).toMatchObject({ status: "queued", wording: null });
});
