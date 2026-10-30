import { withCvEditBase } from "@/test/cv-form";
/**
 * Starting, retrying and rebuilding a CV through the real actions: which model a build is asked
 * of, what a retry carries from the attempt it replaces, and how many builds one account may have
 * waiting for the worker at once.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, grantCvCredits, releaseCvCredit, reserveCvCredit, schema, subscribeToCompany, type Db } from "@col/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@col/db/migrate";
import { CV_THEMES, DEFAULT_CV_THEME, CvLibrarySchema } from "@col/core/cv";
import { cvTailoringEvidence, validateCvTailoringPlan } from "@col/core/cv-tailoring";
import { cvTargetingSource } from "@col/core/cv-targeting-identity";
import { reviseFailedCvTargeting } from "./cv-targeting";
import { rubricFixture } from "../../../../packages/core/test/cv-review-fixture";
import { eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@col/db/schema";

let database: Db;
async function saveWithBase(id: string, previous: Parameters<typeof saveCvDraft>[1], form: FormData) {
  return saveCvDraft(id, previous, await withCvEditBase(database, id, form));
}

let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
/** Runs inside every render the actions ask for, so a test can look at the database mid-render. */
const rendering = vi.hoisted(() => ({ during: undefined as undefined | (() => Promise<void>) }));
vi.mock("@/lib/cv-pdf", async (actual) => {
  const real = await actual<typeof import("@/lib/cv-pdf")>();
  return {
    ...real,
    renderCvPdf: async (...args: Parameters<typeof real.renderCvPdf>) => {
      await rendering.during?.();
      return real.renderCvPdf(...args);
    },
  };
});

import { assessCvDraft, dismissCvReviewItem, finaliseCvDraft, quoteCvBuild, requestCv, saveCvDraft } from "./cv";
import { createCvAssessment } from "@col/core/cv-review";
import { cvClaimItems, cvEvidenceItems, cvTextItems } from "@col/core/cv-assessment";
import { reviewFixture } from "../../../../packages/core/test/cv-review-fixture";
import { CV_BUILD_CAP_MESSAGE, MAX_CV_BUILDS_IN_FLIGHT } from "@/lib/cv-build-capacity";
import { CV_WORKER_STOPPED_MESSAGE, cvBuildState } from "@/lib/cv-build-state";
import { getOwnCvBuildTask } from "@/lib/queries/cv";
import { ensureTestUser } from "@/test/auth";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "cv-builds-test-secret";
});
afterAll(async () => {
  await pool?.end();
});
beforeEach(async () => {
  rendering.during = undefined;
  await database.execute(
    sql`truncate ai_calls, ai_reservations, applications, cv_versions, cv_drafts, cv_libraries, companies, tasks, settings, user_settings, users restart identity cascade`,
  );
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});

const library = {
  name: "Example",
  contact: "London",
  profile: "Leader",
  entries: [
    { id: "one", kind: "experience" as const, heading: "Director", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
  ],
};
const content = {
  name: "Example",
  contact: "London",
  summary: "Original profile",
  sections: [{ entryId: "one", kind: "experience" as const, heading: "Director", bullets: ["Led a team"] }],
  gaps: [],
};

/** Room for several whole builds at once: the quote counts the builds already queued. */
async function setBudget(usd: number) {
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: usd, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value: usd } });
}

async function setCvModel(model: string) {
  await database.insert(schema.userSettings).values({ userId: user.id, key: "cvModel", value: model, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value: model } });
}

async function failedDraft(extra: Partial<typeof schema.cvDrafts.$inferInsert> = {}) {
  const [row] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobTitle: "Director", companyName: "Example", jobDescription: "Finance operations",
    libraryVersion: 1, librarySnapshot: library, model: "claude-haiku-4-5", status: "failed", revision: 1,
    content,
    buildCheckpoint: { rubricAt: "2026-09-01T00:00:00.000Z", contentAt: "2026-09-01T00:01:00.000Z", attempt: 3, tailoringEnabled: true },
    error: "The model repeatedly returned the wrong skill format.",
    failure: {
      kind: "output_invalid", resolvedBy: "user", retryable: false, action: "choose_model",
      message: "The model repeatedly returned the wrong skill format. Retry the build or choose another CV model.",
      motion: "write", attempt: 3, maxAttempts: 3,
    },
    ...extra,
  }).returning();
  return row!;
}

const draftRow = async (id: string) =>
  (await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, id)))[0]!;
const buildTasks = () => database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"));

it("validates a pasted advert without changing the one-credit cost or creating a build", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const [role] = await visibleRoles(1);
  const short = await quoteCvBuild(role!.job.id, "Lead a team.");
  const long = await quoteCvBuild(role!.job.id, "Lead a team. ".repeat(3_000));
  expect(short.ok).toBe(true);
  expect(long.ok).toBe(true);
  if (short.ok && long.ok) expect(long.line).toBe(short.line);
  expect(await quoteCvBuild(role!.job.id, "x".repeat(60_001))).toEqual({ ok: false, error: "Keep the job description under 60,000 characters." });
  expect(await quoteCvBuild(crypto.randomUUID(), "Lead a team.")).toEqual({ ok: false, error: "Role not found." });
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(0);
  expect(await database.select().from(schema.applications)).toHaveLength(0);
});

