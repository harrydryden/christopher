/**
 * End-to-end test of the CV-builder pipeline.
 *
 * Everything runs for real — the server actions, the task rows, the worker handler, the shipped
 * prompts, the engine's streaming and batched assessment, every validator, the page fitter and
 * PDFKit — against a scripted Anthropic client injected as `WorkerDeps.aiClient`. Only the model's
 * words are scripted, so this exercises the pipeline rather than the mocks around it.
 *
 * Run it against its own database so it does not collide with the suites that truncate shared
 * tables:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/christopher_e2e \
 *   CHRISTOPHER_DISABLE_BROWSER=1 pnpm test cv-e2e
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { CV_THEMES } from "@christopher/core/cv";
import { cvClaimItems } from "@christopher/core/cv-assessment";
import { renderCvPdfWithReport } from "@christopher/core/cv-pdf";
import { signInTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";
import {
  callsOf,
  createScriptedAiClient,
  LIBRARY_ONLY_IMPROVEMENT,
  REVIEW_BATCH_SIZE,
  type ScriptedCall,
} from "@/test/scripted-ai-client";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

import {
  finaliseCvDraft,
  requestCv,
  saveCvAppearance,
  saveCvDraft,
  saveCvLibrary,
  saveCvModel,
  saveCvWritingPreferences,
} from "./cv";
import { recordApplication } from "./applications";
import { GET as downloadApplication } from "@/app/api/applications/[id]/pdf/route";

const MAX_PAGES = 2;
const CV_MODEL = "claude-fable-5-1";
const THEME = { ...CV_THEMES.Navy!, maxPages: MAX_PAGES };
const STYLE_PREFERENCES =
  "Write in plain UK English, lead every bullet with the outcome and never use the word synergy.";
const PREFERRED_WORDING =
  "Say 'community clinics' rather than 'sites' when describing the Northwind portfolio.";

const DESCRIPTION = [
  "Head of Operations — Meridian Care Group",
  "",
  "About the role",
  "Meridian Care Group runs community health services across the North West of England.",
  "We are hiring a Head of Operations to own service delivery for a portfolio of twelve sites and to lead a team of four operations managers.",
  "",
  "What you will do",
  "You will own the operational plan for the portfolio and report performance to the executive team each month.",
  "You will lead continuous improvement work across scheduling, rostering and supplier performance.",
  "You will partner with finance to build the annual budget and to track monthly variance.",
  "",
  "What we are looking for",
  "Candidates must have at least five years of experience leading operations in a regulated environment.",
  "You must be able to build and interpret reporting in SQL or a comparable analytics tool.",
  "Experience of supplier negotiation is preferred.",
  "A degree or equivalent professional qualification is required.",
  "Familiarity with NetSuite or a similar ERP is desirable.",
  "This role is hybrid, with two days a week in our Manchester office.",
  "",
  "We offer a competitive salary, a pension and twenty-eight days of holiday.",
].join("\n");

const NORTHWIND_HEAD = [
  "Own the operational plan for eleven community clinics, reporting delivery, cost and quality to the executive team every month.",
  "Lead four operations managers and a shared scheduling team of eighteen, running a weekly performance review against a published set of measures.",
  "Rebuilt rostering and scheduling around a single demand model, replacing four spreadsheets and a shared inbox with one weekly plan, which cut agency spend by 22% in the first year while holding appointment availability flat across all eleven clinics and shortening the rota lead time from ten days to three.",
  "Partner with finance on the annual budget and on monthly variance across a £14m cost base.",
  "Introduced a supplier scorecard covering the eight largest contracts, with quarterly reviews against agreed service levels.",
];
const NORTHWIND_MANAGER = [
  "Ran day-to-day operations for four clinics, owning the rota, the patient flow and the site budget.",
  "Built the first operational reporting pack in SQL and Power BI, replacing a manual month-end spreadsheet that took three days to assemble.",
  "Cut the month-end close from nine working days to five by agreeing a single source for activity data with finance.",
  "Managed the transition of two acquired clinics onto the group's systems and ways of working.",
];
const CALDER = [
  "Led a service desk of nine covering two distribution centres and a national customer base.",
  "Owned the service level agreement with the group's three largest retail customers and chaired the monthly review.",
  "Introduced root-cause analysis on repeat incidents, which reduced escalations by a third over two years.",
];
const NEW_RESPONSIBILITY =
  "Introduced a weekly variance review with finance, which cut month-end close from five days to three.";

function libraryFixture(headResponsibilities: string[] = NORTHWIND_HEAD) {
  return {
    name: "Rowan Mercer",
    contact: "Manchester, UK · rowan.mercer@example.test · +44 7700 900123",
    linkedinUrl: "https://www.linkedin.com/in/rowan-mercer",
    profile:
      "Operations leader with twelve years across regulated healthcare and B2B software, accountable for multi-site service delivery, supplier performance and the annual operating budget. I build small teams that own their numbers, turn manual scheduling and reporting into measured processes, and work in the open with finance, clinical leads and external providers. I am happiest where the operating model is still being written and the reporting has to be built before it can be trusted.",
    employment: [
      {
        id: "emp-northwind-head",
        company: "Northwind Health",
        industryDescriptions: "Healthcare, Regulated services, Software & SaaS",
        jobTitle: "Head of Operations",
        startDate: "2021-04",
        endDate: "",
        current: true,
      },
      {
        id: "emp-northwind-manager",
        company: "Northwind Health",
        industryDescriptions: "Healthcare, Regulated services, Software & SaaS",
        jobTitle: "Operations Manager",
        startDate: "2018-01",
        endDate: "2021-03",
        current: false,
      },
      {
        id: "emp-calder",
        company: "Calder Logistics",
        industryDescriptions: "Logistics, Supply chain",
        jobTitle: "Service Delivery Lead",
        startDate: "2014-09",
        endDate: "2017-12",
        current: false,
      },
    ],
    entries: [
      {
        id: "ev-northwind-head",
        kind: "experience" as const,
        employmentId: "emp-northwind-head",
        heading: "Head of Operations · Northwind Health",
        details: headResponsibilities.join("\n"),
        confirmedResponsibilities: headResponsibilities,
      },
      {
        id: "ev-northwind-manager",
        kind: "experience" as const,
        employmentId: "emp-northwind-manager",
        heading: "Operations Manager · Northwind Health",
        details: NORTHWIND_MANAGER.join("\n"),
        confirmedResponsibilities: NORTHWIND_MANAGER,
      },
      {
        id: "ev-calder",
        kind: "experience" as const,
        employmentId: "emp-calder",
        heading: "Service Delivery Lead · Calder Logistics",
        details: CALDER.join("\n"),
        confirmedResponsibilities: CALDER,
      },
      {
        id: "ev-education",
        kind: "education" as const,
        heading: "Education",
        details:
          "BSc (Hons) Economics, University of Manchester, 2014\nPRINCE2 Practitioner, APMG International, 2019",
      },
      {
        id: "ev-skills",
        kind: "skill" as const,
        heading: "Systems and tools",
        details: "Reporting, planning and finance systems used day to day.",
        skillItems: [
          "SQL",
          "Power BI",
          "NetSuite",
          "Process mapping",
          "Financial planning",
          "Vendor management",
          "Python",
        ],
      },
      {
        id: "ev-ways-of-working",
        kind: "skill" as const,
        heading: "Ways of working",
        details:
          "Stakeholder engagement, continuous improvement, supplier negotiation, change management",
      },
      {
        id: "ev-interests",
        kind: "interest" as const,
        heading: "Interests",
        details: "Long-distance running and volunteering as a trustee for a local food bank.",
      },
    ],
  };
}

beforeAll(async () => {
  const client = createDb(
    process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test",
  );
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "cv-e2e-test-secret";
});
afterAll(async () => {
  await pool?.end();
});
beforeEach(async () => {
  await database.execute(
    sql`truncate ai_calls, ai_reservations, resource_leases, applications, cv_versions, cv_drafts, cv_libraries, companies, tasks, settings, user_settings, users restart identity cascade`,
  );
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});

/** The role this account can see, created the way the interface's own fixtures do. */
async function visibleRole() {
  const [company] = await database
    .insert(schema.companies)
    .values({
      name: "Meridian Care Group",
      domain: "meridiancare.example",
      homepageUrl: "https://meridiancare.example",
    })
    .returning();
  const [source] = await database
    .insert(schema.careerSources)
    .values({ companyId: company!.id, type: "html", url: "https://meridiancare.example/jobs" })
    .returning();
  const [job] = await database
    .insert(schema.jobs)
    .values({
      companyId: company!.id,
      sourceId: source!.id,
      title: "Head of Operations",
      normalizedTitle: "head of operations",
      externalKey: "meridian-head-of-operations",
      url: "https://meridiancare.example/jobs/head-of-operations",
      descriptionText: DESCRIPTION,
      descriptionSource: "direct",
    })
    .returning();
  await subscribeToCompany(database, user.id, company!.id);
  await database.insert(schema.userJobs).values({
    userId: user.id,
    jobId: job!.id,
    inTable: true,
    keywordMatched: true,
    keywordTerms: ["operations"],
  });
  return { company: company!, job: job! };
}

