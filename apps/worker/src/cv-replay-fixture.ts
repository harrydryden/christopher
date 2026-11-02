/**
 * A synthetic draft for exercising the record → replay → grade gate without a key: a realistic
 * Library and advert, built once through the real handler against the scripted client
 * (`apps/web/test/scripted-ai-client.ts`), so the draft carries an assessment and a kept evidence
 * plan exactly as a published CV does. Used by `cv-replay.test.ts` and `scripts/cv-replay-fixture.mts`.
 * No real person's data: the candidate, the employers and the advert are invented.
 */
import { createUser, enqueueTask, schema, confirmCvTargetingPrioritiesForUser, type Db } from "@col/db";
import { dedupeKeyFor } from "@col/core";
import { CvLibrarySchema } from "@col/core/cv";
import type { CvRubric } from "@col/core/cv-assessment";
import { CvTargetingBriefSchema, cvEffectiveRubric, cvMappedEssentialOmissionIds, cvEssentialOmissionIds, cvRecommendedPriorityIds, projectCvWritingLibrary } from "@col/core/cv-targeting";
import { cvTargetingSource } from "@col/core/cv-targeting-identity";
import { CvTailoringPlanSchema } from "@col/core/cv-tailoring";
import { randomUUID } from "node:crypto";
import { CV_PROMPT_IDS, PROMPTS, promptSetVersion, resolveRoute, routedModel, type AiClientLike } from "@col/ai";
import { CV_FIT_VERSION, CV_RENDER_VERSION, cvAutoInputKey, cvEditingTargetsFor, cvRefinementDependencies, type CvAutoInputV1, type CvRefinementV1 } from "@col/core/cv-editing-modes";
import { CV_REVIEW_VERSION } from "@col/core/cv-assessment";
import { eq } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { TaskQueue } from "./queue";
import { handleGenerateCv } from "./handlers/cv";
import { onAbandon } from "./handlers/abandon";

export const REPLAY_FIXTURE_MODEL = "claude-fable-5-1";

/** A reproducible set of user edits, used by scripted and live preparation probes. */
export function rankedReplayFixtureRequirements(rubric: CvRubric) {
  return [
    { id: "u:00000000-0000-4000-8000-000000000031", text: "Lead weekly operational performance reviews", essential: true },
    ...rubric.requirements.slice().reverse().slice(0, -1).map((row, index) => ({
      id: row.id, text: index === 0 ? "Lead multi-site service delivery" : row.label,
      essential: index === 0 ? false : row.importance === "essential",
    })),
  ];
}

export const REPLAY_FIXTURE_DESCRIPTION = [
  "Head of Operations — Meridian Care Group",
  "",
  "We are hiring a Head of Operations to own service delivery for a portfolio of twelve sites and to lead a team of four operations managers.",
  "You will own the operational plan for the portfolio and report performance to the executive team each month.",
  "You will lead continuous improvement work across scheduling, rostering and supplier performance.",
  "You will partner with finance to build the annual budget and to track monthly variance.",
  "Candidates must have at least five years of experience leading operations in a regulated environment.",
  "You must be able to build and interpret reporting in SQL or a comparable analytics tool.",
  "Experience of supplier negotiation is preferred.",
  "A degree or equivalent professional qualification is required.",
  "",
  "We offer a competitive salary, a pension and twenty-eight days of holiday.",
].join("\n");

const HEAD = [
  "Own the operational plan for eleven community clinics, reporting delivery, cost and quality to the executive team every month.",
  "Lead four operations managers and a shared scheduling team of eighteen, running a weekly performance review against published measures.",
  "Rebuilt rostering around a single demand model, which cut agency spend by 22% in the first year.",
  "Partner with finance on the annual budget and on monthly variance across a £14m cost base.",
  "Introduced a supplier scorecard covering the eight largest contracts, with quarterly reviews against agreed service levels.",
];
const MANAGER = [
  "Ran day-to-day operations for four clinics, owning the rota, the patient flow and the site budget.",
  "Built the first operational reporting pack in SQL and Power BI, replacing a manual month-end spreadsheet.",
  "Managed the transition of two acquired clinics onto the group's systems and ways of working.",
];
const CALDER = [
  "Led a service desk of nine covering two distribution centres and a national customer base.",
  "Owned the service level agreement with the group's three largest retail customers and chaired the monthly review.",
  "Negotiated supplier renewals for courier and warehousing contracts worth £2m a year.",
];

