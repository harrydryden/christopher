import { and, eq } from "drizzle-orm";
import { CvLibrarySchema } from "@col/core/cv";
import { CvTargetingBriefSchema, CvTargetingChoicesSchema, cvEssentialOmissionIds,
  projectCvTargetedContent,
  type CvTargetingChoices,
  projectCvWritingLibrary, validateCvTargetingEntries, cvRankedPriorityChoices, cvEffectiveRubric,
  cvMappedEssentialOmissionIds, cvPriorityMappingIdentity } from "@col/core/cv-targeting";
import { cvTargetingSource } from "@col/core/cv-targeting-identity";
import { CvTailoringPlanSchema, cvTailoringEvidence, validateCvTailoringPlan } from "@col/core/cv-tailoring";
import type { Db } from "./client";
import { cvDrafts } from "./schema";
import { lockCvDraft } from "./cv-lifecycle";
import { enqueueTask } from "./tasks";

export class CvTargetingConfirmationError extends Error {}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type ConfirmationInput = { expectedRevision: number; expectedSource: { libraryVersion: number; evidenceHash: string; jobDescriptionHash: string };
  expectedRubricKey: string; requestKey: string; choices: CvTargetingChoices };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ConfirmationOptions = { recoverFailedPageFit?: boolean; beforeDraftLock?: (tx: Tx) => Promise<void>;
  beforeQueue?: (tx: Tx, draft: typeof cvDrafts.$inferSelect) => Promise<void> };

