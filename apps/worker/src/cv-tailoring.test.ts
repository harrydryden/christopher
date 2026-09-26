/** Integration coverage for the planned CV path. No live model calls are made. */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { enqueueTask, listCvBuildSteps, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { type AiClientLike, type ParseResponse } from "@ava/ai";
import type { CvAssessment, CvReviewPlan, CvRubric } from "@ava/core/cv-assessment";
import type { CvTailoringPlan } from "@ava/core/cv-tailoring";
import { dedupeKeyFor } from "@ava/core";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleGenerateCv } from "./handlers/cv";
import { estimateCvStage } from "./handlers/cv-stages";
import { TaskQueue } from "./queue";
import { onAbandon } from "./handlers/abandon";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55439/ava_final_worker_review";
const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const rubric: CvRubric = { caveats: [], requirements: [
  { id: "lead", label: "Team leadership", quote: "Lead a team", importance: "essential", category: "experience" },
  { id: "change", label: "Transformation delivery", quote: "Deliver transformation", importance: "desirable", category: "delivery" },
] };
const library = {
  name: "Test Candidate", contact: "London", profile: "Operations leader",
  entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme",
    details: "Led a team\nDelivered transformation", confirmedResponsibilities: ["Led a team", "Delivered transformation"] },
  { id: "degree", kind: "education" as const, heading: "BSc Management", details: "University of Example" }],
};
const noGapPlan: CvTailoringPlan = { requirements: [
  { requirementId: "lead", status: "demonstrated", evidence: [{ sourceId: "entry:one:row:0", quote: "Led a team" }], reason: "Direct evidence" },
  { requirementId: "change", status: "demonstrated", evidence: [{ sourceId: "entry:one:row:1", quote: "Delivered transformation" }], reason: "Direct evidence" },
], gapQuestions: [] };
const gapPlan: CvTailoringPlan = { requirements: [
  noGapPlan.requirements[0]!,
  { requirementId: "change", status: "missing", evidence: [], reason: "Scope is not recorded" },
], gapQuestions: [{ id: "change-scope", requirementId: "change", requirement: "Transformation delivery",
  prompt: "What transformation did you deliver?", suggestedDestination: { kind: "evidence", entryId: "one" } }] };

let deps: WorkerDeps;
let db: Db;
let userId: string;

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv());
  await runMigrations(deps.db);
  db = deps.db;
  deps.env.anthropicApiKey = "fixture-key";
  userId = (await ensureTestUser(db, "cv-tailoring@example.com")).id;
}, 60_000);
afterAll(async () => { await deps?.close(); });
beforeEach(async () => {
  await db.execute(sql`truncate tasks, applications, cv_build_steps, cv_share_comments, cv_shares, cv_drafts, ai_calls, ai_reservations, worker_events`);
  deps.userSettings = (async () => ({ aiBudgetUsd: 1000, aiBudgetResetAt: null })) as unknown as WorkerDeps["userSettings"];
  deps.aiClient = undefined;
});

const answered = (parsed_output: unknown): ParseResponse => ({ parsed_output, usage: USAGE, stop_reason: "end_turn", model: "claude-sonnet-5" });
type ScriptOptions = { plan?: CvTailoringPlan; rejectImprovement?: boolean; failImprovement?: boolean; omitRequiredEntryOnImprovement?: boolean };