const draftRow = async (id: string) =>
  (await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, id)))[0]!;

const childOf = async (id: string) =>
  (await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.parentId, id)))[0]!;

const aiCalls = () =>
  database.select().from(schema.aiCalls).orderBy(schema.aiCalls.at);

describe("the CV pipeline end to end, against a scripted model", () => {
  it("builds, edits, rebuilds, finalises and exports one CV through the real entry points", async () => {
    const fake = createScriptedAiClient();
    const { handleGenerateCv } = await import("../../../worker/src/handlers/cv");
    const deps = {
      db: database,
      env: { anthropicApiKey: "scripted-key" },
      settings: async () => ({ monthlyAiBudgetUsd: 100 }),
      userSettings: async () => ({ aiBudgetUsd: 100, aiBudgetResetAt: null }),
      now: () => new Date(),
      aiClient: fake.client,
    } as unknown as import("../../../worker/src/context").WorkerDeps;

    let mark = 0;
    const since = (): ScriptedCall[] => fake.calls.slice(mark);
    const markCalls = () => {
      mark = fake.calls.length;
    };

    async function runHandler(draftId: string) {
      const [task] = await database
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.type, "generate_cv"), sql`payload->>'draftId' = ${draftId}`))
        .orderBy(schema.tasks.createdAt);
      expect(task, `a generate_cv task for ${draftId}`).toBeTruthy();
      const result = await handleGenerateCv(task!, deps);
      await database
        .update(schema.tasks)
        .set({ status: "done" })
        .where(eq(schema.tasks.id, task!.id));
      return result;
    }

    // 1. The account's library, writing preferences, appearance and CV model.
    const save = new FormData();
    save.set("library", JSON.stringify(libraryFixture()));
    save.set("version", "0");
    expect(await saveCvLibrary({ ok: true }, save)).toEqual({ ok: true });

    const preferences = new FormData();
    preferences.set("stylePreferences", STYLE_PREFERENCES);
    preferences.set("preferredWording", PREFERRED_WORDING);
    preferences.set(
      "previousPreferences",
      JSON.stringify({ stylePreferences: "", preferredWording: "" }),
    );
    expect(await saveCvWritingPreferences({ ok: true }, preferences)).toEqual({ ok: true });

    const appearance = new FormData();
    appearance.set("theme", JSON.stringify(THEME));
    expect(await saveCvAppearance({ ok: true }, appearance)).toEqual({ ok: true });

    const model = new FormData();
    model.set("cvModel", CV_MODEL);
    expect(await saveCvModel({ ok: true }, model)).toEqual({ ok: true });

    // 2. A real-looking posting this account can see, then the request.
    const { job } = await visibleRole();
    const request = new FormData();
    request.set("jobId", job.id);
    await expect(requestCv({ ok: true }, request)).rejects.toThrow("redirect:/cv/");
    const first = (await database.select().from(schema.cvDrafts))[0]!;
    expect(first.model).toBe(CV_MODEL);
    expect(first.librarySnapshot.stylePreferences).toBe(STYLE_PREFERENCES);
    expect(first.librarySnapshot.theme?.maxPages).toBe(MAX_PAGES);

    // 3. The build.
    markCalls();
    expect(await runHandler(first.id)).toMatchObject({ draftId: first.id, ready: true });
    const built = await draftRow(first.id);
    expect(built.error).toBeNull();
    expect(built.status).toBe("ready");
    const content = built.content!;

    // Every experience and education block is printed.
    const printed = content.sections.map((section) => section.entryId);
    for (const entry of built.librarySnapshot.entries.filter((candidate) =>
      ["experience", "education"].includes(candidate.kind),
    ))
      expect(printed).toContain(entry.id);
    // Nothing is printed that the writing budget did not allocate space for.
    const allocated = callsOf(since(), "author")[0]!.payload.writingBudget.blocks.map(
      (block) => block.entryId,
    );
    for (const entryId of printed) expect(allocated).toContain(entryId);
    expect(content.name).toBe("Rowan Mercer");
    expect(content.theme?.maxPages).toBe(MAX_PAGES);
    // Skills are the exact stored labels, industries the exact stored descriptions.
    const skills = content.sections.find((section) => section.entryId === "ev-skills")!;
    expect(skills.skillItems!.length).toBeGreaterThan(0);
    for (const label of skills.skillItems!)
      expect(libraryFixture().entries.find((e) => e.id === "ev-skills")!.skillItems).toContain(label);
    const newest = content.sections.find((section) => section.entryId === "ev-northwind-head")!;
    const older = content.sections.find((section) => section.entryId === "ev-northwind-manager")!;
    expect(newest.industryDescriptions!.length).toBeGreaterThan(0);
    for (const description of newest.industryDescriptions!)
      expect(["Healthcare", "Regulated services", "Software & SaaS"]).toContain(description);
    // Two roles at the same employer carry the same company context.
    expect(older.industryDescriptions).toEqual(newest.industryDescriptions);

    const report = await renderCvPdfWithReport(content);
    expect(report.pageCount).toBeLessThanOrEqual(MAX_PAGES);
    expect(report.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const assessment = built.assessment!;
    expect(typeof assessment.score).toBe("number");
    expect(Number.isFinite(assessment.score)).toBe(true);
    expect(assessment.pageCount).toBe(report.pageCount);
    expect(assessment.rubric.requirements.length).toBeGreaterThanOrEqual(6);
    expect(new Set(assessment.rubric.requirements.map((item) => item.importance))).toEqual(
      new Set(["essential", "desirable", "responsibility"]),
    );
    expect(assessment.review.claims.every((claim) => claim.status === "supported")).toBe(true);

    // What the model was actually given.
    const build = since();
    const rubricCalls = callsOf(build, "rubric");
    const authorCalls = callsOf(build, "author");
    const reviewCalls = callsOf(build, "review");
    expect(rubricCalls).toHaveLength(1);
    expect(rubricCalls[0]!.payload.description).toBe(DESCRIPTION);
    expect(rubricCalls[0]!.options?.timeout).toBe(120_000);
    // A plan that obeys the supplied allocations is written once; every retry is another 16k call.
    expect(authorCalls).toHaveLength(1);
    expect(content.fitNotes).toEqual([]);
    // The account's chosen model, and no advert or personal data in any system prompt.
    expect(build.every((call) => call.params.model === CV_MODEL)).toBe(true);
    expect(
      build.every((call) => (call.params.output_config as { effort: string }).effort === "high"),
    ).toBe(true);
    for (const call of build) {
      expect(call.system).not.toContain("Meridian Care Group");
      expect(call.system).not.toContain("Rowan Mercer");
    }

    const authored = authorCalls[0]!.payload;
    expect(authored.maxPages).toBe(MAX_PAGES);
    expect(authored.jobTitle).toBe("Head of Operations");
    expect(authored.company).toBe("Meridian Care Group");
    expect(authored.description).toBe(DESCRIPTION);
    expect(authored.rubric!.requirements.map((item) => item.id)).toEqual(
      assessment.rubric.requirements.map((item) => item.id),
    );
    expect(authored.writingBudget.blocks.map((block) => block.entryId)).toEqual(
      expect.arrayContaining(["ev-northwind-head", "ev-education", "ev-skills"]),
    );
    expect(authored.library.stylePreferences).toBe(STYLE_PREFERENCES);
    expect(authored.library.preferredWording).toBe(PREFERRED_WORDING);
    expect(authored.library.entries.length).toBeGreaterThan(0);
    expect(authored.layoutFeedback).toBeUndefined();
    // Appearance and identity are application concerns, never instructions for the model.
    const authorText = authorCalls[0]!.blocks.map((block) => block.text).join("");
    for (const key of ["theme", "name", "contact", "linkedinUrl"])
      expect(Object.keys(authored.library)).not.toContain(key);
    for (const key of ["theme", "name", "contact", "linkedinUrl"])
      expect(Object.keys(authored)).not.toContain(key);
    expect(authorText).not.toContain("Rowan Mercer");
    expect(authorText).not.toContain("rowan.mercer@example.test");
    expect(authorText).not.toContain("linkedin.com");
    expect(authorCalls[0]!.options?.timeout).toBe(300_000);

    // The audit: one cached prefix shared byte for byte, one varying batch each.
    const claimCount = cvClaimItems(content).length;
    const expectedBatches = Math.ceil(
      Math.max(assessment.rubric.requirements.length, claimCount) / REVIEW_BATCH_SIZE,
    );
    expect(expectedBatches).toBeGreaterThan(1);
    expect(reviewCalls).toHaveLength(expectedBatches);
    expect(reviewCalls.every((call) => call.payload.corrections === undefined)).toBe(true);
    // The evidence and rubric outlive a revision, so they are cached ahead of the CV, itself cached
    // ahead of the batch; every batch sends both shared blocks byte for byte.
    for (const cached of [0, 1]) {
      const shared = reviewCalls.map((call) => call.blocks[cached]!);
      expect(new Set(shared.map((block) => block.text)).size).toBe(1);
      expect(shared.every((block) => !!block.cache_control)).toBe(true);
    }
    expect(JSON.parse(reviewCalls[0]!.blocks[0]!.text)).toEqual({
      evidence: expect.any(Array),
      rubric: { caveats: assessment.rubric.caveats },
    });
    expect(JSON.parse(reviewCalls[0]!.blocks[1]!.text)).toEqual({ cv: expect.any(Array) });
    const varying = reviewCalls.map((call) => call.blocks[2]!);
    expect(new Set(varying.map((block) => block.text)).size).toBe(expectedBatches);
    expect(varying.every((block) => !block.cache_control)).toBe(true);
    expect(reviewCalls.every((call) => call.options?.timeout === 240_000)).toBe(true);
    expect(reviewCalls.every((call) => call.options?.signal instanceof AbortSignal)).toBe(true);
    // Each batch's requirements and claims are disjoint and cover the whole audit exactly once.
    expect(reviewCalls.flatMap((call) => call.payload.requirements.map((item) => item.id))).toEqual(
      assessment.rubric.requirements.map((item) => item.id),
    );
    expect(reviewCalls.flatMap((call) => call.payload.claims.map((item) => item.id))).toEqual(
      cvClaimItems(content).map((item) => item.id),
    );

    // The later batches went out while the first was still streaming, and only once it had begun.
    const leader = reviewCalls[0]!.index;
    const last = reviewCalls[reviewCalls.length - 1]!.index;
    expect(fake.events).not.toContain(`barrier-timeout:${leader}`);
    expect(fake.events).not.toContain("create-attempted");
    expect(fake.events.indexOf(`start:review:${leader}`)).toBeLessThan(
      fake.events.indexOf(`issue:review:${reviewCalls[1]!.index}`),
    );
    expect(fake.events.indexOf(`issue:review:${last}`)).toBeLessThan(
      fake.events.indexOf(`end:review:${leader}`),
    );

    // Every call is metered against the account.
    const metered = await aiCalls();
    expect(metered.length).toBe(build.length);
    expect(metered.every((row) => row.userId === user.id)).toBe(true);
    expect(metered.every((row) => row.ok && row.costUsd > 0 && row.model === CV_MODEL)).toBe(true);
    for (const refType of ["cv-rubric", "cv-author", "cv-review"])
      expect(metered.filter((row) => row.refType === refType).length).toBeGreaterThan(0);
    expect(metered.every((row) => row.refId === first.id)).toBe(true);

    // 4. Save Direct Edits: the wording is kept, only the assessment is redone.
    const experienceIndex = content.sections.findIndex(
      (section) => section.entryId === "ev-northwind-head",
    );
    const editedSummary =
      "Operations leader trusted with regulated healthcare delivery, supplier performance and the annual budget across a twelve-clinic portfolio.";
    const editedBullet =
      "Owned the operational plan for eleven community clinics and reported delivery, cost and quality to the executive team every month.";
    const editedBullets = [
      editedBullet,
      ...content.sections[experienceIndex]!.bullets.slice(1),
    ];
    markCalls();
    const edit = new FormData();
    edit.set("summary", editedSummary);
    edit.set(`section-${experienceIndex}`, editedBullets.join("\n"));
    edit.set("rememberWording", "on");
    await expect(saveCvDraft(first.id, { ok: true }, edit)).rejects.toThrow("redirect:/cv/");
    const editedDraft = await childOf(first.id);
    const [editTask] = await database
      .select()
      .from(schema.tasks)
      .where(sql`payload->>'draftId' = ${editedDraft.id}`);
    expect(editTask!.payload).toMatchObject({ mode: "assess" });
    expect(editTask!.payload.sourcePlan).toBeUndefined();

    expect(await runHandler(editedDraft.id)).toMatchObject({ ready: true });
    const edited = await draftRow(editedDraft.id);
    expect(edited.status).toBe("ready");
    expect(edited.content!.summary).toBe(editedSummary);
    expect(edited.content!.sections[experienceIndex]!.bullets).toEqual(editedBullets);
    expect(edited.assessment).toBeTruthy();
    expect(edited.assessment!.inputHash).not.toBe(assessment.inputHash);

    const editCalls = since();
    expect(callsOf(editCalls, "author")).toHaveLength(0);
    expect(callsOf(editCalls, "rubric")).toHaveLength(0);
    expect(callsOf(editCalls, "review")).toHaveLength(
      Math.ceil(
        Math.max(assessment.rubric.requirements.length, cvClaimItems(edited.content!).length) /
          REVIEW_BATCH_SIZE,
      ),
    );
    // The rubric was carried, not recomputed, and the batches saw the edited wording.
    expect(callsOf(editCalls, "review")[0]!.payload.cv.some((item) => item.text === editedBullet)).toBe(
      true,
    );
    // The library and rubric block is byte-identical to the build's, so the re-audit reads it from
    // cache; only the CV block changed.
    expect(callsOf(editCalls, "review")[0]!.blocks[0]!.text).toBe(reviewCalls[0]!.blocks[0]!.text);
    expect(callsOf(editCalls, "review")[0]!.blocks[1]!.text).not.toBe(reviewCalls[0]!.blocks[1]!.text);

    const [remembered] = await database
      .select()
      .from(schema.userSettings)
      .where(
        and(
          eq(schema.userSettings.userId, user.id),
          eq(schema.userSettings.key, "cvWritingPreferences"),
        ),
      );
    const storedWording = (remembered!.value as { preferredWording: string }).preferredWording;
    expect(storedWording).toContain(PREFERRED_WORDING);
    expect(storedWording).toContain(editedBullet);
    expect(storedWording).toContain(editedSummary);

    // 5. Rebuild from Library: fresh writing from the latest evidence, same rubric.
    const relibrary = new FormData();
    relibrary.set(
      "library",
      JSON.stringify(libraryFixture([...NORTHWIND_HEAD, NEW_RESPONSIBILITY])),
    );
    relibrary.set("version", "1");
    expect(await saveCvLibrary({ ok: true }, relibrary)).toEqual({ ok: true });

    markCalls();
    const rebuild = new FormData();
    rebuild.set("summary", edited.content!.summary);
    rebuild.set("intent", "improve");
    await expect(saveCvDraft(edited.id, { ok: true }, rebuild)).rejects.toThrow("redirect:/cv/");
    const rebuiltDraft = await childOf(edited.id);
    expect(rebuiltDraft.libraryVersion).toBe(2);
    expect(rebuiltDraft.content).toBeNull();
    expect(rebuiltDraft.jobDescription).toBe(DESCRIPTION);

    expect(await runHandler(rebuiltDraft.id)).toMatchObject({ ready: true });
    const rebuilt = await draftRow(rebuiltDraft.id);
    expect(rebuilt.status).toBe("ready");

    const rebuildCalls = since();
    expect(callsOf(rebuildCalls, "rubric")).toHaveLength(0);
    expect((await aiCalls()).filter((row) => row.refType === "cv-rubric")).toHaveLength(1);
    const rebuildAuthors = callsOf(rebuildCalls, "author");
    expect(rebuildAuthors).toHaveLength(1);
    expect(rebuilt.content!.fitNotes).toEqual([]);
    expect(callsOf(rebuildCalls, "review")).toHaveLength(
      Math.ceil(
        Math.max(assessment.rubric.requirements.length, cvClaimItems(rebuilt.content!).length) /
          REVIEW_BATCH_SIZE,
      ),
    );
    const rewritten = rebuildAuthors[0]!.payload;
    // Written afresh: no saved plan is seeded as layout feedback.
    expect(rewritten.layoutFeedback).toBeUndefined();
    // The system-owned improvements from the parent's assessment are carried in.
    expect(rewritten.improvements).toContain(LIBRARY_ONLY_IMPROVEMENT);
    expect(
      edited.assessment!.review.matches.some(
        (match) => match.improvement === LIBRARY_ONLY_IMPROVEMENT,
      ),
    ).toBe(true);
    // The latest library and the remembered wording.
    expect(
      rewritten.library.entries.find((entry) => entry.id === "ev-northwind-head")!.details,
    ).toContain(NEW_RESPONSIBILITY);
    expect(rewritten.library.preferredWording).toContain(editedBullet);
    expect(rewritten.library.stylePreferences).toBe(STYLE_PREFERENCES);
    expect(rewritten.rubric!.requirements.map((item) => item.quote)).toEqual(
      assessment.rubric.requirements.map((item) => item.quote),
    );

    // 6. Finalise, record the application and download the frozen bytes.
    const approve = new FormData();
    approve.set("reviewed", "on");
    expect(await finaliseCvDraft(rebuilt.id, { ok: true }, approve)).toEqual({ ok: true });
    expect((await draftRow(rebuilt.id)).finalisedAt).toBeTruthy();

    const application = new FormData();
    application.set("appliedOn", "2026-09-17");
    expect(await recordApplication(rebuilt.id, { ok: true }, application)).toEqual({ ok: true });
    const [recorded] = await database.select().from(schema.applications);
    expect(recorded!.cvId).toBe(rebuilt.id);
    expect(recorded!.jobTitle).toBe("Head of Operations");

    const response = await downloadApplication(
      new Request("http://localhost/api/applications/pdf"),
      { params: Promise.resolve({ id: recorded!.id }) },
    );
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.toString("base64")).toBe(recorded!.pdfBase64);

    // Nothing failed, nothing was cancelled, and the whole run is on the record.
    expect(fake.events.filter((event) => event.startsWith("cancel:"))).toHaveLength(0);
    expect(fake.events.filter((event) => event.startsWith("abort:"))).toHaveLength(0);
    expect((await aiCalls()).every((row) => row.ok)).toBe(true);
  });
});