export const REPLAY_FIXTURE_LIBRARY = {
  name: "Rowan Mercer",
  contact: "Manchester, UK · rowan.mercer@example.test",
  profile: "Operations leader with twelve years across regulated healthcare and logistics, accountable for multi-site service delivery, supplier performance and the annual operating budget.",
  employment: [
    { id: "emp-head", company: "Northwind Health", industryDescriptions: "Healthcare, Regulated services", jobTitle: "Head of Operations", startDate: "2021-04", endDate: "", current: true },
    { id: "emp-manager", company: "Northwind Health", industryDescriptions: "Healthcare, Regulated services", jobTitle: "Operations Manager", startDate: "2018-01", endDate: "2021-03", current: false },
    { id: "emp-calder", company: "Calder Logistics", industryDescriptions: "Logistics, Supply chain", jobTitle: "Service Delivery Lead", startDate: "2014-09", endDate: "2017-12", current: false },
  ],
  entries: [
    { id: "ev-head", kind: "experience" as const, employmentId: "emp-head", heading: "Head of Operations · Northwind Health", details: HEAD.join("\n"), confirmedResponsibilities: HEAD },
    { id: "ev-manager", kind: "experience" as const, employmentId: "emp-manager", heading: "Operations Manager · Northwind Health", details: MANAGER.join("\n"), confirmedResponsibilities: MANAGER },
    { id: "ev-calder", kind: "experience" as const, employmentId: "emp-calder", heading: "Service Delivery Lead · Calder Logistics", details: CALDER.join("\n"), confirmedResponsibilities: CALDER },
    { id: "ev-education", kind: "education" as const, heading: "Education", details: "BSc (Hons) Economics, University of Manchester, 2014\nPRINCE2 Practitioner, APMG International, 2019" },
    { id: "ev-skills", kind: "skill" as const, heading: "Systems and tools", details: "Reporting and planning systems used day to day.", skillItems: ["SQL", "Power BI", "NetSuite", "Process mapping", "Vendor management"] },
  ],
};

/**
 * The fixture draft, published: seeded for a fixture account (created once) and built through the
 * real queue and handler against `client`. Throws when it does not publish.
 */