function scriptedClient(options: ScriptOptions = {}) {
  const calls: string[] = [];
  const authorInputs: Array<Record<string, unknown>> = [];
  let authors = 0;
  const client: AiClientLike = { messages: { async create(params, _options, call) {
    const content = (params.messages as Array<{ content: unknown }>)[0]!.content;
    if (call?.promptId === "cv.review" || call?.promptId === "cv.review_candidate") {
      calls.push("review");
      const stable = JSON.parse((content as Array<{ text: string }>)[0]!.text) as { evidence: Array<{ id: string; text: string }> };
      const printed = JSON.parse((content as Array<{ text: string }>)[1]!.text) as { cv: Array<{ id: string; text: string }> };
      const batch = JSON.parse((content as Array<{ text: string }>)[2]!.text) as { requirements: CvRubric["requirements"]; claims: Array<{ id: string; text: string }> };
      const improved = printed.cv.some(item => item.text.includes("Delivered transformation"));
      const ownEvidence = (id: string) => id.startsWith("section:")
        ? stable.evidence.find(item => id.includes(item.id.replace("entry:", ""))) ?? stable.evidence.find(item => item.id === "entry:one")
        : stable.evidence.find(item => item.id === "source:profile");
      const review: CvReviewPlan = {
        matches: batch.requirements.map(requirement => {
          const demonstrated = requirement.id === "lead" || improved;
          const claim = printed.cv.find(item => requirement.id === "change" ? item.text.includes("Delivered transformation") : item.id === "profile")!;
          return { requirementId: requirement.id, status: demonstrated ? "demonstrated" : "missing", libraryStatus: "demonstrated",
            cvEvidence: demonstrated ? [{ id: claim.id, quote: claim.text }] : [],
            libraryEvidence: [{ id: "entry:one", quote: "Led a team\nDelivered transformation" }],
            reason: demonstrated ? "Shown" : "Available in the Library", improvement: demonstrated ? "" : "Use the supported transformation evidence." };
        }),
        claims: batch.claims.map(claim => {
          const source = ownEvidence(claim.id)!;
          const reject = options.rejectImprovement && improved && claim.text.includes("Delivered transformation");
          return { claimId: claim.id, status: reject ? "unsupported" : "supported",
            evidence: reject ? [] : [{ id: source.id, quote: source.text }], reason: reject ? "Candidate was not verified" : "Supported" };
        }),
      };
      return answered(review);
    }
    const input = (typeof content === "string" ? JSON.parse(content)
      : Object.assign({}, ...(content as Array<{ text: string }>).map(block => JSON.parse(block.text)))) as Record<string, unknown>;
    if (input.destinations) { calls.push("planner"); return answered(options.plan ?? noGapPlan); }
    if (!input.jobTitle) { calls.push("rubric"); return answered(rubric); }
    const improving = Array.isArray(input.improvements) && input.improvements.length > 0;
    calls.push(improving ? "improvement" : "author");
    authorInputs.push(input);
    authors++;
    if (options.failImprovement && improving) throw new Error("optional writer unavailable");
    const improved = improving;
    return answered({
      summary: "Operations leader", summarySources: [{ sourceId: "source:profile", quote: "Operations leader" }],
      sections: [{ entryId: "one", bullets: improved ? ["Led a team", "Delivered transformation"] : ["Led a team"],
        bulletSources: improved
          ? [[{ sourceId: "entry:one:row:0", quote: "Led a team" }], [{ sourceId: "entry:one:row:1", quote: "Delivered transformation" }]]
          : [[{ sourceId: "entry:one:row:0", quote: "Led a team" }]] },
      ...(!improved || !options.omitRequiredEntryOnImprovement ? [{ entryId: "degree", bullets: ["University of Example"],
        bulletSources: [[{ sourceId: "entry:degree:row:0", quote: "University of Example" }]] }] : [])], gaps: [],
    });
  } } };
  return { client, calls, authorInputs };
}

async function makeDraft(checkpoint: (typeof schema.cvDrafts.$inferInsert)["buildCheckpoint"] = { tailoringEnabled: true }) {
  const [draft] = await db.insert(schema.cvDrafts).values({ userId, jobTitle: "Operations Director", companyName: "Acme",
    jobDescription: "Lead a team. Deliver transformation.", libraryVersion: 1, librarySnapshot: library,
    model: "claude-sonnet-5", buildCheckpoint: checkpoint }).returning();
  const payload = { draftId: draft!.id, userId };
  await enqueueTask(db, "generate_cv", payload, { dedupeKey: dedupeKeyFor("generate_cv", payload) });
  return draft!;
}
const queue = () => new TaskQueue(deps, { generate_cv: handleGenerateCv }, { concurrency: 1, workerId: "cv-tailoring", onAbandon });
const draftAfter = async (id: string) => (await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, id)))[0]!;

