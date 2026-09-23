import {
  rubricFixture,
  reviewFixture,
} from "../../../packages/core/test/cv-review-fixture";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Task } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { AiEngine } from "@ava/ai";
import { DEFAULT_CV_THEME } from "@ava/core/cv";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "./test-users";
import { handleGenerateCv } from "./handlers/cv";
import type { WorkerDeps } from "./context";
const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
const library = { name: "Test Candidate", contact: "London", profile: "Operations", entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }] };
let userId: string;
beforeAll(async () => { await runMigrations(client.db); userId = (await ensureTestUser(client.db, "cv@example.com")).id; });
beforeEach(async () => { vi.restoreAllMocks();
  vi.spyOn(AiEngine.prototype, "analyseCvJob").mockImplementation(
    async (description) => rubricFixture(description),
  );
  vi.spyOn(AiEngine.prototype, "assessCv").mockImplementation(async (input) =>
    reviewFixture(input),
  ); await client.db.execute(sql`truncate applications, cv_build_steps, cv_share_comments, cv_shares, cv_drafts, ai_calls, ai_reservations`); });
afterAll(async () => { vi.restoreAllMocks(); await client.pool.end(); });
async function setup(apiKey: string | undefined = "fixture-key") {
  const [draft] = await client.db.insert(schema.cvDrafts).values({ userId, jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5" }).returning();
  const deps = { db: client.db, env: { anthropicApiKey: apiKey },
    userSettings: async () => ({ aiBudgetUsd: 1000, aiBudgetResetAt: null }), now: () => new Date() } as unknown as WorkerDeps;
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
  expect(build.mock.calls[0]![0].writingBudget?.summaryCharacters).toBe(420);
  const [saved] = await client.db
    .select()
    .from(schema.cvDrafts)
    .where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.revision).toBe(5);
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
  expect(saved!.content!.theme).toMatchObject({ font: "AVA", maxPages: 3 });
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
  expect(failed!.error).toBe("The model's answer to the assessment step could not be used.");
  expect(failed!.failure).toMatchObject({ kind: "output_invalid" });
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
  const { materialiseCv, DEFAULT_CV_THEME } = await import("@ava/core/cv");
  const { renderCvPdfWithReport } = await import("@ava/core/cv-pdf");
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
  expect(refused.error).toContain("Raise it on Settings");
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

it("refuses a second build for the same account while the first is still holding its capacity", async () => {
  const { task, deps, draft } = await setup();
  const [second] = await client.db.insert(schema.cvDrafts).values({ userId, jobTitle: "Operations Lead", companyName: "Acme", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: draft.librarySnapshot, model: "claude-sonnet-5" }).returning();
  // A build of this fixture costs about $0.55: enough budget for one at a time, not for two.
  deps.userSettings = accountBudget(1);
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
  // The first build's hold is live and belongs to this account, so the second is refused by it
  // rather than by recorded spend: nothing has been billed yet.
  expect(await client.db.select().from(schema.aiCalls)).toHaveLength(0);
  await handleGenerateCv({ ...task, payload: { draftId: second!.id } } as typeof task, deps);
  const refused = await draftAfter(second!.id);
  expect(refused.status).toBe("failed");
  expect(refused.error).toContain("held by calls in flight");
  expect(refused.error).toContain("your budget of $1");
  releaseFirst?.();
  await first;
  expect((await draftAfter(draft.id)).status).toBe("ready");
  // The finished build released its hold, so the account's next one is measured against spend alone.
  expect((await client.db.execute<{ n: string }>(sql`select count(*)::text as n from ai_reservations`)).rows[0]!.n).toBe("0");
});

it("names the deployment's own cap when that is what refused a build", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  // The account has plenty; the operator's optional daily cap for the whole deployment does not.
  deps.userSettings = accountBudget(100);
  deps.env.dailyAiBudgetUsd = 0.01;
  await handleGenerateCv(task, deps);
  const refused = await draftAfter(draft.id);
  expect(refused.status).toBe("failed");
  expect(refused.error).toContain("the deployment's daily AI cap of $0.01");
  expect(refused.error).toContain("worker's environment");
  expect(refused.error).not.toContain("your budget");
  expect(build).not.toHaveBeenCalled();
  expect(await client.db.select().from(schema.aiCalls)).toHaveLength(0);
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
