/** The suggestion worker uses a real database, but never contacts a model provider. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AiEngine } from "@col/ai";
import { cvHighlightedSkillRows, cvSkillEvidenceRows, cvSkillSuggestionInputHash, type CvLibrary } from "@col/core";
import { createDb, schema, type Task } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { eq, sql } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { handleSuggestCvSkills } from "./handlers/cv-skill-suggestions";
import { onAbandon } from "./handlers/abandon";
import { ensureTestUser } from "./test-users";

const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test");
const library: CvLibrary = {
  name: "Test Candidate", contact: "London", profile: "Operations leader",
  entries: [{ id: "one", kind: "experience", heading: "Director · Acme", details: "Led a team of six",
    confirmedResponsibilities: ["Led a team of six"] }],
};
const description = "Lead a team of six and improve operations.";
let userId: string;
let otherId: string;

beforeAll(async () => {
  await runMigrations(client.db);
  userId = (await ensureTestUser(client.db, "cv-skill-worker@example.com")).id;
  otherId = (await ensureTestUser(client.db, "cv-skill-worker-other@example.com")).id;
}, 60_000);
beforeEach(async () => {
  vi.restoreAllMocks();
  await client.db.execute(sql`truncate cv_libraries, cv_drafts, ai_calls, ai_reservations, tasks restart identity cascade`);
});
afterAll(async () => { vi.restoreAllMocks(); await client.pool.end(); });

function deps(budget = 1000): WorkerDeps {
  return {
    db: client.db,
    env: { anthropicApiKey: "fixture-key", workerId: "cv-skill-test" },
    userSettings: async () => ({ aiBudgetUsd: budget, aiBudgetResetAt: null, cvModel: "claude-sonnet-5" }),
    settings: async () => ({ stageRoutes: {} }),
    now: () => new Date(),
  } as unknown as WorkerDeps;
}

async function fixture(ownerId = userId) {
  await client.db.insert(schema.cvLibraries).values({ userId: ownerId, version: 1, content: library });
  const content = { name: library.name, contact: library.contact, summary: "Operations leader",
    sections: [{ entryId: "one", kind: "experience" as const, heading: "Director · Acme",
      bullets: ["Led a team of six"] }], gaps: [] };
  const [draft] = await client.db.insert(schema.cvDrafts).values({ userId: ownerId, jobTitle: "Operations Director",
    companyName: "Acme", jobDescription: description, libraryVersion: 1, librarySnapshot: library,
    model: "claude-sonnet-5", status: "ready", content }).returning();
  const [run] = await client.db.insert(schema.cvSkillSuggestionRuns).values({ userId: ownerId, draftId: draft!.id,
    libraryVersion: 1, inputHash: cvSkillSuggestionInputHash(1, draft!.id, description, cvSkillEvidenceRows(library), cvHighlightedSkillRows(content)) }).returning();
  const task = { type: "suggest_cv_skills", payload: { userId: ownerId, draftId: draft!.id, runId: run!.id } } as unknown as Task;
  return { draft: draft!, run: run!, task };
}

function modelAnswers(decision = true) {
  const propose = vi.spyOn(AiEngine.prototype, "suggestCvSkills").mockResolvedValue({ suggestions: [{
    category: "Leadership", label: "Team leadership", sourceId: "entry:one:row:0",
    evidenceQuote: "Led a team of six", roleQuote: "Lead a team of six",
  }] });
  const verify = vi.spyOn(AiEngine.prototype, "verifyCvSkills").mockResolvedValue({ decisions: [
    { index: 0, sourceSupports: decision, roleRelevant: true },
  ] });
  return { propose, verify };
}

async function savedRun(id: string) {
  const [run] = await client.db.select().from(schema.cvSkillSuggestionRuns).where(eq(schema.cvSkillSuggestionRuns.id, id));
  return run!;
}

it("publishes verified proposals without changing the Library or draft", async () => {
  const { task, run, draft } = await fixture();
  const { propose, verify } = modelAnswers();
  const result = await handleSuggestCvSkills(task, deps());
  expect(result).toEqual({ status: "ready", count: 1 });
  expect(propose).toHaveBeenCalledOnce();
  expect(verify).toHaveBeenCalledOnce();
  expect(await savedRun(run.id)).toMatchObject({ status: "ready", suggestions: [{ label: "Team leadership" }] });
  expect((await client.db.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, userId))).map(row => row.version)).toEqual([1]);
  expect((await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id)))[0]!.revision).toBe(0);
  expect(await client.db.select().from(schema.aiReservations)).toHaveLength(0);
});

it("drops a semantically rejected proposal", async () => {
  const { task, run } = await fixture();
  modelAnswers(false);
  expect(await handleSuggestCvSkills(task, deps())).toEqual({ status: "ready", count: 0 });
  expect((await savedRun(run.id)).suggestions).toEqual([]);
});

it("fails a proposal if the accepted Library changes during verification", async () => {
  const { task, run } = await fixture();
  const { verify } = modelAnswers();
  verify.mockImplementation(async () => {
    await client.db.insert(schema.cvLibraries).values({ userId, version: 2, content: library });
    return { decisions: [{ index: 0, sourceSupports: true, roleRelevant: true }] };
  });
  expect(await handleSuggestCvSkills(task, deps())).toEqual({ status: "failed", count: 0 });
  expect(await savedRun(run.id)).toMatchObject({ status: "failed", suggestions: [] });
});

it("fails a proposal if the draft role changes during verification", async () => {
  const { task, run, draft } = await fixture();
  const { verify } = modelAnswers();
  verify.mockImplementation(async () => {
    await client.db.update(schema.cvDrafts).set({ jobDescription: "A different role" }).where(eq(schema.cvDrafts.id, draft.id));
    return { decisions: [{ index: 0, sourceSupports: true, roleRelevant: true }] };
  });
  expect(await handleSuggestCvSkills(task, deps())).toEqual({ status: "failed", count: 0 });
  expect(await savedRun(run.id)).toMatchObject({ status: "failed", suggestions: [] });
});

it("rejects another owner's run or a mismatched draft before AI admission", async () => {
  const { task, run } = await fixture();
  const { propose, verify } = modelAnswers();
  expect(await handleSuggestCvSkills({ ...task, payload: { ...task.payload, userId: otherId } } as Task, deps()))
    .toMatchObject({ skipped: "suggestion run superseded" });
  expect(await handleSuggestCvSkills({ ...task, payload: { ...task.payload, draftId: crypto.randomUUID() } } as Task, deps()))
    .toMatchObject({ skipped: "suggestion run superseded" });
  expect(propose).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect((await savedRun(run.id)).status).toBe("queued");
  expect(await client.db.select().from(schema.aiReservations)).toHaveLength(0);
});

it("refuses a zero account budget before any model call", async () => {
  const { task, run } = await fixture();
  const { propose, verify } = modelAnswers();
  expect(await handleSuggestCvSkills(task, deps(0))).toEqual({ status: "failed", count: 0 });
  expect((await savedRun(run.id)).status).toBe("failed");
  expect(propose).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect(await client.db.select().from(schema.aiReservations)).toHaveLength(0);
});

it("rejects oversized confirmed Experience without sampling or reserving AI spend", async () => {
  const oversized: CvLibrary = { ...library, entries: Array.from({ length: 4 }, (_, index) => ({
    id: `long-role-${index}`, kind: "experience" as const, heading: `Role ${index}`,
    details: `Led delivery ${index} ${"x".repeat(34_000)}`,
    confirmedResponsibilities: [`Led delivery ${index} ${"x".repeat(34_000)}`],
  })) };
  const { task, run, draft } = await fixture();
  await client.db.update(schema.cvLibraries).set({ content: oversized }).where(eq(schema.cvLibraries.userId, userId));
  await client.db.update(schema.cvSkillSuggestionRuns).set({
    inputHash: cvSkillSuggestionInputHash(1, run.draftId, description, cvSkillEvidenceRows(oversized), cvHighlightedSkillRows(draft.content!)),
  }).where(eq(schema.cvSkillSuggestionRuns.id, run.id));
  const { propose, verify } = modelAnswers();
  expect(await handleSuggestCvSkills(task, deps())).toEqual({ status: "failed", count: 0 });
  expect(await savedRun(run.id)).toMatchObject({ status: "failed", suggestions: [] });
  expect(propose).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect(await client.db.select().from(schema.aiReservations)).toHaveLength(0);
});

it("marks an abandoned run failed so a fresh run can be queued", async () => {
  const { task, run, draft } = await fixture();
  await onAbandon.suggest_cv_skills!(task, deps(), "attempts exhausted");
  expect((await savedRun(run.id)).status).toBe("failed");
  const [newRun] = await client.db.insert(schema.cvSkillSuggestionRuns).values({ userId, draftId: draft.id,
    libraryVersion: 1, inputHash: run.inputHash }).returning();
  expect(newRun!.status).toBe("queued");
});