it("retries a failed build with the CV model chosen since, and keeps what it already paid for", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const draft = await failedDraft();
  // The failure's own advice: choose another CV model, then retry.
  await setCvModel("claude-opus-5");

  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({ ok: true });
  const retried = await draftRow(draft.id);
  expect(retried.model).toBe("claude-opus-5");
  expect(retried.status).toBe("queued");
  // Only the model changed: the rubric and the wording that already fit are still resumed from.
  expect(retried.buildCheckpoint).toEqual(draft.buildCheckpoint);
  const tasks = await buildTasks();
  expect(tasks).toHaveLength(1);
  // The wording is the build's own (its checkpoint says it wrote it), so the retry resumes from the
  // checkpoint rather than asking for an assessment of typed wording — which is what keeps a
  // tailored build's one optional rewrite on offer.
  expect(tasks[0]!.payload).toMatchObject({ draftId: draft.id, userId: expect.any(String) });
});

it("retries a Direct Edit as an assessment of the wording as typed, with the rubric it carried", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const rubric = rubricFixture("Finance operations");
  // Save Direct Edits wrote the revision: content the person typed, and only the parent's rubric.
  const draft = await failedDraft({ buildCheckpoint: { sourceRubric: rubric } });
  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({ ok: true });
  const [task] = await buildTasks();
  expect(task!.payload).toMatchObject({ draftId: draft.id, mode: "assess", userId: expect.any(String) });
  expect((await draftRow(draft.id)).buildCheckpoint).toEqual({ sourceRubric: rubric });
  expect(await database.select().from(schema.creditReservations).where(eq(schema.creditReservations.draftId, draft.id))).toHaveLength(0);
});

it("reserves a returned credit again when the user retries a failed AI-written build", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const draft = await failedDraft();
  await database.transaction(async tx => {
    await reserveCvCredit(tx, user.id, draft.id, new Date("2026-09-01T00:00:00Z"));
    await releaseCvCredit(tx, draft.id, "Initial build failed");
  });
  for (let index = 0; index < 3; index++)
    await database.transaction(tx => reserveCvCredit(tx, user.id, crypto.randomUUID()));
  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toMatchObject({ ok: false, recovery: { href: "/account#top-ups" } });
  expect((await draftRow(draft.id)).status).toBe("failed");
  await grantCvCredits(database, { userId: user.id, source: "topup", units: 1, externalRef: "retry-pack" });
  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({ ok: true });
  expect((await database.select().from(schema.creditReservations).where(eq(schema.creditReservations.draftId, draft.id)))[0]?.status).toBe("reserved");
});

it("saves wording immediately without a task and keeps the rubric for an explicit Check", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  // A finished, assessed revision (the helper is a function declaration, so it is in scope here).
  const parent = await finalisableDraft();
  const rubric = parent.assessment!.rubric;
  const form = new FormData();
  form.set("summary", "Edited profile");
  form.set("section-0", "Led a team");
  await expect(saveWithBase(parent.id, { ok: true }, form)).rejects.toThrow("redirect:/cv/");
  const [saved] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(saved!.status).toBe("ready");
  expect(saved!.assessment).toBeNull();
  expect(saved!.buildCheckpoint).toEqual({ sourceRubric: rubric });
  expect(await buildTasks()).toHaveLength(0);
  expect(await assessCvDraft(saved!.id, { ok: true }, new FormData())).toEqual({ ok: true });
  const [task] = await buildTasks();
  expect(task!.payload).toMatchObject({ draftId: saved!.id, mode: "assess" });
});

it("takes a newly completed assessment from the current source without losing the editor's unchanged wording", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const parent = await finalisableDraft();
  const form = new FormData();
  form.set("summary", content.summary);
  form.set("section-0", "Led a team");
  await withCvEditBase(database, parent.id, form);
  const assessedAt = new Date("2026-10-30T12:00:00.000Z").toISOString();
  const originalTransaction = database.transaction.bind(database);
  const transaction = vi.spyOn(database, "transaction").mockImplementationOnce(async (work, config) => {
    // This runs after the action's pre-lock read, but before its locked source read.
    await database.update(schema.cvDrafts).set({ assessment: { ...parent.assessment!, assessedAt } })
      .where(eq(schema.cvDrafts.id, parent.id));
    return originalTransaction(work, config);
  });
  try {
    await expect(saveCvDraft(parent.id, { ok: true }, form)).rejects.toThrow("redirect:/cv/");
  } finally { transaction.mockRestore(); }
  const [child] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(child?.assessment?.assessedAt).toBe(assessedAt);
  expect(child?.buildCheckpoint).toEqual({ sourceRubric: parent.assessment!.rubric });
  expect(await buildTasks()).toHaveLength(0);
});

