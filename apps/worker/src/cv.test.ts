import {
  rubricFixture,
  reviewFixture,
} from "../../../packages/core/test/cv-review-fixture";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { confirmCvTargetingPrioritiesForUser, createDb, listCvBuildSteps, schema, startCvBuildStep, type Task } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { AiEngine, promptSetVersion } from "@col/ai";
import { DEFAULT_CV_THEME } from "@col/core/cv";
import { CvTargetingBriefSchema } from "@col/core/cv-targeting";
import { CV_FIT_VERSION, CV_RENDER_VERSION, CvRefinementSchema, cvEditingTargetsFor,
  cvRefinementDependencies } from "@col/core/cv-editing-modes";
import { CV_REVIEW_VERSION } from "@col/core/cv-assessment";
import { cvTargetingRubricKey, cvTargetingSource } from "@col/core/cv-targeting-identity";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "./test-users";
import { handleGenerateCv } from "./handlers/cv";
import { cvAuditBatches } from "./handlers/cv-stages";
import type { WorkerDeps } from "./context";
const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test");
const library = { name: "Test Candidate", contact: "London", profile: "Operations", entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
let userId: string;
beforeAll(async () => { await runMigrations(client.db); userId = (await ensureTestUser(client.db, "cv@example.com")).id; });
beforeEach(async () => { vi.restoreAllMocks();
  vi.spyOn(AiEngine.prototype, "analyseCvJob").mockImplementation(
    async (description) => rubricFixture(description),
  );
  vi.spyOn(AiEngine.prototype, "assessCv").mockImplementation(async (input) =>
    reviewFixture(input),
  );
  // The build audits batch by batch: each batch is sliced as the engine slices it and answered by
  // the (mocked) whole-audit method over that batch alone.
  vi.spyOn(AiEngine.prototype, "assessCvBatches").mockImplementation(async function (this: AiEngine, input, ref, options) {
    const slices = cvAuditBatches(input);
    const batches = [];
    for (const index of options?.only ?? slices.map((_, i) => i)) {
      const slice = slices[index]!;
      const result = await this.assessCv({ ...input, rubric: { ...input.rubric, requirements: slice.requirements }, claims: slice.claims }, ref, options);
      batches.push(result ? { index, status: "done" as const, result, usage: [] } : { index, status: "failed" as const, usage: [] });
    }
    return { pass: options?.pass ?? "draft", total: slices.length, batches, review: null };
  }); await client.db.execute(sql`truncate applications, cv_build_steps, cv_share_comments, cv_shares, cv_skill_suggestion_runs, cv_drafts, ai_calls, ai_reservations`);
  await client.db.update(schema.users).set({ role: "admin", emailVerifiedAt: new Date() }).where(eq(schema.users.id, userId));
});
afterAll(async () => { vi.restoreAllMocks(); await client.pool.end(); });
async function setup(apiKey: string | undefined = "fixture-key") {
  const [draft] = await client.db.insert(schema.cvDrafts).values({ userId, jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5" }).returning();
  const deps = { db: client.db, env: { anthropicApiKey: apiKey },
    userSettings: async () => ({ aiBudgetUsd: 1000, aiBudgetResetAt: null }), now: () => new Date() } as unknown as WorkerDeps;
  return { draft: draft!, deps, task: { type: "generate_cv", payload: { draftId: draft!.id } } as unknown as Task };
}
it("stops a legacy queued CV build for an unconfirmed member before any model call or hold", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv");
  const { task, deps, draft } = await setup();
  await startCvBuildStep(client.db, { draftId: draft.id, userId, attempt: 1, motion: "admit_budget" });
  await client.db.update(schema.users).set({ role: "member", emailVerifiedAt: null }).where(eq(schema.users.id, userId));
  expect(await handleGenerateCv(task, deps)).toMatchObject({ skipped: true, reason: "email confirmation required" });
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved).toMatchObject({ status: "failed", error: "Confirm your email address, then retry this CV build." });
  expect((await listCvBuildSteps(client.db, userId, draft.id)).map(step => step.status)).toEqual(["failed"]);
  expect(build).not.toHaveBeenCalled();
  expect(await client.db.select().from(schema.aiReservations).where(eq(schema.aiReservations.userId, userId))).toHaveLength(0);
});
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
it("pauses after one full-evidence plan and resumes the same credited build after priority confirmation", async () => {
  const { draft, deps, task } = await setup();
  const targetLibrary = { ...library, entries: [...library.entries,
    { id: "two", kind: "experience" as const, heading: "Oil and gas role", details: "Ran offshore reporting",
      confirmedResponsibilities: ["Ran offshore reporting"] }] };
  const source = cvTargetingSource(1, targetLibrary, "Lead a team");
  const initial = CvTargetingBriefSchema.parse({ version: 1, source, entries: [],
    presentation: { maxPages: 2, bodySizePt: 12 },
    priority: { state: "unprepared", emphasisRequirementIds: [], acknowledgedEssentialOmissionIds: [] } });
  await client.db.update(schema.cvDrafts).set({ targetingBrief: initial,
    librarySnapshot: { ...targetLibrary, theme: { ...DEFAULT_CV_THEME, maxPages: 2, bodySizePt: 12 } },
    buildCheckpoint: { tailoringEnabled: true } }).where(eq(schema.cvDrafts.id, draft.id));
  const plan = { requirements: [{ requirementId: "r1", status: "demonstrated" as const,
    evidence: [{ sourceId: "entry:one:row:0", quote: "Led a team" }], reason: "Direct evidence" }], gapQuestions: [] };
  const planning = vi.spyOn(AiEngine.prototype, "planCvTailoring").mockResolvedValue(plan);
  const author = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Led a team",
    summarySources: ["entry:one:row:0"],
    sections: [{ entryId: "one", bullets: ["Led a team"], bulletSources: [["entry:one:row:0"]] }], gaps: [] });
  expect(await handleGenerateCv(task, deps)).toMatchObject({ awaitingPriorities: true });
  const [paused] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(paused?.status).toBe("awaiting_priorities");
  expect(paused?.buildCheckpoint?.tailoringPlan).toBeTruthy();
  expect(author).not.toHaveBeenCalled();
  const pending = CvTargetingBriefSchema.parse(paused!.targetingBrief);
  const rubric = pending.priority.rubric!;
  const confirmed = CvTargetingBriefSchema.parse({ ...pending, entries: [{ entryId: "two", treatment: "omit" }], priority: { ...pending.priority,
    state: "confirmed", rubricKey: cvTargetingRubricKey(source, rubric, draft.model, promptSetVersion()),
    emphasisRequirementIds: rubric.requirements.map(row => row.id), acknowledgedEssentialOmissionIds: [] } });
  await client.db.update(schema.cvDrafts).set({ status: "queued", targetingBrief: confirmed }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  const [ready] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(ready?.status, ready?.error ?? "").toBe("ready");
  expect(ready?.content?.theme?.maxPages).toBe(2);
  expect(planning).toHaveBeenCalledOnce();
  expect(author).toHaveBeenCalledOnce();
  const auditEvidence = vi.mocked(AiEngine.prototype.assessCvBatches).mock.calls.flatMap(call => call[0].evidence.map(item => item.id));
  expect(auditEvidence).toContain("entry:one");
  expect(auditEvidence).not.toContain("entry:two");
  expect(auditEvidence).not.toContain("source:profile");
});
it("maps carried user wording before the pause and resumes without a second plan or rubric call", async () => {
  const { draft, deps, task } = await setup();
  const source = cvTargetingSource(1, library, "Lead a team");
  const rows = [{ id: "r1", text: "Team leadership", essential: true }];
  const initial = CvTargetingBriefSchema.parse({ version: 1, source, entries: [],
    presentation: { maxPages: 2, bodySizePt: 12 },
    priority: { state: "unprepared", emphasisRequirementIds: [], requirements: rows,
      acknowledgedEssentialOmissionIds: [] } });
  await client.db.update(schema.cvDrafts).set({ targetingBrief: initial,
    buildCheckpoint: { tailoringEnabled: true } }).where(eq(schema.cvDrafts.id, draft.id));
  const plan = { requirements: [{ requirementId: "r1", status: "demonstrated" as const,
    evidence: [{ sourceId: "entry:one:row:0", quote: "Led a team" }], reason: "Direct evidence" }], gapQuestions: [] };
  const planning = vi.spyOn(AiEngine.prototype, "planCvTailoring").mockResolvedValue(plan);
  const analysing = vi.mocked(AiEngine.prototype.analyseCvJob);
  const author = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Led a team",
    summarySources: ["entry:one:row:0"],
    sections: [{ entryId: "one", bullets: ["Led a team"], bulletSources: [["entry:one:row:0"]] }], gaps: [] });
  expect(await handleGenerateCv(task, deps)).toMatchObject({ awaitingPriorities: true });
  expect(planning).toHaveBeenCalledOnce();
  expect(planning.mock.calls[0]![0].rubric.requirements[0]).toMatchObject({
    id: "r1", label: "Team leadership", quote: "Lead a team", rank: 1, origin: "role", customised: true,
  });
  const [paused] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  const pending = CvTargetingBriefSchema.parse(paused!.targetingBrief);
  expect(pending.priority.requirements).toEqual(rows);
  expect(pending.priority.mappedRequirements).toEqual(rows);
  const confirmed = CvTargetingBriefSchema.parse({ ...pending, priority: { ...pending.priority,
    state: "confirmed", emphasisRequirementIds: ["r1"], acknowledgedEssentialOmissionIds: [] } });
  await client.db.update(schema.cvDrafts).set({ status: "queued", targetingBrief: confirmed }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  const [ready] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(ready?.status, ready?.error ?? "").toBe("ready");
  expect(ready?.assessment?.rubric.requirements[0]).toMatchObject({
    label: "Team leadership", quote: "Lead a team", rank: 1, origin: "role", customised: true,
  });
  expect(planning).toHaveBeenCalledOnce();
  expect(analysing).toHaveBeenCalledOnce();
  expect(author).toHaveBeenCalledOnce();
});
it("remaps edited meaning once, pauses for affected omitted essentials, then resumes without a third plan", async () => {
  const { draft, deps, task } = await setup();
  const sourceLibrary = { ...library, entries: [...library.entries,
    { id: "two", kind: "experience" as const, heading: "Second role", details: "Managed testing",
      confirmedResponsibilities: ["Managed testing"] }] };
  const source = cvTargetingSource(1, sourceLibrary, "Lead a team");
  const initial = CvTargetingBriefSchema.parse({ version: 1, source, entries: [],
    presentation: { maxPages: 2, bodySizePt: 12 },
    priority: { state: "unprepared", emphasisRequirementIds: [], acknowledgedEssentialOmissionIds: [] } });
  await client.db.update(schema.cvDrafts).set({ targetingBrief: initial, librarySnapshot: sourceLibrary,
    buildCheckpoint: { tailoringEnabled: true } }).where(eq(schema.cvDrafts.id, draft.id));
  const plan = { requirements: [{ requirementId: "r1", status: "demonstrated" as const,
    evidence: [{ sourceId: "entry:one:row:0", quote: "Led a team" }], reason: "Direct evidence" }], gapQuestions: [] };
  const planning = vi.spyOn(AiEngine.prototype, "planCvTailoring").mockResolvedValue(plan);
  const author = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Managed testing",
    summarySources: ["entry:two:row:0"], sections: [
      { entryId: "two", bullets: ["Managed testing"], bulletSources: [["entry:two:row:0"]] }], gaps: [] });
  expect(await handleGenerateCv(task, deps)).toMatchObject({ awaitingPriorities: true });
  const [first] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  const firstBrief = CvTargetingBriefSchema.parse(first!.targetingBrief);
  const editedRows = [{ id: "r1", text: "Team leadership", essential: true }];
  const choices = { entries: [{ entryId: "one", treatment: "omit" as const }],
    presentation: { maxPages: 2 as const, bodySizePt: 12 as const },
    emphasisRequirementIds: ["r1"], requirements: editedRows, acknowledgedEssentialOmissionIds: [] as string[] };
  const firstRequest = "11111111-1111-4111-8111-111111111111";
  await confirmCvTargetingPrioritiesForUser(client.db, userId, draft.id, {
    expectedRevision: draft.revision, expectedSource: source,
    expectedRubricKey: firstBrief.priority.rubricKey!, requestKey: firstRequest, choices,
  });
  expect(await handleGenerateCv(task, deps)).toMatchObject({ awaitingPriorities: true });
  const [second] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  const secondBrief = CvTargetingBriefSchema.parse(second!.targetingBrief);
  expect(secondBrief.priority.mappedRequirements).toEqual(editedRows);
  expect(secondBrief.priority.requirements).toEqual(editedRows);
  expect(planning).toHaveBeenCalledTimes(2);
  expect(author).not.toHaveBeenCalled();
  await confirmCvTargetingPrioritiesForUser(client.db, userId, draft.id, {
    expectedRevision: draft.revision, expectedSource: source,
    expectedRubricKey: secondBrief.priority.rubricKey!, requestKey: "22222222-2222-4222-8222-222222222222",
    choices: { ...choices, acknowledgedEssentialOmissionIds: ["r1"] },
  });
  await handleGenerateCv(task, deps);
  const [ready] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(ready?.status, ready?.error ?? "").toBe("ready");
  expect(planning).toHaveBeenCalledTimes(2);
  expect(author).toHaveBeenCalledOnce();
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
  expect(saved!.error).toContain("Confirm at least one responsibility or outcome");
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
  expect(saved!.error).toBe("The CV is 3 pages after three attempts; the limit is 2. Remove some evidence in your Library or raise the page limit in Settings.");
  expect(saved!.failure).toMatchObject({ kind: "page_limit_unfittable", resolvedBy: "user", action: "shorten_or_raise_pages" });
  expect(saved!.content).toBeNull();
});

