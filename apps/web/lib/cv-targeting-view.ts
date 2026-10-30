import { CvContentSchema, CvLibrarySchema } from "@col/core/cv";
import { CvTailoringPlanSchema, cvTailoringEvidence, validateCvTailoringPlan } from "@col/core/cv-tailoring";
import { CvTargetingBriefSchema, cvEssentialOmissionIds, cvRecommendedPriorityIds,
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
  const rubric = brief?.priority.rubric ?? draft.assessment?.rubric ?? draft.buildCheckpoint?.sourceRubric;
  if (!rubric) return null;
  const [storedPlan] = await db().select({ plan: cvTailoringPlans.plan }).from(cvTailoringPlans)
    .where(and(eq(cvTailoringPlans.draftId, draftId), eq(cvTailoringPlans.userId, userId))).limit(1);
  const planCandidate = storedPlan?.plan ?? draft.buildCheckpoint?.tailoringPlan;
  const fullPlan = planCandidate ? validateCvTailoringPlan(CvTailoringPlanSchema.parse(planCandidate), rubric,
    cvTailoringEvidence(library), library) : null;
  const selected = new Set(brief?.priority.state === "confirmed"
    ? brief.priority.emphasisRequirementIds : cvRecommendedPriorityIds(rubric));
  const mapped = new Map(fullPlan?.requirements.map(row => [row.requirementId, row]) ?? []);
  const writing = brief ? projectCvWritingLibrary(library, brief) : library;
  return {
    draftId, revision: draft.revision, status: brief?.priority.state ?? "unprepared", source,
    rubricKey: brief?.priority.rubricKey ?? cvTargetingAdoptionKey(source, rubric, draft.model,
      draft.assessment?.version ?? "stored-rubric"),
    entries: library.entries.map(entry => ({ entryId: entry.id, kind: entry.kind, heading: entry.heading,
      ...(entry.company ? { company: entry.company } : {}),
      treatment: brief?.entries.find(row => row.entryId === entry.id)?.treatment ?? "feature" })),
    priorities: rubric.requirements.map(item => ({ ...item, selected: selected.has(item.id),
      evidenceEntryIds: cvTargetingEvidenceEntryIds(mapped.get(item.id)?.evidence ?? []),
      hasProfileEvidence: cvTargetingHasProfileEvidence(mapped.get(item.id)?.evidence ?? []) })),
    essentialOmissionIds: fullPlan && brief ? cvEssentialOmissionIds(fullPlan, rubric, writing) : [],
    acknowledgedEssentialOmissionIds: brief?.priority.acknowledgedEssentialOmissionIds ?? [],
    summaryNeedsReview: !!brief && !!draft.content && cvTargetingSummaryNeedsReview(CvContentSchema.parse(draft.content), brief),
    presentation: brief?.presentation ?? { maxPages: draft.content?.theme?.maxPages ?? 2, bodySizePt: 12 },
  };
}
