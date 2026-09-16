import {
  rubricFixture,
  reviewFixture,
} from "../../../packages/core/test/cv-review-fixture";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Task } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { AiEngine } from "@christopher/ai";
import { DEFAULT_CV_THEME } from "@christopher/core/cv";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "./test-users";
import { handleGenerateCv } from "./handlers/cv";
import type { WorkerDeps } from "./context";
const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
const library = { name: "Test Candidate", contact: "London", profile: "Operations", entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
let userId: string;
beforeAll(async () => { await runMigrations(client.db); userId = (await ensureTestUser(client.db, "cv@example.com")).id; });
beforeEach(async () => { vi.restoreAllMocks();
  vi.spyOn(AiEngine.prototype, "analyseCvJob").mockImplementation(
    async (description) => rubricFixture(description),
  );
  vi.spyOn(AiEngine.prototype, "assessCv").mockImplementation(async (input) =>
    reviewFixture(input),
  ); await client.db.execute(sql`truncate applications, cv_drafts, ai_calls`); });
afterAll(async () => { vi.restoreAllMocks(); await client.pool.end(); });
async function setup(apiKey: string | undefined = "fixture-key") {
  const [draft] = await client.db.insert(schema.cvDrafts).values({ userId, jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5" }).returning();
  const deps = { db: client.db, env: { anthropicApiKey: apiKey }, settings: async () => ({ monthlyAiBudgetUsd: 100 }), now: () => new Date() } as unknown as WorkerDeps;
  return { draft: draft!, deps, task: { type: "generate_cv", payload: { draftId: draft!.id } } as unknown as Task };
}
it("generates once on duplicate delivery, preserving the saved evidence", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  const results = await Promise.allSettled([handleGenerateCv(task, deps), handleGenerateCv(task, deps)]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
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
  const short = { summary: "Operations leader", sections: ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((entryId) => ({ entryId, bullets: ["Led a team"] })), gaps: [] };
  const long = { ...short, summary: "Operations leader with experience planning and reporting. ".repeat(29), sections: ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((entryId) => ({ entryId, bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) })) };
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValueOnce(long).mockResolvedValueOnce(short);
  const { task, deps, draft } = await setup();
  // The snapshot's theme holds the page limit the writer and fitter are held to.
  await client.db.update(schema.cvDrafts).set({ librarySnapshot: { ...library, theme: { ...DEFAULT_CV_THEME, maxPages: 2 }, entries: ["one", "two", "three", "four", "five", "six", "seven", "eight"].map((id) => ({ ...library.entries[0]!, id, heading: `Director ${id}`,
        })),
      },
    })
    .where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build).toHaveBeenCalledTimes(2);
  expect(build.mock.calls[0]![0].maxPages).toBe(2);
  expect(build.mock.calls[1]![0].layoutFeedback?.pageCount).toBeGreaterThan(2);
  expect(build.mock.calls[1]![0].layoutFeedback?.maxPages).toBe(2);
  const [saved] = await client.db
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.content!.summary).toBe(short.summary);
});
it("fails after three oversized attempts instead of returning an over-limit CV", async () => {
  const build = vi
    .spyOn(AiEngine.prototype, "buildCv")
    .mockResolvedValue({
      summary:
        "Operations leader with experience planning and reporting. ".repeat(29),
      sections: [
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
      ].map((entryId) => ({
        entryId,
        bullets: Array.from({ length: 6 }, () =>
          "Managed operational planning and reporting. ".repeat(14),
        ),
      })),
      gaps: [],
    });
  const { task, deps, draft } = await setup();
  await client.db
    .update(schema.cvDrafts)
    .set({
      librarySnapshot: {
        ...library,
        theme: { ...DEFAULT_CV_THEME, maxPages: 2 },
        entries: [
          "one",
          "two",
          "three",
          "four",
          "five",
          "six",
          "seven",
          "eight",
        ].map((id) => ({
          ...library.entries[0]!,
          id,
          heading: `Director ${id}`,
        })),
      },
    })
    .where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build).toHaveBeenCalledTimes(3);
  const [saved] = await client.db
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("failed");
  expect(saved!.error).toContain("into 2 pages after three budgeted attempts");
  expect(saved!.content).toBeNull();
});