export async function publishReplayFixture(deps: WorkerDeps, client: AiClientLike,
  email = "cv-replay-fixture@example.invalid", options: { targeted?: boolean; ranked?: boolean; mode?: "auto" | "refine" } = {}) {
  const [existing] = await deps.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  const user = existing ?? (await createUser(deps.db, { email, name: "Replay fixture", role: "member", emailVerified: true })).user;
  const draft = await seedReplayFixtureDraft(deps.db, user.id, options);
  const previous = { client: deps.aiClient, key: deps.env.anthropicApiKey };
  deps.aiClient = client;
  deps.env.anthropicApiKey ||= "scripted-client";
  try {
    await new TaskQueue(deps, { generate_cv: handleGenerateCv }, { concurrency: 1, workerId: "cv-replay-fixture", onAbandon }).drain();
    if (options.targeted) {
      const [paused] = await deps.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
      if (paused?.status !== "awaiting_priorities" || !paused.targetingBrief)
        throw new Error("The targeted fixture did not pause for owned priorities.");
      const brief = CvTargetingBriefSchema.parse(paused.targetingBrief);
      if (!brief.priority.rubric || !brief.priority.rubricKey || !paused.buildCheckpoint?.tailoringPlan)
        throw new Error("The targeted fixture has no rubric-bound evidence map to confirm.");
      const library = CvLibrarySchema.parse(paused.librarySnapshot);
      const plan = CvTailoringPlanSchema.parse(paused.buildCheckpoint.tailoringPlan);
      const entries = brief.entries.map(row => ({ ...row,
        treatment: row.entryId === "ev-manager" ? "summarise" as const
          : row.entryId === "ev-calder" ? "omit" as const : "feature" as const }));
      const writing = projectCvWritingLibrary(library, { ...brief, entries });
      // Exercise real user edits without changing the source advert or inventing candidate evidence.
      const requirements = options.ranked ? rankedReplayFixtureRequirements(brief.priority.rubric) : undefined;
      await confirmCvTargetingPrioritiesForUser(deps.db, user.id, draft.id, {
        expectedRevision: paused.revision, expectedSource: brief.source, expectedRubricKey: brief.priority.rubricKey,
        requestKey: randomUUID(), choices: { entries, presentation: { maxPages: 2, bodySizePt: 12 },
          emphasisRequirementIds: requirements ? requirements.slice(0, 5).map(row => row.id) : cvRecommendedPriorityIds(brief.priority.rubric),
          ...(requirements ? { requirements } : {}),
          acknowledgedEssentialOmissionIds: requirements
            ? cvMappedEssentialOmissionIds(plan, brief.priority.rubric, cvEffectiveRubric(brief.priority.rubric, requirements), writing)
            : cvEssentialOmissionIds(plan, brief.priority.rubric, writing) },
      });
      await new TaskQueue(deps, { generate_cv: handleGenerateCv }, { concurrency: 1,
        workerId: "cv-replay-fixture-resumed", onAbandon }).drain();
      if (options.ranked) {
        const [remapped] = await deps.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
        if (remapped?.status === "awaiting_priorities" && remapped.targetingBrief && remapped.buildCheckpoint?.tailoringPlan) {
          const current = CvTargetingBriefSchema.parse(remapped.targetingBrief);
          const effective = cvEffectiveRubric(current.priority.rubric!, current.priority.requirements);
          await confirmCvTargetingPrioritiesForUser(deps.db, user.id, draft.id, {
            expectedRevision: remapped.revision, expectedSource: current.source, expectedRubricKey: current.priority.rubricKey!,
            requestKey: randomUUID(), choices: { entries: current.entries, presentation: current.presentation,
              requirements: current.priority.requirements, emphasisRequirementIds: current.priority.emphasisRequirementIds,
              acknowledgedEssentialOmissionIds: cvEssentialOmissionIds(remapped.buildCheckpoint.tailoringPlan, effective,
                projectCvWritingLibrary(library, current)) },
          });
          // Only one extra confirmation is allowed: another pause is a continuation regression.
          await new TaskQueue(deps, { generate_cv: handleGenerateCv }, { concurrency: 1,
            workerId: "cv-replay-fixture-ranked-resumed", onAbandon }).drain();
        }
      }
    }
  } finally {
    deps.aiClient = previous.client;
    deps.env.anthropicApiKey = previous.key;
  }
  const [built] = await deps.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  if (built?.status !== "ready") throw new Error(`The fixture draft did not publish: ${built?.status} ${built?.error ?? ""}`);
  if (options.mode) return pinReplayFixtureMode(deps, built, options.mode);
  return built;
}