it("writes a rebuild afresh from the library and preserves the queued revision number", async () => {
  const build = vi
    .spyOn(AiEngine.prototype, "buildCv")
    .mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  task.payload = { draftId: draft.id, mode: "improve", improvements: ["Name the team size", ""] };
  await client.db
    .update(schema.cvDrafts)
    .set({ revision: 5 })
    .where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(build.mock.calls[0]![0].layoutFeedback).toBeUndefined();
  expect(build.mock.calls[0]![0].improvements).toEqual(["Name the team size"]);
  expect(build.mock.calls[0]![0].writingBudget?.summaryCharacters).toBeGreaterThan(250);
  expect(build.mock.calls[0]![0].writingBudget?.summaryCharacters).toBeLessThan(420);
  const [saved] = await client.db
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.revision).toBe(5);
});

it("keeps selected skill section and label order through a Rewrite without restoring missing labels", async () => {
  const { task, deps, draft } = await setup();
  const source = { ...library, entries: [...library.entries,
    { id: "tools", kind: "skill" as const, heading: "Tools", details: "Confirmed tools", skillItems: ["Python", "SQL", "R"] },
    { id: "methods", kind: "skill" as const, heading: "Methods", details: "Confirmed methods", skillItems: ["Planning"] }] };
  const hint = [{ entryId: "methods", items: ["Planning"] }, { entryId: "tools", items: ["SQL", "Python"] }];
  await client.db.update(schema.cvDrafts).set({ jobDescription: "Lead a team with SQL, Python and Planning",
    librarySnapshot: source, buildCheckpoint: { mode: "improve", skillOrder: hint } }).where(eq(schema.cvDrafts.id, draft.id));
  task.payload = { draftId: draft.id, mode: "improve" };
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", gaps: [], sections: [
    { entryId: "one", bullets: ["Led a team"] },
    { entryId: "tools", bullets: ["Python", "SQL"], skillItems: ["Python", "SQL", "R"] },
    { entryId: "methods", bullets: ["Planning"], skillItems: ["Planning"] },
  ] });
  await handleGenerateCv(task, deps);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved?.status, saved?.error ?? "").toBe("ready");
  expect(build.mock.calls[0]?.[0].library.entries.map(entry => entry.id)).toEqual(["one", "methods", "tools"]);
  expect(saved?.content?.sections.filter(section => section.kind === "skill").map(section => section.entryId))
    .toEqual(["methods", "tools"]);
  expect(saved?.content?.sections.find(section => section.entryId === "tools")?.skillItems)
    .toEqual(["SQL", "Python"]);
});