it("pauses before authoring and a duplicate delivery spends no more AI", async () => {
  const scripted = scriptedClient({ plan: gapPlan }); deps.aiClient = scripted.client;
  const draft = await makeDraft();
  await queue().drain();
  const paused = await draftAfter(draft.id);
  expect(paused.status).toBe("awaiting_evidence");
  expect(paused.gapQuiz).toMatchObject({ status: "awaiting_answers", questions: [{ id: "change-scope" }] });
  expect(scripted.calls).toEqual(["rubric", "planner"]);
  const [task] = await db.select().from(schema.tasks);
  await handleGenerateCv(task!, deps);
  expect(scripted.calls).toEqual(["rubric", "planner"]);
});

it("a completed quiz reuses its semantic plan, skips another pause and passes provenance to the author", async () => {
  const scripted = scriptedClient(); deps.aiClient = scripted.client;
  const draft = await makeDraft({ tailoringEnabled: true, tailoringPlan: noGapPlan, quizCompleted: true, rubric });
  await queue().drain();
  expect((await draftAfter(draft.id)).status).toBe("ready");
  expect(scripted.calls).not.toContain("planner");
  expect(scripted.calls.filter(call => call === "author")).toHaveLength(1);
  expect(scripted.authorInputs[0]).toMatchObject({ tailoringPlan: noGapPlan });
  expect(JSON.stringify((await draftAfter(draft.id)).content)).toContain("summarySources");
});

it("publishes the baseline first, then adopts one verified improvement as a new revision of the same chain", async () => {
  const scripted = scriptedClient(); deps.aiClient = scripted.client;
  const draft = await makeDraft({ tailoringEnabled: true, tailoringPlan: noGapPlan, quizCompleted: true, rubric });
  await queue().drain();
  // The baseline is the CV that was published first, and it keeps the wording it was published with.
  const baseline = await draftAfter(draft.id);
  expect(baseline.status).toBe("ready");
  expect(baseline.content?.sections[0]?.bullets).toEqual(["Led a team"]);
  // The plan the wording was written against stays beside the assessment, for each revision.
  const plans = await db.select().from(schema.cvTailoringPlans);
  expect(plans.find(row => row.draftId === draft.id)).toMatchObject({ userId, plan: noGapPlan });
  expect(baseline.buildCheckpoint).toBeNull();
  // The stronger candidate is a new revision, saved the way a Rebuild saves one: the role's
  // current CV, with the baseline as its parent and now its archive.
  const [revision] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, draft.id));
  expect(revision).toMatchObject({ status: "ready", revision: 2, archivedAt: null });
  expect(revision!.content?.sections[0]?.bullets).toEqual(["Led a team", "Delivered transformation"]);
  expect(revision!.assessment).not.toBeNull();
  expect(plans.find(row => row.draftId === revision!.id)).toMatchObject({ userId, plan: noGapPlan });
  expect(baseline.archivedAt).not.toBeNull();
  expect(scripted.calls.filter(call => call === "improvement")).toHaveLength(1);
  const steps = await listCvBuildSteps(db, userId, draft.id);
  const motions = steps.map(step => step.motion);
  // The narrative goes on past "ready": the improvement, its admission, its re-check, the choice.
  expect(motions.slice(motions.indexOf("publish"))).toEqual([
    "publish", "admit_budget", "improve_content", "admit_budget", "assess_batch", "assemble", "compare_content", "adopt_revision",
  ]);
  expect(steps.find(step => step.motion === "improve_content")).toMatchObject({ status: "done", detail: { opportunities: 1 } });
  expect(steps.filter(step => step.motion === "admit_budget").map(step => step.detail.stage)).toEqual(["write", "audit", "improve", "reaudit"]);
  expect(steps.filter(step => step.motion === "assess_batch").map(step => step.detail.pass)).toEqual(["draft", "revision"]);
  expect(steps.find(step => step.motion === "compare_content")?.detail).toMatchObject({ accepted: true });
  const adopt = steps.find(step => step.motion === "adopt_revision")!;
  expect(adopt.status).toBe("done");
  expect(adopt.detail).toMatchObject({ draftId: revision!.id, revisionId: revision!.id, revision: 2, version: expect.any(Number) });
  expect(adopt.detail.label).toBe(adopt.detail.name);
  expect(adopt.detail.name).toMatch(/^\d\d-[A-Z][a-z]{2}-V\d+$/);
  // Once published, nothing the build did moved the baseline's last moment of progress.
  const publishedAt = steps.find(step => step.motion === "publish")!.finishedAt!;
  expect(baseline.progressAt!.getTime()).toBeLessThanOrEqual(publishedAt.getTime());
  expect(await db.select().from(schema.aiReservations)).toHaveLength(0);
});