/** Give an invented, published source the same frozen mode inputs used by the actual replay. */
async function pinReplayFixtureMode(deps: WorkerDeps, draft: typeof schema.cvDrafts.$inferSelect, mode: "auto" | "refine") {
  if (!draft.content) throw new Error("The mode fixture needs a complete source CV.");
  const contextId = randomUUID(), descriptionVersionId = randomUUID(), baselineId = randomUUID();
  const targets = cvEditingTargetsFor(draft.content, randomUUID);
  const settings = await deps.settings();
  const routes = Object.fromEntries(CV_PROMPT_IDS.map(id => {
    const route = resolveRoute(PROMPTS[id], settings.stageRoutes);
    return [id, { model: routedModel(route, { cvModel: draft.model, callSite: draft.model }, draft.model), effort: route.effort }];
  })) as CvAutoInputV1["routes"];
  const contracts = { promptSet: promptSetVersion(), fit: CV_FIT_VERSION, render: CV_RENDER_VERSION, review: CV_REVIEW_VERSION };
  const snapshot: CvAutoInputV1 = { version: 1, contextId, descriptionVersionId, jobTitle: draft.jobTitle,
    companyName: draft.companyName, description: draft.jobDescription, library: draft.librarySnapshot,
    basePriorityIdentity: "source-default", appearance: draft.librarySnapshot.theme, writingPreferences: {}, routes, contracts };
  const refinements: CvRefinementV1[] = [{ id: randomUUID(), version: 1, order: 0, kind: "instruction",
    target: { type: "summary", id: targets.summaryId },
    text: "Keep the summary concise and emphasise confirmed operational leadership. Do not add facts.",
    reset: false, dependencies: { descriptionVersionId, ...cvRefinementDependencies({ content: draft.content,
      targets, library: draft.librarySnapshot, descriptionVersionId, target: { type: "summary", id: targets.summaryId } }) } }];
  if (draft.targetingBrief) {
    const brief = CvTargetingBriefSchema.parse(draft.targetingBrief);
    const structured = { kind: "targeting" as const, choices: { entries: brief.entries,
      presentation: brief.presentation, emphasisRequirementIds: brief.priority.emphasisRequirementIds,
      ...(brief.priority.requirements ? { requirements: brief.priority.requirements } : {}),
      acknowledgedEssentialOmissionIds: brief.priority.acknowledgedEssentialOmissionIds } };
    refinements.push({ id: randomUUID(), version: 1, order: 1, kind: "structured", target: { type: "selection" },
      structured, reset: false, dependencies: { descriptionVersionId, ...cvRefinementDependencies({ content: draft.content,
        targets, library: draft.librarySnapshot, descriptionVersionId, target: { type: "selection" }, structured }) } });
  }
  return deps.db.transaction(async tx => {
    await tx.insert(schema.cvApplicationContexts).values({ id: contextId, userId: draft.userId,
      requestKey: `fixture:${randomUUID()}`, jobTitle: draft.jobTitle, companyName: draft.companyName });
    await tx.insert(schema.cvContextDescriptions).values({ id: descriptionVersionId, contextId,
      userId: draft.userId, version: 1, text: draft.jobDescription, source: draft.jobSource });
    await tx.update(schema.cvApplicationContexts).set({ currentDescriptionVersionId: descriptionVersionId,
      selectedKind: "draft", selectedId: draft.id }).where(eq(schema.cvApplicationContexts.id, contextId));
    if (mode === "auto") await tx.insert(schema.cvAutoBaselines).values({ id: baselineId, userId: draft.userId,
      contextId, descriptionVersionId, inputSnapshot: snapshot, inputKey: cvAutoInputKey(snapshot),
      engineContract: { ...contracts, routes }, sourceDraftId: draft.id, status: "ready", content: draft.content,
      librarySnapshot: draft.librarySnapshot, assessment: draft.assessment, editingTargets: targets, publishedAt: deps.now() });
    const [updated] = await tx.update(schema.cvDrafts).set({ contextId, descriptionVersionId, editingMode: mode,
      editingTargets: targets, ...(mode === "auto" ? { autoBaselineId: baselineId } : {
        refinementSnapshot: refinements, refinementSourceContent: draft.content, refinementSourceTargets: targets,
        refinementEngineContract: { ...contracts, routes }, refinementOriginKind: "baseline" as const,
      }) }).where(eq(schema.cvDrafts.id, draft.id)).returning();
    return updated!;
  });
}

/** A queued, planned draft for `userId`, with its build task: drain the queue to publish it. */
export async function seedReplayFixtureDraft(db: Db, userId: string, options: { targeted?: boolean } = {}) {
  const library = CvLibrarySchema.parse(REPLAY_FIXTURE_LIBRARY);
  const targetingBrief = options.targeted ? CvTargetingBriefSchema.parse({ version: 1,
    source: cvTargetingSource(1, library, REPLAY_FIXTURE_DESCRIPTION),
    entries: library.entries.map(entry => ({ entryId: entry.id, treatment: "feature" as const })),
    presentation: { maxPages: 2, bodySizePt: 12 },
    priority: { state: "unprepared", emphasisRequirementIds: [], acknowledgedEssentialOmissionIds: [] },
  }) : null;
  const [draft] = await db.insert(schema.cvDrafts).values({
    userId, jobTitle: "Head of Operations", companyName: "Meridian Care Group", jobDescription: REPLAY_FIXTURE_DESCRIPTION,
    libraryVersion: 1, librarySnapshot: REPLAY_FIXTURE_LIBRARY, model: REPLAY_FIXTURE_MODEL,
    targetingBrief,
    // Planned, with the optional questions already answered, so the build runs straight through to
    // publication, keeps its plan and tries the optional improvement.
    buildCheckpoint: { tailoringEnabled: true, quizCompleted: true },
  }).returning();
  const payload = { draftId: draft!.id, userId };
  await enqueueTask(db, "generate_cv", payload, { dedupeKey: dedupeKeyFor("generate_cv", payload) });
  return draft!;
}