it("keeps a revision's own rubric when its parent never reached assessment", async () => {
  vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  const [parent] = await client.db.insert(schema.cvDrafts).values({ userId, jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5", status: "failed" }).returning();
  const rubric = { ...rubricFixture("Lead a team"), caveats: ["Kept from the earlier assessment"] };
  await client.db.update(schema.cvDrafts).set({ parentId: parent!.id, assessment: { rubric } as never }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  expect(AiEngine.prototype.analyseCvJob).not.toHaveBeenCalled();
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.assessment!.rubric.caveats).toEqual(["Kept from the earlier assessment"]);
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
  expect(saved!.content!.theme).toMatchObject({ font: "Course of Life", maxPages: 3 });
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
  expect(failed!.error).toBe("The model's answer to the assessment step could not be used (batch 1 of 1).");
  expect(failed!.failure).toMatchObject({ kind: "output_invalid", motion: "assess_batch", batch: 1 });
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
it("checks a materialised Auto edition without authoring or republishing its immutable baseline", async () => {
  const author = vi.spyOn(AiEngine.prototype, "buildCv");
  const { task, deps, draft } = await setup();
  const [context] = await client.db.insert(schema.cvApplicationContexts).values({ userId,
    requestKey: `paste:${crypto.randomUUID()}`, companyName: "Acme", jobTitle: draft.jobTitle }).returning();
  const [description] = await client.db.insert(schema.cvContextDescriptions).values({ userId,
    contextId: context!.id, version: 1, text: draft.jobDescription }).returning();
  await client.db.update(schema.cvApplicationContexts).set({ currentDescriptionVersionId: description!.id })
    .where(eq(schema.cvApplicationContexts.id, context!.id));
  const content = { name: "Test Candidate", contact: "London", summary: "Operations",
    sections: [{ entryId: "one", kind: "experience" as const, heading: "Director · Acme",
      bullets: ["Led a team"], bulletSources: [["entry:one:row:0"]] }], gaps: [] };
  const targets = cvEditingTargetsFor(content, () => crypto.randomUUID());
  const [baseline] = await client.db.insert(schema.cvAutoBaselines).values({ userId,
    contextId: context!.id, descriptionVersionId: description!.id, inputKey: "a".repeat(64),
    inputSnapshot: { version: 1, contextId: context!.id, descriptionVersionId: description!.id,
      jobTitle: draft.jobTitle, companyName: draft.companyName, description: draft.jobDescription,
      library, basePriorityIdentity: "source-default", appearance: undefined, writingPreferences: {},
      routes: {}, contracts: { promptSet: promptSetVersion(), review: "test", fit: "test", render: "test" } },
    status: "ready", sourceDraftId: draft.id, content, librarySnapshot: library,
    editingTargets: targets, publishedAt: new Date(),
    engineContract: { promptSet: promptSetVersion(), review: "test", fit: "test", render: "test", routes: {} },
  }).returning();
  await client.db.update(schema.cvDrafts).set({ contextId: context!.id,
    descriptionVersionId: description!.id, editingMode: "auto", autoBaselineId: baseline!.id,
    status: "queued", content, editingTargets: targets }).where(eq(schema.cvDrafts.id, draft.id));
  task.payload = { draftId: draft.id, mode: "assess" };
  await handleGenerateCv(task, deps);
  const [ready] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  const [retained] = await client.db.select().from(schema.cvAutoBaselines).where(eq(schema.cvAutoBaselines.id, baseline!.id));
  expect(ready?.status, ready?.error ?? "").toBe("ready");
  expect(ready?.content).toEqual(content);
  expect(ready?.assessment).toBeTruthy();
  expect(author).not.toHaveBeenCalled();
  expect(retained?.content).toEqual(content);
  expect(retained?.assessment).toBeNull();
  expect(retained?.publishedAt).toEqual(baseline!.publishedAt);
});
it("checks saved Manual wording with no confirmed Experience as unverified, without authoring", async () => {
  const author = vi.spyOn(AiEngine.prototype, "buildCv");
  const { task, deps, draft } = await setup();
  const content = { name: "Test Candidate", contact: "London", summary: "Operations leader",
    sections: [{ entryId: `manual:${crypto.randomUUID()}`, kind: "experience" as const,
      heading: "Director", bullets: ["Led a team"] }], gaps: [] };
  await client.db.update(schema.cvDrafts).set({ editingMode: "manual", status: "queued",
    content, librarySnapshot: { name: "Test Candidate", contact: "London", profile: "", entries: [] },
    buildCheckpoint: { tailoringEnabled: false, quizCompleted: true } }).where(eq(schema.cvDrafts.id, draft.id));
  vi.mocked(AiEngine.prototype.assessCvBatches).mockImplementation(async input => {
    const result = { matches: input.rubric.requirements.map(requirement => ({ requirementId: requirement.id,
      status: "missing" as const, libraryStatus: "missing" as const, cvEvidence: [], libraryEvidence: [],
      reason: "No confirmed Experience", improvement: "Confirm supporting facts" })),
    claims: input.claims.map(claim => ({ claimId: claim.id, status: "unsupported" as const,
      evidence: [], reason: "No confirmed Experience" })) };
    return { pass: "draft", total: 1, batches: [{ index: 0, status: "done", result, usage: [] }], review: null };
  });
  task.payload = { draftId: draft.id, mode: "assess" };
  await handleGenerateCv(task, deps);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved?.status, saved?.error ?? "").toBe("ready");
  expect(saved?.content).toEqual(content);
  expect(saved?.assessment?.review.matches.every(match => match.libraryStatus === "missing")).toBe(true);
  expect(saved?.assessment?.review.claims.every(claim => claim.status === "unsupported")).toBe(true);
  expect(author).not.toHaveBeenCalled();
});
it("passes distinct stable instruction targets to the writer and applies one exact bullet lock", async () => {
  const author = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations",
    sections: [{ entryId: "one", bullets: ["Managed a team"], bulletSources: [["entry:one:row:0"]] }], gaps: [] });
  const { task, deps, draft } = await setup();
  const source = { name: "Test Candidate", contact: "London", profile: "Operations", summary: "Operations",
    sections: [{ entryId: "one", kind: "experience" as const, heading: "Director · Acme",
      bullets: ["Led a team"], bulletSources: [["entry:one:row:0"]] }], gaps: [] };
  const targets = cvEditingTargetsFor(source, () => crypto.randomUUID());
  const descriptionVersionId = crypto.randomUUID();
  const row = (kind: "exact_wording" | "instruction", type: "bullet" | "section", id: string,
    text: string, order: number) => CvRefinementSchema.parse({ id: crypto.randomUUID(), version: 1,
      order, kind, target: { type, id }, text, reset: false,
      dependencies: { descriptionVersionId, ...cvRefinementDependencies({ content: source, targets,
        library, descriptionVersionId, target: { type, id } }) } });
  const bulletId = targets.sections[0]!.bulletIds[0]!;
  const sectionId = targets.sections[0]!.sectionId;
  const refinements = [row("exact_wording", "bullet", bulletId, "Led a team", 0),
    row("instruction", "bullet", bulletId, "Keep the measurable team contribution concise", 1),
    row("instruction", "section", sectionId, "Emphasise delivery impact", 2)];
  const rubric = rubricFixture(draft.jobDescription);
  const identity = cvTargetingSource(draft.libraryVersion, library, draft.jobDescription);
  const choices = { entries: [], presentation: { maxPages: 2 as const, bodySizePt: 12 as const },
    emphasisRequirementIds: ["r1"], requirements: [{ id: "r1", text: "Lead measurable teams", essential: true }],
    acknowledgedEssentialOmissionIds: [] };
  refinements.push(CvRefinementSchema.parse({ id: crypto.randomUUID(), version: 1, order: 3,
    kind: "structured", target: { type: "selection" }, structured: { kind: "targeting", choices }, reset: false,
    dependencies: { descriptionVersionId, ...cvRefinementDependencies({ content: source, targets,
      library, descriptionVersionId, target: { type: "selection" }, structured: { kind: "targeting", choices } }) } }));
  const brief = CvTargetingBriefSchema.parse({ version: 1, source: identity,
    entries: [], presentation: choices.presentation, manualSections: source.sections,
    priority: { state: "confirmed", rubric,
      rubricKey: cvTargetingRubricKey(identity, rubric, draft.model, promptSetVersion()),
      emphasisRequirementIds: choices.emphasisRequirementIds, requirements: choices.requirements,
      acknowledgedEssentialOmissionIds: [] } });
  await client.db.update(schema.cvDrafts).set({ editingMode: "refine", descriptionVersionId,
    refinementSnapshot: refinements, refinementSourceContent: source, refinementSourceTargets: targets,
    refinementEngineContract: { promptSet: promptSetVersion(), review: CV_REVIEW_VERSION,
      fit: CV_FIT_VERSION, render: CV_RENDER_VERSION, routes: {} },
    targetingBrief: brief, buildCheckpoint: { tailoringEnabled: false, quizCompleted: true,
      sourceRubric: rubric } }).where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  const [ready] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(ready?.status, ready?.error ?? "").toBe("ready");
  expect(ready?.content?.sections[0]?.bullets).toEqual(["Led a team"]);
  expect(author).toHaveBeenCalledWith(expect.objectContaining({ refinementInstructions: [
    expect.objectContaining({ target: `bullet:${bulletId}` }),
    expect.objectContaining({ target: `section:${sectionId}` }),
  ] }), expect.anything());
  expect(author.mock.calls[0]![0].rubric?.requirements[0]).toMatchObject({ label: "Lead measurable teams",
    importance: "essential", customised: true });
  expect(vi.mocked(AiEngine.prototype.assessCvBatches).mock.calls[0]?.[0].rubric.requirements[0])
    .toMatchObject({ label: "Lead measurable teams", customised: true });
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

it("assesses oversized saved wording without authoring or shortening it", async () => {
  const { materialiseCv, DEFAULT_CV_THEME } = await import("@col/core/cv");
  const { renderCvPdfWithReport } = await import("@col/core/cv-pdf");
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
  const build = vi.spyOn(AiEngine.prototype, "buildCv");
  await handleGenerateCv(task, deps);
  const saved = await read();
  expect(saved.status, saved.error ?? "").toBe("ready");
  expect(saved.buildStage).toBeNull();
  expect(saved.failure).toBeNull();
  expect(saved.assessment?.pageCount).toBeGreaterThan(2);
  expect(saved.content).toEqual(content);
  expect(saved.content!.theme).toEqual(content.theme);
  expect(build).not.toHaveBeenCalled();
  expect(AiEngine.prototype.assessCvBatches).toHaveBeenCalled();
});

it.each(["legacy", "manual"] as const)("remeasures a %s appearance-only saved revision and reuses its exact factual audit", async mode => {
  const author = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader",
    sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  await handleGenerateCv(task, deps);
  const [first] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(first?.semanticAuditCache?.identity).toMatch(/^[a-f0-9]{64}$/);
  const revised = { ...first!.content!, theme: { ...DEFAULT_CV_THEME, primary: "#285447" } };
  await client.db.update(schema.cvDrafts).set({ status: "queued", content: revised, assessment: null,
    editingMode: mode === "manual" ? "manual" : null,
    buildCheckpoint: { sourceRubric: first!.assessment!.rubric }, semanticAuditCache: first!.semanticAuditCache })
    .where(eq(schema.cvDrafts.id, draft.id));
  vi.mocked(AiEngine.prototype.assessCvBatches).mockClear();
  vi.mocked(AiEngine.prototype.assessCv).mockClear();
  task.payload = { draftId: draft.id, mode: "assess" };
  await handleGenerateCv(task, deps);
  const [second] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(second?.status).toBe("ready");
  expect(second?.assessment?.pageCount).toBeGreaterThan(0);
  expect(second?.assessment?.inputHash).not.toBe(first!.assessment!.inputHash);
  expect(AiEngine.prototype.assessCvBatches).not.toHaveBeenCalled();
  expect(AiEngine.prototype.assessCv).not.toHaveBeenCalled();
  expect(author).toHaveBeenCalledTimes(1);
  expect(second?.semanticAuditCache).toEqual(first!.semanticAuditCache);
  await client.db.update(schema.cvDrafts).set({ status: "queued",
    content: { ...revised, summary: "Newly asserted leadership result" }, assessment: null,
    buildCheckpoint: { sourceRubric: second!.assessment!.rubric } }).where(eq(schema.cvDrafts.id, draft.id));
  vi.mocked(AiEngine.prototype.assessCvBatches).mockClear();
  await handleGenerateCv(task, deps);
  expect(AiEngine.prototype.assessCvBatches).toHaveBeenCalled();
});

it("reassesses identical saved wording when the effective priority meaning changes", async () => {
  const author = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader",
    sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  await handleGenerateCv(task, deps);
  const [first] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(first?.semanticAuditCache?.identity).toMatch(/^[a-f0-9]{64}$/);
  const sourceRubric = first!.assessment!.rubric;
  const source = cvTargetingSource(1, library, draft.jobDescription);
  const requirements = [{ id: "r1", text: sourceRubric.requirements[0]!.label, essential: true }];
  const brief = CvTargetingBriefSchema.parse({ version: 1, source, entries: [],
    presentation: { maxPages: 2, bodySizePt: 12 }, priority: { state: "confirmed", rubric: sourceRubric,
      rubricKey: cvTargetingRubricKey(source, sourceRubric, draft.model, promptSetVersion()),
      requirements, mappedRequirements: requirements, emphasisRequirementIds: ["r1"],
      acknowledgedEssentialOmissionIds: [] } });
  const targetedContent = { ...first!.content!, theme: { ...DEFAULT_CV_THEME, maxPages: 2 as const, bodySizePt: 12 as const } };
  task.payload = { draftId: draft.id, mode: "assess" };
  const check = async (targetingBrief: typeof brief, cache: NonNullable<typeof first>["semanticAuditCache"]) => {
    await client.db.update(schema.cvDrafts).set({ status: "queued", assessment: null,
      targetingBrief, content: targetedContent, buildCheckpoint: { sourceRubric }, semanticAuditCache: cache })
      .where(eq(schema.cvDrafts.id, draft.id));
    vi.mocked(AiEngine.prototype.assessCvBatches).mockClear();
    await handleGenerateCv(task, deps);
    return (await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id)))[0]!;
  };
  const targeted = await check(brief, first!.semanticAuditCache);
  expect(targeted.status, targeted.error ?? "").toBe("ready");
  expect(targeted.semanticAuditCache?.identity).not.toBe(first!.semanticAuditCache!.identity);
  const unchanged = await check(brief, targeted.semanticAuditCache);
  expect(unchanged.status, unchanged.error ?? "").toBe("ready");
  expect(unchanged.semanticAuditCache).toEqual(targeted.semanticAuditCache);
  expect(AiEngine.prototype.assessCvBatches).not.toHaveBeenCalled();
  const changed = CvTargetingBriefSchema.parse({ ...brief,
    priority: { ...brief.priority, requirements: [{ ...requirements[0]!, essential: false }] } });
  const checked = await check(changed, unchanged.semanticAuditCache);
  expect(checked.status, checked.error ?? "").toBe("ready");
  expect(checked.content).toEqual(unchanged.content);
  expect(checked.assessment?.rubric.requirements[0]?.importance).toBe("desirable");
  expect(checked.semanticAuditCache?.identity).not.toBe(unchanged.semanticAuditCache!.identity);
  expect(AiEngine.prototype.assessCvBatches).toHaveBeenCalled();
  expect(author).toHaveBeenCalledTimes(1);
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

it("retries a rebuild as it was first asked for when the retry's task names only the draft", async () => {
  vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  // What saveCvDraft keeps on a rebuild, and what "Retry generation" queues: the draft id alone.
  const rubric = rubricFixture("Lead a team");
  await client.db.update(schema.cvDrafts)
    .set({ buildCheckpoint: { mode: "improve", improvements: ["Clarify team leadership"], sourceRubric: rubric } })
    .where(eq(schema.cvDrafts.id, draft.id));
  await handleGenerateCv(task, deps);
  // The parent is long gone; its rubric and the improvements still come with the revision.
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
  for (const payload of [{ draftId: "bad-id" }, { draftId: draft.id, mode: "delete" }, { draftId: draft.id, improvements: [42] }]) {
    await expect(handleGenerateCv({ ...task, payload }, deps)).rejects.toThrow(/Invalid CV/);
  }
  expect(build).not.toHaveBeenCalled();
  expect(AiEngine.prototype.analyseCvJob).not.toHaveBeenCalled();
  expect((await client.db.select().from(schema.cvDrafts))[0]!.status).toBe("queued");
});

const accountBudget = (aiBudgetUsd: number, aiBudgetResetAt: string | null = null) =>
  (async () => ({ aiBudgetUsd, aiBudgetResetAt })) as unknown as WorkerDeps["userSettings"];
const requeue = (id: string) => client.db.update(schema.cvDrafts).set({ status: "queued" }).where(eq(schema.cvDrafts.id, id));
const draftAfter = async (id: string) => (await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, id)))[0]!;

it("refuses a build this account cannot afford before spending anything, then admits one it can", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  // $0.20 of this account's $0.25 is already spent; another account's spend is nothing to do with it.
  const other = await ensureTestUser(client.db, "other-cv@example.com");
  await client.db.insert(schema.aiCalls).values([
    { userId, callSite: "A5", model: "fixture", costUsd: 0.2 },
    { userId: other.id, callSite: "CV", model: "fixture", costUsd: 40 },
  ]);
  deps.userSettings = accountBudget(0.25);
  await handleGenerateCv(task, deps);
  const refused = await draftAfter(draft.id);
  expect(refused.status).toBe("failed");
  expect(refused.error).toContain("your budget of $0.25 has $0.05 left this month");
  expect(refused.failure).toMatchObject({ kind: "budget_exhausted", resolvedBy: "user", action: "raise_budget", budgetLimit: "account", motion: "admit_budget" });
  expect(build).not.toHaveBeenCalled();
  // Nothing was spent and no capacity was left held on the way to the refusal.
  expect(await client.db.select().from(schema.aiCalls)).toHaveLength(2);
  expect((await client.db.execute<{ n: string }>(sql`select count(*)::text as n from ai_reservations`)).rows[0]!.n).toBe("0");

  // Raising the budget admits the same build, and its hold is gone once it has finished.
  deps.userSettings = accountBudget(100);
  await requeue(draft.id);
  await handleGenerateCv(task, deps);
  expect((await draftAfter(draft.id)).status).toBe("ready");
  expect((await client.db.execute<{ n: string }>(sql`select count(*)::text as n from ai_reservations`)).rows[0]!.n).toBe("0");
});