it("rejects a stale editor after the same revision's saved wording changes", async () => {
  const parent = await failedDraft({ status: "ready", failure: null, error: null, buildCheckpoint: null });
  const form = new FormData();
  form.set("summary", "Old editor wording");
  form.set("section-0", "Led a team");
  await withCvEditBase(database, parent.id, form);
  const originalTransaction = database.transaction.bind(database);
  const transaction = vi.spyOn(database, "transaction").mockImplementationOnce(async (work, config) => {
    await database.update(schema.cvDrafts).set({ content: { ...content, summary: "Recovery wording" } })
      .where(eq(schema.cvDrafts.id, parent.id));
    return originalTransaction(work, config);
  });
  try {
    expect(await saveCvDraft(parent.id, { ok: true }, form)).toMatchObject({ ok: false,
      error: expect.stringContaining("Reload before saving") });
  } finally { transaction.mockRestore(); }
  expect(await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id))).toHaveLength(0);
});

it("deduplicates repeated direct saves, permits distinct wording, and carries the immediate evidence plan", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const parent = await finalisableDraft();
  const plan = { sections: [{ title: "Existing plan" }] } as never;
  await database.insert(schema.cvTailoringPlans).values({ draftId: parent.id, userId: user.id, plan });
  const edit = (summary: string) => {
    const form = new FormData();
    form.set("summary", summary);
    form.set("section-0", "Led a team");
    return form;
  };
  await expect(saveWithBase(parent.id, { ok: true }, edit("First saved wording"))).rejects.toThrow("redirect:/cv/");
  await expect(saveWithBase(parent.id, { ok: true }, edit("First saved wording"))).rejects.toThrow("redirect:/cv/");
  let children = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(children).toHaveLength(1);
  expect(children[0]!.status).toBe("ready");
  expect(children[0]!.assessment).toBeNull();
  expect((await database.select().from(schema.cvTailoringPlans).where(eq(schema.cvTailoringPlans.draftId, children[0]!.id)))[0]?.plan).toEqual(plan);
  await expect(saveWithBase(children[0]!.id, { ok: true }, edit("A further quick edit"))).rejects.toThrow("redirect:/cv/");
  const [grandchild] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, children[0]!.id));
  expect(grandchild?.buildCheckpoint).toEqual({ sourceRubric: parent.assessment!.rubric });
  expect((await database.select().from(schema.cvTailoringPlans).where(eq(schema.cvTailoringPlans.draftId, grandchild!.id)))[0]?.plan).toEqual(plan);
  await expect(saveWithBase(parent.id, { ok: true }, edit("Second saved wording"))).rejects.toThrow("redirect:/cv/");
  children = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(children).toHaveLength(2);
  expect(await buildTasks()).toHaveLength(0);
});

it("keeps a genuinely current assessment when a new saved revision changes no assessed input", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const parent = await finalisableDraft();
  const form = new FormData();
  form.set("summary", content.summary);
  form.set("section-0", "Led a team");
  await expect(saveWithBase(parent.id, { ok: true }, form)).rejects.toThrow("redirect:/cv/");
  const [saved] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(saved!.assessment?.inputHash).toBe(parent.assessment!.inputHash);
  expect(saved!.status).toBe("ready");
  expect(await buildTasks()).toHaveLength(0);
});

it("uses the newly chosen model for Rewrite but preserves the parent model on direct Save", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const parent = await failedDraft({ status: "ready", failure: null, error: null, buildCheckpoint: null });
  await setCvModel("claude-opus-5");
  const edit = (intent?: string) => {
    const form = new FormData();
    if (intent) form.set("intent", intent);
    form.set("summary", content.summary);
    form.set("section-0", "Led a team");
    return form;
  };

  await expect(saveWithBase(parent.id, { ok: true }, edit("improve"))).rejects.toThrow("redirect:/cv/");
  const [rebuild] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(rebuild!.model).toBe("claude-opus-5");

  // The rebuild is queued; once it has stopped, the parent can be edited again.
  await database.update(schema.cvDrafts).set({ status: "failed" }).where(eq(schema.cvDrafts.id, rebuild!.id));
  await expect(saveWithBase(parent.id, { ok: true }, edit())).rejects.toThrow("redirect:/cv/");
  const children = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(children.map(child => child.model)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
  expect((await draftRow(parent.id)).model).toBe("claude-haiku-4-5");
});

it("retries a rebuild that stopped before writing with its rubric and improvements kept", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const rubric = rubricFixture("Finance operations");
  // The rebuild's first attempt extracted its rubric, then stopped before any wording was written.
  const checkpoint = {
    tailoringEnabled: true, quizCompleted: true, rubric, rubricAt: "2026-09-01T00:00:00.000Z", attempt: 3,
    tailoringPlan: { requirements: [], gapQuestions: [] },
    mode: "improve" as const, improvements: ["Name the budget"], sourceRubric: rubric,
  };
  const draft = await failedDraft({ content: null, buildCheckpoint: checkpoint });

  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({ ok: true });
  const retried = await draftRow(draft.id);
  // The Library is read afresh, so the evidence plan goes; what the description and the rebuild
  // asked for does not change, so the rubric and the improvements stay.
  expect(retried.buildCheckpoint).toEqual({
    tailoringEnabled: true, quizCompleted: true, rubric, rubricAt: checkpoint.rubricAt,
    mode: "improve", improvements: ["Name the budget"], sourceRubric: rubric,
  });
  const [task] = await buildTasks();
  expect(task!.payload).toMatchObject({ draftId: draft.id, userId: expect.any(String) });
});