/** Account-scoped transaction shared by the verified web action and synthetic replay fixture. */
export async function confirmCvTargetingPrioritiesForUser(db: Db, userId: string, draftId: string, raw: ConfirmationInput,
  options: ConfirmationOptions = {}): Promise<void> {
  const data = raw;
  if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 0
    || !CvTargetingBriefSchema.shape.source.safeParse(data.expectedSource).success
    || !/^[a-f0-9]{64}$/.test(data.expectedRubricKey)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.requestKey)
    || !CvTargetingChoicesSchema.safeParse(data.choices).success)
    throw new CvTargetingConfirmationError("Reload the CV and choose its current priorities.");
  await db.transaction(async tx => {
    await options.beforeDraftLock?.(tx);
    await lockCvDraft(tx, draftId);
    const [draft] = await tx.select().from(cvDrafts)
      .where(and(eq(cvDrafts.id, draftId), eq(cvDrafts.userId, userId))).limit(1).for("update");
    if (!draft?.targetingBrief) throw new CvTargetingConfirmationError("This CV could not be found. Reload it.");
    const brief = CvTargetingBriefSchema.parse(draft.targetingBrief);
    const sourceRubric = brief.priority.rubric;
    if (!sourceRubric) throw new CvTargetingConfirmationError("The original role priorities are unavailable. Reload this CV.");
    let requirements: ReturnType<typeof cvRankedPriorityChoices> | undefined;
    try { requirements = data.choices.requirements ? cvRankedPriorityChoices(sourceRubric, data.choices.requirements) : undefined; }
    catch (error) { throw new CvTargetingConfirmationError((error as Error).message); }
    const emphasis = requirements ? requirements.slice(0, 5).map(item => item.id) : data.choices.emphasisRequirementIds;
    if (requirements && !same(emphasis, data.choices.emphasisRequirementIds))
      throw new CvTargetingConfirmationError("The ranked priorities changed. Reload this CV before confirming.");
    if (draft.revision !== data.expectedRevision || !same(brief.source, data.expectedSource)
      || !same(brief.source, cvTargetingSource(draft.libraryVersion, CvLibrarySchema.parse(draft.librarySnapshot), draft.jobDescription))
      || brief.priority.rubricKey !== data.expectedRubricKey)
      throw new CvTargetingConfirmationError("The role or Experience changed. Reload this CV before confirming priorities.");
    if (brief.priority.state === "confirmed" && brief.priority.confirmationKey === data.requestKey) {
      if (!same(brief.entries, data.choices.entries) || !same(brief.presentation, data.choices.presentation)
        || !same(brief.priority.emphasisRequirementIds, data.choices.emphasisRequirementIds)
        || !same(brief.priority.requirements ?? null, requirements ?? null)
        || !same(brief.priority.acknowledgedEssentialOmissionIds, data.choices.acknowledgedEssentialOmissionIds))
        throw new CvTargetingConfirmationError("This confirmation was already used for different choices. Reload this CV.");
      if (draft.status === "failed")
        throw new CvTargetingConfirmationError("This failed build needs a new retry request. Reload its choices and try again.");
      return;
    }
    const recovering = options.recoverFailedPageFit === true && draft.status === "failed"
      && draft.failure?.kind === "page_limit_unfittable" && brief.priority.state === "confirmed";
    if (!recovering && (draft.status !== "awaiting_priorities" || brief.priority.state !== "awaiting_priorities"))
      throw new CvTargetingConfirmationError("These priorities were already confirmed or are no longer available.");
    const library = CvLibrarySchema.parse(draft.librarySnapshot);
    if (data.choices.entries.some(row => !library.entries.some(entry => entry.id === row.entryId)))
      throw new CvTargetingConfirmationError("Experience changed. Reload the CV before choosing sections.");
    try { validateCvTargetingEntries(library, data.choices.entries); }
    catch (error) { throw new CvTargetingConfirmationError((error as Error).message); }
    const previousRequirements = cvRankedPriorityChoices(sourceRubric, brief.priority.requirements);
    const nextRequirements = requirements ?? previousRequirements;
    const mappedRequirements = brief.priority.mappedRequirements;
    const mappedRubric = mappedRequirements ? cvEffectiveRubric(sourceRubric, mappedRequirements) : sourceRubric;
    const fullPlan = draft.buildCheckpoint?.tailoringPlan
      ? CvTailoringPlanSchema.parse(draft.buildCheckpoint.tailoringPlan) : null;
    if (!brief.priority.rubric || !brief.priority.rubricKey || !fullPlan)
      throw new CvTargetingConfirmationError("The role's priorities and evidence map are not ready. Reload this CV.");
    if (!projectCvWritingLibrary(library, { ...brief, entries: data.choices.entries }).entries.length)
      throw new CvTargetingConfirmationError("Keep at least one Experience or qualification section in this CV.");
    validateCvTailoringPlan(fullPlan, mappedRubric, cvTailoringEvidence(library), library);
    const proposedRubric = requirements ? cvEffectiveRubric(sourceRubric, requirements) : mappedRubric;
    const omitted = cvMappedEssentialOmissionIds(fullPlan, mappedRubric, proposedRubric,
      projectCvWritingLibrary(library, { ...brief, entries: data.choices.entries }));
    const acknowledgements = new Set(data.choices.acknowledgedEssentialOmissionIds);
    if (omitted.some(id => !acknowledgements.has(id)))
      throw new CvTargetingConfirmationError("Acknowledge the essential requirements that your omitted evidence demonstrates before continuing.");
    if (data.choices.acknowledgedEssentialOmissionIds.some(id => !omitted.includes(id)))
      throw new CvTargetingConfirmationError("The essential requirements changed. Reload this CV.");
    const priority = { state: "confirmed" as const, rubric: brief.priority.rubric, rubricKey: brief.priority.rubricKey,
      emphasisRequirementIds: emphasis, ...(requirements ? { requirements } : {}),
      mappedRequirements: mappedRequirements ?? cvRankedPriorityChoices(sourceRubric),
      acknowledgedEssentialOmissionIds: data.choices.acknowledgedEssentialOmissionIds,
      confirmationKey: data.requestKey };
    CvTargetingBriefSchema.shape.priority.parse(priority);
    let next = CvTargetingBriefSchema.parse({ ...brief, entries: data.choices.entries,
      presentation: data.choices.presentation, priority });
    let projected: ReturnType<typeof projectCvTargetedContent> | null = null;
    if (recovering && draft.content) {
      try { projected = projectCvTargetedContent(draft.content, next, brief); }
      catch (error) { throw new CvTargetingConfirmationError((error as Error).message); }
    }
    if (projected) next = CvTargetingBriefSchema.parse({ ...next, manualSections: projected.manualSections });
    await options.beforeQueue?.(tx, draft);
    const changedRanking = !!requirements && cvPriorityMappingIdentity(nextRequirements)
      !== cvPriorityMappingIdentity(mappedRequirements ?? cvRankedPriorityChoices(sourceRubric));
    const buildCheckpoint = changedRanking && draft.buildCheckpoint ? { ...draft.buildCheckpoint,
      tailoringPlan: undefined,
      stages: Object.fromEntries(Object.entries(draft.buildCheckpoint.stages ?? {}).filter(([name]) => name !== "plan")),
    } : draft.buildCheckpoint;
    await tx.update(cvDrafts).set({ targetingBrief: next, status: "queued", buildStage: null, progressAt: null,
      error: null, failure: null,
      ...(projected ? { content: projected.content, assessment: null, reviewDecision: null,
        buildCheckpoint: {
          v: buildCheckpoint?.v, promptSetVersion: buildCheckpoint?.promptSetVersion, stages: {},
          tailoringEnabled: buildCheckpoint?.tailoringEnabled,
          tailoringPlan: buildCheckpoint?.tailoringPlan,
          quizCompleted: buildCheckpoint?.quizCompleted,
          rubric: buildCheckpoint?.rubric, rubricAt: buildCheckpoint?.rubricAt,
          mode: "assess" as const, sourceRubric: buildCheckpoint?.sourceRubric,
        } } : { buildCheckpoint }) })
      .where(eq(cvDrafts.id, draftId));
    await enqueueTask(tx, "generate_cv", { draftId, userId, ...(projected ? { mode: "assess" as const } : {}) },
      { dedupeKey: recovering ? `generate_cv:${draftId}:targeting-retry:${data.requestKey}`
        : `generate_cv:${draftId}:priorities-confirmed`, priority: 2 });
  });
}