it("refits the submitted wording and preserves the queued revision number", async () => {
  const sourcePlan = {
    summary: "Current edited profile",
    sections: [{ entryId: "one", bullets: ["Led a team"] }],
    gaps: [],
  };
  const build = vi
    .spyOn(AiEngine.prototype, "buildCv")
    .mockResolvedValue({ ...sourcePlan, summary: "Operations leader" });
  const { task, deps, draft } = await setup();
  task.payload = { draftId: draft.id, sourcePlan };
  await client.db
    .update(schema.cvDrafts)
    .set({ revision: 5 })
    .where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build.mock.calls[0]![0].layoutFeedback?.previousPlan).toEqual(
    sourcePlan,
  );
  expect(build.mock.calls[0]![0].writingBudget?.summaryCharacters).toBe(420);
  const [saved] = await client.db
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.revision).toBe(5);
  expect(saved!.content!.fitNotes).toContain(
    "Profile rewritten within the 3-page content budget.",
  );
});

it("fits a long CV within the default three-page limit without a second model call", async () => {
  const entries = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
  const long = { summary: "Operations leader with experience planning and reporting. ".repeat(7), sections: entries.map((entryId) => ({ entryId, bullets: Array.from({ length: 6 }, () => "Managed operational planning and reporting. ".repeat(14)) })), gaps: [] };
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue(long);
  const { task, deps, draft } = await setup();
  await client.db.update(schema.cvDrafts).set({ librarySnapshot: { ...library, entries: entries.map((id) => ({ ...library.entries[0]!, id, heading: `Director ${id}` })) } })
    .where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build).toHaveBeenCalledTimes(1);
  expect(build.mock.calls[0]![0].maxPages).toBe(3);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.assessment!.pageCount).toBe(3);
  expect(saved!.content!.theme).toMatchObject({ font: "Christopher", maxPages: 3 });
  expect(saved!.content!.sections).toHaveLength(8);
});

it("retains authored content when assessment fails, then retries assessment without rewriting", async () => {
  const plan = {
    summary: "Operations leader",
    sections: [{ entryId: "one", bullets: ["Led a team"] }],
    gaps: [],
  };
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue(plan);
  vi.mocked(AiEngine.prototype.assessCv).mockResolvedValueOnce(null);
  const { task, deps, draft } = await setup();
  await handleGenerateCv(task, deps);
  const [failed] = await client.db
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft.id));
  expect(failed!.status).toBe("failed");
  expect(failed!.content!.summary).toBe(plan.summary);
  expect(failed!.error).toContain("assessing");
  expect(failed!.finalisedAt).toBeNull();
  task.payload = { draftId: draft.id, mode: "assess" };
  await handleGenerateCv(task, deps);
  expect(build).toHaveBeenCalledTimes(1);
  const [ready] = await client.db
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft.id));
  expect(ready!.status).toBe("ready");
  expect(ready!.assessment!.score).toBe(100);
});
it("does not author a CV against a hallucinated requirement", async () => {
  vi.mocked(AiEngine.prototype.analyseCvJob).mockResolvedValue(
    rubricFixture("Invented requirement"),
  );
  const build = vi.spyOn(AiEngine.prototype, "buildCv");
  const { task, deps, draft } = await setup();
  await handleGenerateCv(task, deps);
  expect(build).not.toHaveBeenCalled();
  const [saved] = await client.db
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.error).toContain("not quoted");
  expect(saved!.assessment).toBeNull();
});