it("retries a page-limit failure against the page limit set since, keeping the CV's own appearance", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const theme = { ...CV_THEMES.Navy!, font: "Arial" as const, maxPages: 1 };
  const sourceRubric = rubricFixture("Finance operations");
  const draft = await failedDraft({
    content: { ...content, theme },
    buildCheckpoint: { sourceRubric },
    failure: {
      kind: "page_limit_unfittable", resolvedBy: "user", retryable: false, action: "shorten_or_raise_pages",
      message: "The CV is 2 pages after three attempts; the limit is 1.", motion: "shorten", attempt: 1, maxAttempts: 3,
    },
  });
  const oldPlan = { requirements: [{
    requirementId: "r1", status: "demonstrated" as const,
    evidence: [{ sourceId: "entry:one:row:0", quote: "Led a team" }], reason: "Direct evidence",
  }], gapQuestions: [] };
  const oldLibrary = CvLibrarySchema.parse(draft.librarySnapshot);
  expect(validateCvTailoringPlan(oldPlan, sourceRubric, cvTailoringEvidence(oldLibrary), oldLibrary)).toEqual(oldPlan);
  await database.insert(schema.cvTailoringPlans).values({ draftId: draft.id, userId: user.id, plan: oldPlan });
  // What the failure asks for: raise the page limit in Settings, then retry.
  await database.insert(schema.userSettings).values({ userId: user.id, key: "cvTheme", value: { ...DEFAULT_CV_THEME, maxPages: 3 }, updatedAt: new Date() });
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 2, content: {
    ...library, entries: [...library.entries, {
      id: "new-stronger-evidence", kind: "experience" as const, heading: "Operations lead",
      details: "Directed a larger operations team", confirmedResponsibilities: ["Directed a larger operations team"],
    }],
  } });

  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({ ok: true });
  const retried = await draftRow(draft.id);
  // The saved wording is measured against its own theme, so that is where the new limit goes.
  expect(retried.content!.theme).toEqual({ ...theme, maxPages: 3 });
  expect(retried.content!.sections).toEqual(content.sections);
  expect(retried.librarySnapshot.theme!.maxPages).toBe(3);
  expect(retried.libraryVersion).toBe(2);
  expect(retried.librarySnapshot.entries.some(entry => entry.id === "new-stronger-evidence")).toBe(true);
  expect(retried.buildCheckpoint?.sourceRubric).toEqual(sourceRubric);
  expect(await database.select().from(schema.cvTailoringPlans).where(eq(schema.cvTailoringPlans.draftId, draft.id))).toHaveLength(0);
});

it("refuses a retry on the extraction model, and reads a retired CV model as the default", async () => {
  const draft = await failedDraft();
  // The website extraction model, which a CV build may not share.
  await setCvModel("claude-sonnet-5");
  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({
    ok: false, error: "Choose a CV model different from website extraction before generating.",
  });
  expect((await draftRow(draft.id)).status).toBe("failed");
  expect(await buildTasks()).toHaveLength(0);
  // A stored model this deployment no longer offers is read as the default CV model, rather than
  // refusing every build until someone edits the row, so the retry goes ahead on that.
  await setCvModel("claude-retired-4");
  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({ ok: true });
  expect(await buildTasks()).toHaveLength(1);
});

const DESCRIPTION = "Lead a business operations team, develop the annual operating plan and work with finance and commercial leaders.";

/** Roles this account can see, each at its own company so each is a role of its own. */
async function visibleRoles(count: number) {
  const roles = [];
  for (let i = 0; i < count; i++) {
    const [company] = await database.insert(schema.companies)
      .values({ name: `Company ${i}`, domain: `company${i}.example`, homepageUrl: `https://company${i}.example` }).returning();
    const [source] = await database.insert(schema.careerSources)
      .values({ companyId: company!.id, type: "html", url: `https://company${i}.example/jobs` }).returning();
    const [job] = await database.insert(schema.jobs).values({
      companyId: company!.id, sourceId: source!.id, title: "Operations Manager", normalizedTitle: "operations manager",
      externalKey: `role-${i}`, url: `https://company${i}.example/jobs/${i}`,
    }).returning();
    await subscribeToCompany(database, user.id, company!.id);
    await database.insert(schema.userJobs).values({ userId: user.id, jobId: job!.id, inTable: true, keywordMatched: true, keywordTerms: ["operations"] });
    roles.push({ company: company!, job: job! });
  }
  return roles;
}

const generate = (jobId: string) => {
  const form = new FormData();
  form.set("jobId", jobId);
  form.set("description", DESCRIPTION);
  return form;
};
const outcome = async (pending: Promise<unknown>) => {
  try {
    return await pending;
  } catch (error) {
    return String((error as Error).message);
  }
};

