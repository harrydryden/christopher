/**
 * Starting, retrying and rebuilding a CV through the real actions: which model a build is asked
 * of, what a retry carries from the attempt it replaces, and how many builds one account may have
 * waiting for the worker at once.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { CV_THEMES, DEFAULT_CV_THEME } from "@ava/core/cv";
import { rubricFixture } from "../../../../packages/core/test/cv-review-fixture";
import { eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
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

import { assessCvDraft, finaliseCvDraft, requestCv, saveCvDraft } from "./cv";
import { createCvAssessment } from "@ava/core/cv-review";
import { cvClaimItems, cvEvidenceItems, cvTextItems } from "@ava/core/cv-assessment";
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
  expect(await buildTasks()).toHaveLength(1);
});

it("writes a rebuild and a direct edit with the CV model chosen now, not the parent's", async () => {
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

  await expect(saveCvDraft(parent.id, { ok: true }, edit("improve"))).rejects.toThrow("redirect:/cv/");
  const [rebuild] = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(rebuild!.model).toBe("claude-opus-5");

  // The rebuild is queued; once it has stopped, the parent can be edited again.
  await database.update(schema.cvDrafts).set({ status: "failed" }).where(eq(schema.cvDrafts.id, rebuild!.id));
  await expect(saveCvDraft(parent.id, { ok: true }, edit())).rejects.toThrow("redirect:/cv/");
  const children = await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, parent.id));
  expect(children.map(child => child.model)).toEqual(["claude-opus-5", "claude-opus-5"]);
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
  expect(task!.payload).toEqual({ draftId: draft.id });
});

it("retries a page-limit failure against the page limit set since, keeping the CV's own appearance", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
  const theme = { ...CV_THEMES.Navy!, font: "Arial" as const, maxPages: 1 };
  const draft = await failedDraft({
    content: { ...content, theme },
    failure: {
      kind: "page_limit_unfittable", resolvedBy: "user", retryable: false, action: "shorten_or_raise_pages",
      message: "The CV is 2 pages after three attempts; the limit is 1.", motion: "shorten", attempt: 1, maxAttempts: 3,
    },
  });
  // What the failure asks for: raise the page limit in Settings, then retry.
  await database.insert(schema.userSettings).values({ userId: user.id, key: "cvTheme", value: { ...DEFAULT_CV_THEME, maxPages: 3 }, updatedAt: new Date() });

  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({ ok: true });
  const retried = await draftRow(draft.id);
  // The saved wording is measured against its own theme, so that is where the new limit goes.
  expect(retried.content!.theme).toEqual({ ...theme, maxPages: 3 });
  expect(retried.content!.sections).toEqual(content.sections);
  expect(retried.librarySnapshot.theme!.maxPages).toBe(3);
});

it("refuses a retry the account's current CV model cannot run, and queues nothing", async () => {
  const draft = await failedDraft();
  // The website extraction model, which a CV build may not share.
  await setCvModel("claude-sonnet-5");
  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({
    ok: false, error: "Choose a CV model different from website extraction before generating.",
  });
  // A model this deployment no longer offers.
  await setCvModel("claude-retired-4");
  expect(await assessCvDraft(draft.id, { ok: true }, new FormData())).toEqual({
    ok: false, error: "Choose a supported model for CV generation in Settings.",
  });
  expect((await draftRow(draft.id)).status).toBe("failed");
  expect(await buildTasks()).toHaveLength(0);
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

it("refuses an account's fourth build in flight in a sentence, and writes nothing for it", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
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
  expect(await saveCvDraft(ready.id, { ok: true }, edit)).toEqual({ ok: false, error: CV_BUILD_CAP_MESSAGE });
  expect(await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, ready.id))).toHaveLength(0);

  await database.update(schema.cvDrafts).set({ status: "failed" }).where(eq(schema.cvDrafts.id, failed.id));
  await database.update(schema.cvDrafts).set({ status: "generating" }).where(eq(schema.cvDrafts.id, ready.id));
  expect(await assessCvDraft(failed.id, { ok: true }, new FormData())).toEqual({ ok: false, error: CV_BUILD_CAP_MESSAGE });
  expect((await draftRow(failed.id)).status).toBe("failed");
});

it("lets exactly one of two simultaneous requests take the last place", async () => {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: library });
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