it("admits a second build's stages beside the first while the month can afford them, and refuses the stage it cannot, by name", async () => {
  const { task, deps, draft } = await setup();
  const [second] = await client.db.insert(schema.cvDrafts).values({ userId, jobTitle: "Operations Lead", companyName: "Acme", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: draft.librarySnapshot, model: "claude-sonnet-5" }).returning();
  // The writing stage of this fixture is held at about $0.48 and its rubric at about $0.05: with
  // the first build's writing held, the second can still afford its rubric, but not its writing.
  deps.userSettings = accountBudget(0.9);
  let releaseFirst: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    vi.spyOn(AiEngine.prototype, "buildCv").mockImplementation(async () => {
      resolve();
      await new Promise<void>((done) => { releaseFirst = done; });
      return { summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] };
    });
  });
  const first = handleGenerateCv(task, deps);
  await started;
  // The first build's writing hold is live and belongs to this account, so the second is refused
  // by it rather than by recorded spend: nothing has been billed yet. It is refused at the stage
  // that would not fit — part-way, before that stage spends anything — and says which.
  expect(await client.db.select().from(schema.aiCalls)).toHaveLength(0);
  await handleGenerateCv({ ...task, payload: { draftId: second!.id } } as typeof task, deps);
  const refused = await draftAfter(second!.id);
  expect(refused.status).toBe("failed");
  expect(refused.failure).toMatchObject({ kind: "budget_exhausted", resolvedBy: "user", action: "raise_budget", budgetLimit: "account", motion: "admit_budget" });
  expect(refused.error).toContain("your budget of $0.9 has");
  const admitted = await client.db.execute<{ stage: string; status: string }>(sql`select detail->>'stage' as stage, status from cv_build_steps where draft_id = ${second!.id} and motion = 'admit_budget' order by seq`);
  expect(admitted.rows).toEqual([{ stage: "rubric", status: "done" }, { stage: "write", status: "failed" }]);
  releaseFirst?.();
  await first;
  expect((await draftAfter(draft.id)).status).toBe("ready");
  // The finished build released its hold, so the account's next one is measured against spend alone.
  expect((await client.db.execute<{ n: string }>(sql`select count(*)::text as n from ai_reservations`)).rows[0]!.n).toBe("0");
});

