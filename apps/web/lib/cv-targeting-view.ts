import { CvContentSchema, CvLibrarySchema } from "@col/core/cv";
import { CvTailoringPlanSchema, cvTailoringEvidence, validateCvTailoringPlan } from "@col/core/cv-tailoring";
import { CvTargetingBriefSchema, cvEffectiveRubric, cvPriorityMappingIdentity, cvRankedPriorityChoices,
  cvMappedEssentialOmissionIds, cvRecommendedPriorityIds, cvRecommendedPriorityOrder,
  cvTargetingSummaryNeedsReview, projectCvWritingLibrary, type CvTargetingView } from "@col/core/cv-targeting";
import { cvTargetingAdoptionKey, cvTargetingSource } from "@col/core/cv-targeting-identity";
import { cvTailoringPlans } from "@col/db";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getOwnCvDraft } from "@/lib/queries/cv";
import { cvTargetingEvidenceEntryIds, cvTargetingHasProfileEvidence } from "@/lib/cv-targeting-choices";

type OwnedDraft = NonNullable<Awaited<ReturnType<typeof getOwnCvDraft>>>;

/** Account-owned view; no unverified source text is sent merely to render the controls. */
export async function getCvTargetingView(userId: string, draftId: string): Promise<CvTargetingView | null> {
  const draft = await getOwnCvDraft(userId, draftId);
  return draft ? cvTargetingViewForOwnedDraft(userId, draft) : null;
}

/** Caller has already checked account ownership; only the plan still needs a scoped read. */
export async function cvTargetingViewForOwnedDraft(userId: string, draft: OwnedDraft): Promise<CvTargetingView | null> {
  const draftId = draft.id;
  if (draft.userId !== userId || (!draft.content && draft.status !== "awaiting_priorities"
    && !(draft.status === "failed" && draft.failure?.kind === "page_limit_unfittable"))) return null;
  const library = CvLibrarySchema.parse(draft.librarySnapshot);
  const source = cvTargetingSource(draft.libraryVersion, library, draft.jobDescription);
  const brief = draft.targetingBrief ? CvTargetingBriefSchema.parse(draft.targetingBrief) : null;
  if (brief && JSON.stringify(brief.source) !== JSON.stringify(source)) return null;
  const rubric = brief ? brief.priority.rubric
    : draft.buildCheckpoint?.sourceRubric ?? draft.assessment?.rubric;
  if (!rubric) return null;
  const [storedPlan] = await db().select({ plan: cvTailoringPlans.plan }).from(cvTailoringPlans)
    .where(and(eq(cvTailoringPlans.draftId, draftId), eq(cvTailoringPlans.userId, userId))).limit(1);
  const planCandidate = draft.buildCheckpoint?.tailoringPlan ?? storedPlan?.plan;
  const mappedRows = brief?.priority.mappedRequirements;
  const mappedRubric = mappedRows ? cvEffectiveRubric(rubric, mappedRows) : rubric;
  const currentRows = brief?.priority.requirements ?? cvRankedPriorityChoices(rubric);
  const mappingCurrent = cvPriorityMappingIdentity(mappedRows ?? cvRankedPriorityChoices(rubric))
    === cvPriorityMappingIdentity(currentRows);
  let fullPlan = null;
  if (planCandidate && mappingCurrent) try {
    fullPlan = validateCvTailoringPlan(CvTailoringPlanSchema.parse(planCandidate), mappedRubric,
      cvTailoringEvidence(library), library);
  } catch { /* A changed criterion cannot inherit the prior map's evidence. */ }
  const initialPriorityIds = brief?.priority.state === "confirmed"
    ? brief.priority.emphasisRequirementIds : cvRecommendedPriorityOrder(rubric);
  const legacyOrder = !brief?.priority.requirements
    ? [...initialPriorityIds, ...rubric.requirements.map(item => item.id)
      .filter(id => !initialPriorityIds.includes(id))] : undefined;
  const ranked = cvEffectiveRubric(rubric, brief?.priority.requirements ?? legacyOrder?.map(id =>
    cvRankedPriorityChoices(rubric).find(item => item.id === id)!));
  const selected = new Set(brief?.priority.requirements
    ? ranked.requirements.slice(0, 5).map(item => item.id)
    : brief?.priority.state === "confirmed" ? brief.priority.emphasisRequirementIds : cvRecommendedPriorityIds(rubric));
  const mapped = new Map(fullPlan?.requirements.map(row => [row.requirementId, row]) ?? []);
  const writing = brief ? projectCvWritingLibrary(library, brief) : library;
  return {
    draftId, revision: draft.revision, status: brief?.priority.state ?? "unprepared", source,
    rubricKey: brief?.priority.rubricKey ?? cvTargetingAdoptionKey(source, rubric, draft.model,
      draft.assessment?.version ?? "stored-rubric"),
    entries: library.entries.map(entry => ({ entryId: entry.id, kind: entry.kind, heading: entry.heading,
      ...(entry.company ? { company: entry.company } : {}),
      treatment: brief?.entries.find(row => row.entryId === entry.id)?.treatment ?? "feature" })),
    priorities: ranked.requirements.map(item => ({ ...item, text: item.label, essential: item.importance === "essential",
      rank: item.rank, origin: item.origin, customised: item.customised, selected: selected.has(item.id),
      evidenceEntryIds: cvTargetingEvidenceEntryIds(mapped.get(item.id)?.evidence ?? []),
      hasProfileEvidence: cvTargetingHasProfileEvidence(mapped.get(item.id)?.evidence ?? []) })),
    essentialOmissionIds: fullPlan && brief ? cvMappedEssentialOmissionIds(fullPlan, mappedRubric, ranked, writing) : [],
    acknowledgedEssentialOmissionIds: brief?.priority.acknowledgedEssentialOmissionIds ?? [],
    summaryNeedsReview: !!brief && !!draft.content && cvTargetingSummaryNeedsReview(CvContentSchema.parse(draft.content), brief),
    presentation: brief?.presentation ?? { maxPages: draft.content?.theme?.maxPages ?? 2, bodySizePt: 12 },
  };
}