it("resumes a failed targeted page fit on the same draft with its own revised page choice", async () => {
  const rubric = rubricFixture("Finance operations");
  const source = cvTargetingSource(1, CvLibrarySchema.parse(library), "Finance operations");
  const plan = { requirements: [{ requirementId: "r1", status: "demonstrated" as const,
    evidence: [{ sourceId: "entry:one:row:0", quote: "Led a team" }], reason: "Direct evidence" }], gapQuestions: [] };
  const key = "a".repeat(64);
  const oldRequestKey = crypto.randomUUID();
  const draft = await failedDraft({ content: null, buildCheckpoint: { tailoringEnabled: false, rubric,
    sourceRubric: rubric, tailoringPlan: plan },
    targetingBrief: { version: 1, source, entries: [{ entryId: "one", treatment: "feature" }],
      presentation: { maxPages: 1, bodySizePt: 12 }, priority: { state: "confirmed", rubric, rubricKey: key,
        emphasisRequirementIds: ["r1"], acknowledgedEssentialOmissionIds: [], confirmationKey: oldRequestKey } },
    failure: { kind: "page_limit_unfittable", resolvedBy: "user", retryable: false, action: "shorten_or_raise_pages",
      message: "The CV is two pages; the limit is one.", motion: "shorten", attempt: 3, maxAttempts: 3 },
  });
  const requestKey = crypto.randomUUID();
  const input = { expectedRevision: draft.revision, expectedSource: source, expectedRubricKey: key, requestKey,
    choices: { entries: [{ entryId: "one", treatment: "feature" as const }], presentation: { maxPages: 2, bodySizePt: 12 as const },
      emphasisRequirementIds: ["r1"], acknowledgedEssentialOmissionIds: [] } };
  expect(await reviseFailedCvTargeting(draft.id, input)).toEqual({ ok: true, destination: `/cv/${draft.id}` });
  expect(await reviseFailedCvTargeting(draft.id, input)).toEqual({ ok: true, destination: `/cv/${draft.id}` });
  const resumed = await draftRow(draft.id);
  expect(resumed).toMatchObject({ status: "queued", failure: null, targetingBrief: { presentation: { maxPages: 2 } } });
  expect(await buildTasks()).toHaveLength(1);
  expect(await database.select().from(schema.creditReservations)).toHaveLength(0);
});

it("reprojects saved targeted wording on page-fit recovery without authoring or losing Feature text", async () => {
  const rubric = rubricFixture("Finance operations");
  const source = cvTargetingSource(1, CvLibrarySchema.parse(library), "Finance operations");
  const plan = { requirements: [{ requirementId: "r1", status: "demonstrated" as const,
    evidence: [{ sourceId: "entry:one:row:0", quote: "Led a team" }], reason: "Direct evidence" }], gapQuestions: [] };
  const rubricKey = "b".repeat(64);
  const failure = { kind: "page_limit_unfittable" as const, resolvedBy: "user" as const, retryable: false,
    action: "shorten_or_raise_pages" as const, message: "Two pages exceed one.", motion: "shorten" as const,
    attempt: 3, maxAttempts: 3 };
  const saved = { ...content, theme: { ...DEFAULT_CV_THEME, maxPages: 1, bodySizePt: 12 as const },
    sections: [{ ...content.sections[0]!, bullets: ["Led a team", "Improved delivery"] }] };
  const cachedReview = reviewFixture({ rubric, cv: cvTextItems(saved), claims: cvClaimItems(saved),
    evidence: cvEvidenceItems(CvLibrarySchema.parse(library)) });
  const draft = await failedDraft({ content: saved, failure,
    semanticAuditCache: { identity: "c".repeat(64), review: cachedReview },
    buildCheckpoint: { tailoringEnabled: false, contentAt: "2026-09-01T00:01:00.000Z", rubric, tailoringPlan: plan },
    targetingBrief: { version: 1, source, entries: [{ entryId: "one", treatment: "feature" }],
      presentation: { maxPages: 1, bodySizePt: 12 }, priority: { state: "confirmed", rubric, rubricKey,
        emphasisRequirementIds: ["r1"], acknowledgedEssentialOmissionIds: [], confirmationKey: crypto.randomUUID() } },
  });
  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toMatchObject({ ok: false,
    error: expect.stringContaining("Change this CV's page and evidence choices") });
  expect(await buildTasks()).toHaveLength(0);
  const choices = (treatment: "feature" | "summarise", maxPages: number) => ({
    expectedRevision: draft.revision, expectedSource: source, expectedRubricKey: rubricKey,
    requestKey: crypto.randomUUID(), choices: { entries: [{ entryId: "one", treatment }],
      presentation: { maxPages, bodySizePt: 12 as const }, emphasisRequirementIds: ["r1"],
      acknowledgedEssentialOmissionIds: [] } });
  expect(await reviseFailedCvTargeting(draft.id, choices("feature", 2))).toEqual({ ok: true, destination: `/cv/${draft.id}` });
  const enlarged = await draftRow(draft.id);
  expect(enlarged.content?.sections[0]?.bullets).toEqual(["Led a team", "Improved delivery"]);
  expect(enlarged.content?.theme).toMatchObject({ maxPages: 2, bodySizePt: 12 });
  expect(enlarged.semanticAuditCache?.identity).toBe("c".repeat(64));
  expect(enlarged.assessment).toBeNull();
  expect(enlarged.buildCheckpoint?.contentAt).toBeUndefined();
  expect((await buildTasks())[0]?.payload).toMatchObject({ draftId: draft.id, mode: "assess" });
  await database.update(schema.cvDrafts).set({ status: "failed", failure }).where(eq(schema.cvDrafts.id, draft.id));
  expect(await reviseFailedCvTargeting(draft.id, choices("summarise", 2))).toEqual({ ok: true, destination: `/cv/${draft.id}` });
  const shortened = await draftRow(draft.id);
  expect(shortened.content?.sections[0]?.bullets).toEqual(["Led a team"]);
  expect(shortened.targetingBrief?.manualSections?.[0]?.bullets).toEqual(["Led a team", "Improved delivery"]);
  await database.update(schema.cvDrafts).set({ status: "failed", failure }).where(eq(schema.cvDrafts.id, draft.id));
  expect(await reviseFailedCvTargeting(draft.id, choices("feature", 2))).toEqual({ ok: true, destination: `/cv/${draft.id}` });
  expect((await draftRow(draft.id)).content?.sections[0]?.bullets).toEqual(["Led a team", "Improved delivery"]);
});