it("keeps operator budget details out of the customer-facing error when the deployment cap refuses a build", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  // The account has plenty; the operator's optional daily cap for the whole deployment does not.
  deps.userSettings = accountBudget(100);
  deps.env.dailyAiBudgetUsd = 0.01;
  await handleGenerateCv(task, deps);
  const refused = await draftAfter(draft.id);
  expect(refused.status).toBe("failed");
  expect(refused.error).toContain("The deployment's daily AI cap has too little left");
  expect(refused.failure).toMatchObject({ kind: "budget_exhausted", resolvedBy: "user", action: "check_deployment_budget", budgetLimit: "day", motion: "admit_budget" });
  expect(build).not.toHaveBeenCalled();
  expect(await client.db.select().from(schema.aiCalls)).toHaveLength(0);
  const denied = await client.db.execute<{ limit: string; spent: string }>(sql`select detail->>'limit' as limit,
    detail->>'spentUsd' as spent from cv_build_steps where draft_id = ${draft.id} and motion = 'admit_budget' and status = 'failed'`);
  expect(denied.rows).toEqual([{ limit: "day", spent: "0" }]);
});

it("stops counting an account's earlier calls once its spend has been reset", async () => {
  vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  deps.now = () => new Date("2026-09-17T12:00:00Z");
  await client.db.insert(schema.aiCalls).values([
    { userId, callSite: "CV", model: "fixture", costUsd: 5, at: new Date("2026-09-17T09:00:00Z") },
    { userId, callSite: "A5", model: "fixture", costUsd: 0.1, at: new Date("2026-09-17T11:00:00Z") },
  ]);
  deps.userSettings = accountBudget(2);
  await handleGenerateCv(task, deps);
  expect((await draftAfter(draft.id)).error).toContain("your budget of $2 has $0.00 left this month");

  // The reset marker moves the window, so only the $0.10 recorded after it still counts.
  await requeue(draft.id);
  deps.userSettings = accountBudget(2, "2026-09-17T10:00:00.000Z");
  await handleGenerateCv(task, deps);
  expect((await draftAfter(draft.id)).status).toBe("ready");
  // The log itself is untouched: a reset moves the window, it never deletes what was spent.
  expect(await client.db.select().from(schema.aiCalls)).toHaveLength(2);
});
