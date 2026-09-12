import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Task } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { AiEngine } from "@christopher/ai";
import { eq, sql } from "drizzle-orm";
import { handleGenerateCv } from "./handlers/cv";
import type { WorkerDeps } from "./context";
const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
const library = { name: "Test Candidate", contact: "London", profile: "Operations", entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
beforeAll(async () => { await runMigrations(client.db); });
beforeEach(async () => { vi.restoreAllMocks(); await client.db.execute(sql`truncate applications, cv_drafts, ai_calls`); });
afterAll(async () => { vi.restoreAllMocks(); await client.pool.end(); });
async function setup(apiKey: string | undefined = "fixture-key") {
  const [draft] = await client.db.insert(schema.cvDrafts).values({ jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5" }).returning();
  const deps = { db: client.db, env: { anthropicApiKey: apiKey }, settings: async () => ({ monthlyAiBudgetUsd: 100 }), now: () => new Date() } as unknown as WorkerDeps;
  return { draft: draft!, deps, task: { type: "generate_cv", payload: { draftId: draft!.id } } as unknown as Task };
}
it("generates once on duplicate delivery, preserving the saved evidence", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  const results = await Promise.allSettled([handleGenerateCv(task, deps), handleGenerateCv(task, deps)]);
  expect(results.some(r => r.status === "fulfilled")).toBe(true);
  await handleGenerateCv(task, deps);
  expect(build).toHaveBeenCalledTimes(1);
  expect(build.mock.calls[0]![0].library).toEqual(library);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready"); expect(saved!.content?.sections[0]?.heading).toBe("Director · Acme");
});
it("shows missing credentials as a recoverable failed draft", async () => {
  const { task, deps, draft } = await setup(); deps.env.anthropicApiKey = undefined;
  await handleGenerateCv(task, deps);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("failed"); expect(saved!.error).toContain("ANTHROPIC_API_KEY");
});
it("excludes unconfirmed rows from the model while preserving the original snapshot", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  const snapshot = { ...library, entries: [{ ...library.entries[0]!, details: "Led a team\nAn unconfirmed proposal" }] };
  await client.db.update(schema.cvDrafts).set({ librarySnapshot: snapshot }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build.mock.calls[0]![0].library.entries[0]!.details).toBe("Led a team");
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.librarySnapshot).toEqual(snapshot);
});
it("does not spend an AI call when all experience rows are unconfirmed", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv");
  const { task, deps, draft } = await setup();
  await client.db.update(schema.cvDrafts).set({ librarySnapshot: { ...library, entries: [{ ...library.entries[0]!, confirmedResponsibilities: [] }] } }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build).not.toHaveBeenCalled();
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("failed");
  expect(saved!.error).toContain("confirm the responsibilities");
});
it("rejects model claims referencing invented evidence", async () => {
  vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Leader", sections: [{ entryId: "fabricated", bullets: ["Piloted aircraft"] }], gaps: [] });
  const { task, deps, draft } = await setup(); await handleGenerateCv(task, deps);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("failed"); expect(saved!.content).toBeNull();
});

it("combines employment evidence and freezes central role metadata without rewriting the library snapshot", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Leader", sections: [{ entryId: "one", industryDescriptions: ["SaaS"], bullets: ["Led a team and built tools"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  const snapshot = { ...library, employment: [{ id: "job", company: "Acme", industryDescriptions: "Healthcare, SaaS", jobTitle: "Operations Director", startDate: "2023-08", endDate: "", current: true }], entries: [
    { ...library.entries[0]!, employmentId: "job", heading: "Team leadership" },
    { id: "two", kind: "experience" as const, employmentId: "job", heading: "Automation", details: "Built tools", confirmedResponsibilities: ["Built tools"] },
  ] };
  await client.db.update(schema.cvDrafts).set({ librarySnapshot: snapshot }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build.mock.calls[0]![0].library.entries).toHaveLength(1);
  expect(build.mock.calls[0]![0].library.entries[0]!.details).toContain("Built tools");
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.content!.sections[0]!.heading).toBe("Operations Director · Acme · Aug 2023 – Present");
  expect(saved!.content!.sections[0]!.industryDescriptions).toEqual(["SaaS"]);
  expect(saved!.librarySnapshot).toEqual(snapshot);
});

it("measures generated content and retries an oversized CV before marking it ready", async () => {
  const short = { summary: "Operations leader", sections: ["one", "two", "three", "four", "five", "six", "seven", "eight"].map(entryId => ({ entryId, bullets: ["Led a team"] })), gaps: [] };
  const long = { ...short, summary: "Operations leader with experience planning and reporting. ".repeat(29), sections: ["one", "two", "three", "four", "five", "six", "seven", "eight"].map(entryId => ({ entryId, bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) })) };
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValueOnce(long).mockResolvedValueOnce(short);
  const { task, deps, draft } = await setup();
  await client.db.update(schema.cvDrafts).set({ librarySnapshot: { ...library, entries: ["one", "two", "three", "four", "five", "six", "seven", "eight"].map(id => ({ ...library.entries[0]!, id, heading: `Director ${id}` })) } }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build).toHaveBeenCalledTimes(2);
  expect(build.mock.calls[1]![0].layoutFeedback?.pageCount).toBeGreaterThan(2);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.content!.summary).toBe(short.summary);
});
it("fails after three oversized attempts instead of returning an over-limit CV", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader with experience planning and reporting. ".repeat(29), sections: ["one", "two", "three", "four", "five", "six", "seven", "eight"].map(entryId => ({ entryId, bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) })), gaps: [] });
  const { task, deps, draft } = await setup();
  await client.db.update(schema.cvDrafts).set({ librarySnapshot: { ...library, entries: ["one", "two", "three", "four", "five", "six", "seven", "eight"].map(id => ({ ...library.entries[0]!, id, heading: `Director ${id}` })) } }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build).toHaveBeenCalledTimes(3);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("failed");
  expect(saved!.error).toContain("after three budgeted attempts");
  expect(saved!.content).toBeNull();
});

it("refits the submitted wording and preserves the queued revision number", async () => {
  const sourcePlan = { summary: "Current edited profile", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] };
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ ...sourcePlan, summary: "Operations leader" });
  const { task, deps, draft } = await setup();
  task.payload = { draftId: draft.id, sourcePlan };
  await client.db.update(schema.cvDrafts).set({ revision: 5 }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build.mock.calls[0]![0].layoutFeedback?.previousPlan).toEqual(sourcePlan);
  expect(build.mock.calls[0]![0].writingBudget?.summaryCharacters).toBe(420);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.revision).toBe(5);
  expect(saved!.content!.fitNotes).toContain("Profile rewritten within the two-page content budget.");
});