it("uses the two-page targeted default after a JSONB theme round trip, but honours an explicit three-page choice", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1,
    content: { ...library, theme: { ...DEFAULT_CV_THEME } } });
  await setBudget(200);
  await grantCvCredits(database, { userId: user.id, source: "admin", units: 2, externalRef: "targeted-theme-test" });
  const roles = await visibleRoles(2);
  expect(await outcome(requestCv({ ok: true }, generate(roles[0]!.job.id)))).toMatch(/^redirect:\/cv\//);
  const [first] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.jobId, roles[0]!.job.id));
  expect(first?.targetingBrief?.presentation.maxPages).toBe(2);
  expect(first?.librarySnapshot.theme?.maxPages).toBe(2);
  await database.insert(schema.userSettings).values({ userId: user.id, key: "cvTheme",
    value: { ...DEFAULT_CV_THEME, maxPages: 3 }, updatedAt: new Date() });
  expect(await outcome(requestCv({ ok: true }, generate(roles[1]!.job.id)))).toMatch(/^redirect:\/cv\//);
  const [second] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.jobId, roles[1]!.job.id));
  expect(second?.targetingBrief?.presentation.maxPages).toBe(3);
  expect(second?.librarySnapshot.theme?.maxPages).toBe(3);
});

it("refuses an account's fourth build in flight in a sentence, and writes nothing for it", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  await setBudget(200);
  await grantCvCredits(database, { userId: user.id, source: "admin", units: 1, externalRef: "capacity-test" });
  const roles = await visibleRoles(MAX_CV_BUILDS_IN_FLIGHT + 1);
  for (const role of roles.slice(0, MAX_CV_BUILDS_IN_FLIGHT))
    expect(await outcome(requestCv({ ok: true }, generate(role.job.id)))).toMatch(/^redirect:\/cv\//);
  const before = await database.select().from(schema.cvDrafts);
  expect(before).toHaveLength(MAX_CV_BUILDS_IN_FLIGHT);

  const last = roles.at(-1)!;
  expect(await requestCv({ ok: true }, generate(last.job.id))).toEqual({ ok: false, error: CV_BUILD_CAP_MESSAGE });
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(MAX_CV_BUILDS_IN_FLIGHT);
  expect(await buildTasks()).toHaveLength(MAX_CV_BUILDS_IN_FLIGHT);
  const applied = await database.select().from(schema.applications);
  expect(applied.map(row => row.jobId).sort()).toEqual(roles.slice(0, MAX_CV_BUILDS_IN_FLIGHT).map(role => role.job.id).sort());
  expect(applied.every(row => row.status === "applying" && row.appliedOn === null)).toBe(true);

  // A second click on a role already building still goes to that build.
  expect(await outcome(requestCv({ ok: true }, generate(roles[0]!.job.id)))).toBe(`redirect:/cv/${before.find(draft => draft.jobId === roles[0]!.job.id)!.id}`);

  // A build paused on its questions holds no place in the queue; one that has finished frees its place.
  await database.update(schema.cvDrafts).set({ status: "awaiting_evidence" }).where(eq(schema.cvDrafts.jobId, roles[1]!.job.id));
  expect(await outcome(requestCv({ ok: true }, generate(last.job.id)))).toMatch(/^redirect:\/cv\//);
});

it("holds a retry and a saved edit to the same cap, and counts only this account's builds", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const other = await ensureTestUser(database, "someone-else@example.com", "member");
  const building = (userId: string, i: number, status: "queued" | "generating") => ({
    userId, jobTitle: `Role ${i}`, companyName: `Company ${i}`, jobDescription: DESCRIPTION,
    libraryVersion: 1, librarySnapshot: library, model: "claude-haiku-4-5", status, revision: 1,
  });
  // Another account's builds are theirs: they never count against this one.
  await database.insert(schema.cvDrafts).values([0, 1, 2, 3].map(i => building(other.id, i, "generating")));
  const failed = await failedDraft();
  const ready = await failedDraft({ jobTitle: "Other role", status: "ready", failure: null, error: null, buildCheckpoint: null });
  await database.insert(schema.cvDrafts).values([
    building(user.id, 10, "queued"),
    building(user.id, 11, "generating"),
  ]);
  // Two of three: one more is allowed.
  expect(await assessCvDraft(failed.id, { ok: true }, new FormData())).toEqual({ ok: true });

  const edit = new FormData();
  edit.set("summary", content.summary);
  edit.set("section-0", "Led a team");
  await expect(saveWithBase(ready.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
  expect(await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, ready.id))).toHaveLength(1);

  await database.update(schema.cvDrafts).set({ status: "failed" }).where(eq(schema.cvDrafts.id, failed.id));
  await database.update(schema.cvDrafts).set({ status: "generating" }).where(eq(schema.cvDrafts.id, ready.id));
  expect(await assessCvDraft(failed.id, { ok: true }, new FormData())).toEqual({ ok: false, error: CV_BUILD_CAP_MESSAGE });
  expect((await draftRow(failed.id)).status).toBe("failed");
});