it("rejects an unsupported improvement and keeps the checked baseline", async () => {
  const scripted = scriptedClient({ rejectImprovement: true }); deps.aiClient = scripted.client;
  const draft = await makeDraft({ tailoringEnabled: true, tailoringPlan: noGapPlan, quizCompleted: true, rubric });
  await queue().drain();
  const saved = await draftAfter(draft.id);
  expect(saved.status).toBe("ready");
  expect(saved.content?.sections[0]?.bullets).toEqual(["Led a team"]);
  const steps = await listCvBuildSteps(db, userId, draft.id);
  expect(steps.find(step => step.motion === "compare_content")?.detail).toMatchObject({ accepted: false });
  // Nothing changes: no new revision, and the choice says why the original was kept.
  expect(await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, draft.id))).toHaveLength(0);
  const adopt = steps.find(step => step.motion === "adopt_revision")!;
  expect(adopt.status).toBe("skipped");
  expect(adopt.detail.reason).toMatch(/^the rewrite still contains unsupported or uncertain factual claims$/);
  expect(saved.archivedAt).toBeNull();
});

it("keeps the checked baseline when the optional improvement call fails", async () => {
  const scripted = scriptedClient({ failImprovement: true }); deps.aiClient = scripted.client;
  const draft = await makeDraft({ tailoringEnabled: true, tailoringPlan: noGapPlan, quizCompleted: true, rubric });
  await queue().drain();
  const saved = await draftAfter(draft.id);
  expect(saved.status).toBe("ready");
  expect(saved.content?.sections[0]?.bullets).toEqual(["Led a team"]);
  const steps = await listCvBuildSteps(db, userId, draft.id);
  expect(steps.find(step => step.motion === "compare_content")?.detail).toMatchObject({ accepted: false });
  // A failed optional call is neutral: the step is skipped, not failed, and says the original stands.
  const improve = steps.find(step => step.motion === "improve_content")!;
  expect(improve.status).toBe("skipped");
  expect(improve.detail).toMatchObject({ kept: true, reason: expect.any(String) });
  expect(improve.detail.usd === undefined || typeof improve.detail.usd === "number").toBe(true);
  expect(steps.find(step => step.motion === "adopt_revision")).toMatchObject({ status: "skipped" });
  expect(steps.some(step => step.status === "failed")).toBe(false);
});

it("keeps the checked baseline when an improved candidate drops a required education section", async () => {
  const scripted = scriptedClient({ omitRequiredEntryOnImprovement: true }); deps.aiClient = scripted.client;
  const draft = await makeDraft({ tailoringEnabled: true, tailoringPlan: noGapPlan, quizCompleted: true, rubric });
  await queue().drain();
  const saved = await draftAfter(draft.id);
  expect(saved.status).toBe("ready");
  expect(saved.content?.sections.map(section => section.entryId)).toEqual(["one", "degree"]);
  expect(saved.content?.sections[0]?.bullets).toEqual(["Led a team"]);
  expect(scripted.calls.filter(call => call === "improvement")).toHaveLength(1);
  expect((await listCvBuildSteps(db, userId, draft.id)).find(step => step.motion === "compare_content")?.detail)
    .toMatchObject({ accepted: false });
});