it("automatically fits an oversized saved draft before assessment, retaining its edited appearance and reporting stages", async () => {
  const { materialiseCv, DEFAULT_CV_THEME } = await import("@christopher/core/cv");
  const { renderCvPdfWithReport } = await import("@christopher/core/cv-pdf");
  const { task, deps, draft } = await setup();
  const entries = Array.from({ length: 8 }, (_, i) => ({ ...library.entries[0]!, id: `role-${i}`, heading: `Director ${i}` }));
  const snapshot = { ...library, entries };
  const long = { summary: "Operations leader", sections: entries.map(entry => ({ entryId: entry.id, bullets: Array(6).fill("Managed operational planning and reporting. ".repeat(14)) })), gaps: [] };
  const content = materialiseCv(snapshot, long);
  content.theme = { ...DEFAULT_CV_THEME, primary: "#285447" };
  expect((await renderCvPdfWithReport(content)).pageCount).toBeGreaterThan(2);
  await client.db.update(schema.cvDrafts).set({ librarySnapshot: snapshot, content }).where(eq(schema.cvDrafts.id, draft.id));
  task.payload = { draftId: draft.id, mode: "assess" };
  const read = async () => (await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id)))[0]!;
  vi.mocked(AiEngine.prototype.analyseCvJob).mockImplementation(async description => {
    expect((await read()).buildStage).toBe("analysing");
    return rubricFixture(description);
  });
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockImplementation(async input => {
    expect((await read()).buildStage).toBe("writing");
    expect(input.library.theme).toEqual(content.theme);
    expect(input.layoutFeedback?.previousPlan.summary).toBe(long.summary);
    return { ...long, sections: entries.map(entry => ({ entryId: entry.id, bullets: ["Led a team"] })) };
  });
  vi.mocked(AiEngine.prototype.assessCv).mockImplementation(async input => {
    const saved = await read();
    expect(saved.buildStage).toBe("assessing");
    expect((await renderCvPdfWithReport(saved.content!)).pageCount).toBeLessThanOrEqual(2);
    expect(input.cv.some(item => item.text.includes("Managed operational"))).toBe(false);
    return reviewFixture(input);
  });
  await handleGenerateCv(task, deps);
  const saved = await read();
  expect(saved.status).toBe("ready");
  expect(saved.buildStage).toBeNull();
  expect(saved.assessment!.pageCount).toBeLessThanOrEqual(2);
  expect(saved.content!.theme).toEqual(content.theme);
  expect(build).toHaveBeenCalledOnce();
});

it("publishes through rolling retention only after fitting and assessment succeed", async () => {
  vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  const [archive, previous] = await client.db.insert(schema.cvDrafts).values([
    { ...draft, id: undefined, status: "ready", archivedAt: new Date(2026, 0, 1), createdAt: new Date(2026, 0, 1) },
    { ...draft, id: undefined, status: "ready", createdAt: new Date(2026, 0, 2) },
  ]).returning();
  await handleGenerateCv(task, deps);
  const rows = await client.db.select().from(schema.cvDrafts);
  expect(rows.find(row => row.id === archive!.id)).toBeUndefined();
  expect(rows.find(row => row.id === previous!.id)!.archivedAt).not.toBeNull();
  expect(rows.find(row => row.id === draft.id)).toMatchObject({ status: "ready", archivedAt: null });
  expect(rows.find(row => row.id === draft.id)!.assessment).not.toBeNull();
});

it("keeps the original scoring criteria when retention has deleted the parent", async () => {
  vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps } = await setup();
  const rubric = rubricFixture("Lead a team");
  task.payload = { ...task.payload, rubric, mode: "improve", improvements: ["Clarify team leadership"] };
  await handleGenerateCv(task, deps);
  expect(AiEngine.prototype.analyseCvJob).not.toHaveBeenCalled();
  expect(AiEngine.prototype.buildCv).toHaveBeenCalledWith(expect.objectContaining({ rubric, improvements: ["Clarify team leadership"] }), expect.anything());
});

it("stops before writing or assessment when the CV is deleted during analysis", async () => {
  const { task, deps, draft } = await setup();
  vi.spyOn(AiEngine.prototype, "analyseCvJob").mockImplementation(async description => {
    await client.db.delete(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
    return rubricFixture(description);
  });
  const build = vi.spyOn(AiEngine.prototype, "buildCv");
  const result = await handleGenerateCv(task, deps);
  expect(result).toMatchObject({ skipped: true, reason: "deleted" });
  expect(build).not.toHaveBeenCalled();
  expect(AiEngine.prototype.assessCv).not.toHaveBeenCalled();
  expect(await client.db.select().from(schema.cvDrafts)).toHaveLength(0);
});

it("rejects malformed task inputs before database writes or model calls", async () => {
  const { task, deps, draft } = await setup();
  const build = vi.spyOn(AiEngine.prototype, "buildCv");
  for (const payload of [{ draftId: "bad-id" }, { draftId: draft.id, mode: "delete" }, { draftId: draft.id, sourcePlan: { unknown: true } }, { draftId: draft.id, improvements: [42] }]) {
    await expect(handleGenerateCv({ ...task, payload }, deps)).rejects.toThrow(/Invalid CV/);
  }
  expect(build).not.toHaveBeenCalled();
  expect(AiEngine.prototype.analyseCvJob).not.toHaveBeenCalled();
  expect((await client.db.select().from(schema.cvDrafts))[0]!.status).toBe("queued");
});