it("uses a fixed credit price even when the internal budget estimate is high", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const roles = await visibleRoles(3);
  // All three welcome credits can start builds. Internal model estimates are not customer prices.
  expect(await outcome(requestCv({ ok: true }, generate(roles[0]!.job.id)))).toMatch(/^redirect:\/cv\//);
  expect(await outcome(requestCv({ ok: true }, generate(roles[1]!.job.id)))).toMatch(/^redirect:\/cv\//);
  expect(await outcome(requestCv({ ok: true }, generate(roles[2]!.job.id)))).toMatch(/^redirect:\/cv\//);
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(3);
  expect(await database.select().from(schema.creditReservations)).toHaveLength(3);
});

it("lets exactly one of two simultaneous requests take the last place", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  await setBudget(200);
  const roles = await visibleRoles(MAX_CV_BUILDS_IN_FLIGHT + 1);
  for (const role of roles.slice(0, MAX_CV_BUILDS_IN_FLIGHT - 1))
    expect(await outcome(requestCv({ ok: true }, generate(role.job.id)))).toMatch(/^redirect:\/cv\//);

  const results = await Promise.all(roles.slice(-2).map(role => outcome(requestCv({ ok: true }, generate(role.job.id)))));
  expect(results.filter(result => typeof result === "string" && result.startsWith("redirect:/cv/"))).toHaveLength(1);
  expect(results).toContainEqual({ ok: false, error: CV_BUILD_CAP_MESSAGE });
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(MAX_CV_BUILDS_IN_FLIGHT);
});

it("writes one application for a role when a Generate and a stage saved from the table meet", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const [role] = await visibleRoles(1);
  // The stage is being saved: its transaction holds the role's row and has written the application.
  const table = await pool.connect();
  try {
    await table.query("begin");
    await table.query("select job_id from user_jobs where user_id = $1 and job_id = $2 for update", [user.id, role!.job.id]);
    await table.query(
      `insert into applications (user_id, job_id, job_title, company_name, applied_on, status, notes, history)
       values ($1, $2, 'Operations Manager', 'Company 0', '2026-09-23', 'interviewing', '', '[]')`,
      [user.id, role!.job.id],
    );
    let settled = false;
    const generating = outcome(requestCv({ ok: true }, generate(role!.job.id))).finally(() => { settled = true; });
    // The Generate waits for the stage's lock, or — without one — finishes on its own.
    for (;;) {
      const waiting = await database.execute(
        sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' limit 1`,
      );
      if (waiting.rows.length || settled) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    await table.query("commit");
    expect(await generating).toMatch(/^redirect:\/cv\//);
  } finally {
    table.release();
  }
  const applied = await database.select().from(schema.applications);
  expect(applied.map(row => row.status)).toEqual(["interviewing"]);
});

/** A ready revision whose assessment is current and clean, as a finished build leaves one. */
async function finalisableDraft() {
  const description = "Finance operations";
  const rubric = rubricFixture(description);
  const review = reviewFixture({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content), evidence: cvEvidenceItems(library) });
  const assessment = createCvAssessment({ content, description, library, rubric, review, model: "test", pageCount: 1 });
  return failedDraft({ status: "ready", failure: null, error: null, buildCheckpoint: null, assessment, jobDescription: description });
}
const reviewed = () => {
  const form = new FormData();
  form.set("reviewed", "on");
  return form;
};

it("checks the PDF lays out before finalising, without holding the draft's row while it renders", async () => {
  const draft = await finalisableDraft();
  let probed = false;
  rendering.during = async () => {
    // Nothing else may be kept waiting on this row for the length of a render.
    await database.execute(sql`select id from cv_drafts where id = ${draft.id} for update nowait`);
    probed = true;
  };
  expect(await finaliseCvDraft(draft.id, { ok: true }, reviewed())).toEqual({ ok: true });
  expect(probed).toBe(true);
  expect((await draftRow(draft.id)).finalisedAt).not.toBeNull();
});

it("freezes one PDF with the finalised revision and keeps it when a new revision is saved", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const draft = await finalisableDraft();
  expect(await finaliseCvDraft(draft.id, { ok: true }, reviewed())).toEqual({ ok: true });
  const [approved] = await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, draft.id));
  expect(approved?.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect((await finaliseCvDraft(draft.id, { ok: true }, reviewed())).ok).toBe(false);
  expect((await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, draft.id)))[0]?.bytes).toEqual(approved?.bytes);
  const edit = new FormData();
  edit.set("summary", "New revision wording");
  edit.set("section-0", "Led a team");
  await expect(saveWithBase(draft.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
  const [child] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, draft.id));
  expect(child?.finalisedAt).toBeNull();
  expect(await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, child!.id))).toHaveLength(0);
  expect((await database.select().from(schema.cvPdfs).where(eq(schema.cvPdfs.draftId, draft.id)))[0]?.bytes).toEqual(approved?.bytes);
});