it("a content checkpoint reserves the audit plus one improvement, reuses the author and can still improve", async () => {
  const scripted = scriptedClient(); deps.aiClient = scripted.client;
  const baseline = { name: library.name, contact: library.contact, linkedinUrl: "", websiteUrl: "", summary: "Operations leader",
    summarySources: [{ sourceId: "source:profile", quote: "Operations leader" }],
    sections: [{ entryId: "one", kind: "experience" as const, heading: "Director · Acme", bullets: ["Led a team"],
      bulletSources: [[{ sourceId: "entry:one:row:0", quote: "Led a team" }]] }], gaps: [] };
  const draft = await makeDraft({ tailoringEnabled: true, tailoringPlan: noGapPlan, quizCompleted: true, rubric,
    contentAt: new Date().toISOString() });
  await db.update(schema.cvDrafts).set({ content: baseline }).where(eq(schema.cvDrafts.id, draft.id));

  await queue().drain();

  const saved = await draftAfter(draft.id);
  expect(saved.status).toBe("ready");
  expect(saved.content?.sections[0]?.bullets).toEqual(["Led a team"]);
  const [improved] = await db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, draft.id));
  expect(improved!.content?.sections[0]?.bullets).toEqual(["Led a team", "Delivered transformation"]);
  expect(scripted.calls).not.toContain("author");
  expect(scripted.calls.filter(call => call === "improvement")).toHaveLength(1);
  // Each stage is admitted at its own price as it runs: the audit, then the improvement and its
  // re-check after publication. Nothing is admitted for the writing this build already paid for.
  const admits = (await listCvBuildSteps(db, userId, draft.id)).filter(step => step.motion === "admit_budget");
  const sizes = { libraryBytes: Buffer.byteLength(JSON.stringify(library)), descriptionBytes: Buffer.byteLength("Lead a team. Deliver transformation.") };
  expect(admits.map(step => step.detail.stage)).toEqual(["audit", "improve", "reaudit"]);
  const models = { cvModel: "claude-sonnet-5", routes: {} };
  expect(admits[0]!.detail.expectedUsd).toBe(Number(estimateCvStage("audit", { ...sizes, batches: 1 }, models).toFixed(4)));
  expect(admits[1]!.detail.expectedUsd).toBe(Number(estimateCvStage("improve", sizes, models).toFixed(4)));
});

it("the persisted one-shot fence prevents a retry buying a second improvement", async () => {
  const scripted = scriptedClient(); deps.aiClient = scripted.client;
  const baseline = { name: library.name, contact: library.contact, linkedinUrl: "", websiteUrl: "", summary: "Operations leader",
    summarySources: [{ sourceId: "source:profile", quote: "Operations leader" }],
    sections: [{ entryId: "one", kind: "experience" as const, heading: "Director · Acme", bullets: ["Led a team"],
      bulletSources: [[{ sourceId: "entry:one:row:0", quote: "Led a team" }]] }], gaps: [] };
  const draft = await makeDraft({ tailoringEnabled: true, tailoringPlan: noGapPlan, quizCompleted: true, rubric,
    contentAt: new Date().toISOString(), improvementAttempted: true });
  await db.update(schema.cvDrafts).set({ content: baseline, assessment: { score: 0 } as unknown as CvAssessment }).where(eq(schema.cvDrafts.id, draft.id));
  await queue().drain();
  expect((await draftAfter(draft.id)).status).toBe("ready");
  expect(scripted.calls).not.toContain("author");
  expect(scripted.calls).not.toContain("improvement");
});