it("records a dismissal against the current assessment and retains the factual finding", async () => {
  const draft = await finalisableDraft();
  const assessment = structuredClone(draft.assessment!);
  const claim = assessment.review.claims[0]!;
  claim.status = "unsupported";
  claim.reason = "The Library does not establish this claim.";
  await database.update(schema.cvDrafts).set({ assessment }).where(eq(schema.cvDrafts.id, draft.id));
  const rowId = `claim:${claim.claimId}`;
  expect((await dismissCvReviewItem(draft.id, rowId, assessment.inputHash, "stale")).ok).toBe(false);
  expect((await draftRow(draft.id)).reviewDecision).toBeNull();
  expect(await dismissCvReviewItem(draft.id, rowId, assessment.inputHash, assessment.assessedAt)).toEqual({ ok: true });
  expect((await draftRow(draft.id)).reviewDecision).toMatchObject({ inputHash: assessment.inputHash, dismissedRowIds: [rowId], skipped: false });
  const form = reviewed();
  form.set("assessmentHash", assessment.inputHash);
  form.set("assessedAt", assessment.assessedAt);
  expect(await finaliseCvDraft(draft.id, { ok: true }, form)).toEqual({ ok: true });
  const saved = await draftRow(draft.id);
  expect(saved.finalisedAt).not.toBeNull();
  expect(saved.assessment?.review.claims[0]?.status).toBe("unsupported");
});

it("allows an explicit finalise-anyway decision and keeps it for later download checks", async () => {
  const draft = await finalisableDraft();
  const assessment = structuredClone(draft.assessment!);
  assessment.review.claims[0]!.status = "unsupported";
  assessment.review.claims[0]!.reason = "Further evidence is needed.";
  await database.update(schema.cvDrafts).set({ assessment }).where(eq(schema.cvDrafts.id, draft.id));
  const form = reviewed();
  form.set("assessmentHash", assessment.inputHash);
  form.set("assessedAt", assessment.assessedAt);
  expect((await finaliseCvDraft(draft.id, { ok: true }, form)).ok).toBe(false);
  form.set("skipReview", "on");
  expect(await finaliseCvDraft(draft.id, { ok: true }, form)).toEqual({ ok: true });
  const saved = await draftRow(draft.id);
  expect(saved.reviewDecision).toMatchObject({ skipped: true, inputHash: assessment.inputHash });
  expect(saved.assessment?.review.claims[0]?.status).toBe("unsupported");
});

it("refuses to finalise a revision that was assessed again while its PDF was being checked", async () => {
  const draft = await finalisableDraft();
  rendering.during = async () => {
    await database.update(schema.cvDrafts)
      .set({ assessment: { ...draft.assessment!, assessedAt: new Date(Date.now() + 1000).toISOString() } })
      .where(eq(schema.cvDrafts.id, draft.id));
  };
  expect(await finaliseCvDraft(draft.id, { ok: true }, reviewed())).toEqual({
    ok: false, error: "This revision changed while it was being checked. Reload it before finalising.",
  });
  expect((await draftRow(draft.id)).finalisedAt).toBeNull();
});

it("queues a Generate while no worker is running, and the CV page says it will start when one is", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const [role] = await visibleRoles(1);
  // No worker has ever reported: a deployment with only the interface running.
  expect(await outcome(requestCv({ ok: true }, generate(role!.job.id)))).toMatch(/^redirect:\/cv\//);
  const [draft] = await database.select().from(schema.cvDrafts);
  const stopped = await getOwnCvBuildTask(user.id, draft!.id);
  expect(stopped).toMatchObject({ status: "queued", workerStopped: true });
  expect(cvBuildState(draft!, stopped!, new Date()).message).toBe(CV_WORKER_STOPPED_MESSAGE);

  // A worker that reported a moment ago is picking queued work up: the ordinary wait.
  await database.insert(schema.settings).values({ key: "internal:workerHeartbeat", value: { at: new Date().toISOString() } });
  const running = await getOwnCvBuildTask(user.id, draft!.id);
  expect(running).toMatchObject({ workerStopped: false });
  expect(cvBuildState(draft!, running!, new Date()).message).toBe("Waiting for the worker.");
  // Another account's draft is still nobody's to read.
  expect(await getOwnCvBuildTask(crypto.randomUUID(), draft!.id)).toBeNull();
});
