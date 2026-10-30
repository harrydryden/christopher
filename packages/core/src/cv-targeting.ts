import { z } from "zod";
import { CvRubricSchema, type CvAssessment, type CvRubric } from "./cv-assessment";
import { CvContentSchema, type CvContent, type CvLibrary } from "./cv";
import { resolveCvTheme } from "./cv-theme";
import { cvEntryTreatment, cvTargetingSummaryNeedsReview, projectCvTargetedSections } from "./cv-targeting-projection";
export { cvEntryTreatment, cvTargetingSummaryNeedsReview } from "./cv-targeting-projection";
import { cvTailoringEvidence, validateCvTailoringPlan, type CvTailoringPlan } from "./cv-tailoring";

export const CvEntryTreatmentSchema = z.enum(["feature", "summarise", "omit"]);
export type CvEntryTreatment = z.infer<typeof CvEntryTreatmentSchema>;
export const CvTargetingChoicesSchema = z.object({
  entries: z.array(z.object({ entryId: z.string().min(1).max(100), treatment: CvEntryTreatmentSchema }))
    .max(100).refine(rows => new Set(rows.map(row => row.entryId)).size === rows.length, "Choose each entry once."),
  presentation: z.object({ maxPages: z.number().int().min(1).max(5), bodySizePt: z.union([z.literal(11), z.literal(12)]) }),
  emphasisRequirementIds: z.array(z.string().min(1).max(40)).max(5),
  acknowledgedEssentialOmissionIds: z.array(z.string().min(1).max(40)).max(30),
});
export type CvTargetingChoices = z.infer<typeof CvTargetingChoicesSchema>;

export const CvTargetingBriefSchema = z.object({
  version: z.literal(1),
  source: z.object({
    libraryVersion: z.number().int().positive(),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    jobDescriptionHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  entries: z.array(z.object({
    entryId: z.string().min(1).max(100),
    treatment: CvEntryTreatmentSchema,
  })).max(100).refine(rows => new Set(rows.map(row => row.entryId)).size === rows.length,
    "Choose each Experience entry once."),
  presentation: z.object({
    maxPages: z.number().int().min(1).max(5),
    bodySizePt: z.union([z.literal(11), z.literal(12)]),
  }),
  priority: z.object({
    state: z.enum(["unprepared", "awaiting_priorities", "confirmed"]),
    rubric: CvRubricSchema.optional(),
    rubricKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    emphasisRequirementIds: z.array(z.string().min(1).max(40)).max(5),
    acknowledgedEssentialOmissionIds: z.array(z.string().min(1).max(40)).max(30),
    confirmationKey: z.string().uuid().optional(),
  }).superRefine((priority, ctx) => {
    if (priority.state !== "unprepared" && (!priority.rubric || !priority.rubricKey))
      ctx.addIssue({ code: "custom", message: "Prepared priorities require their exact role rubric." });
    if (priority.state === "confirmed") {
      const ids = new Set(priority.rubric?.requirements.map(item => item.id));
      const max = Math.min(5, priority.rubric?.requirements.length ?? 0);
      if (priority.emphasisRequirementIds.length < Math.min(3, max) || priority.emphasisRequirementIds.length > max
        || new Set(priority.emphasisRequirementIds).size !== priority.emphasisRequirementIds.length
        || priority.emphasisRequirementIds.some(id => !ids.has(id)))
        ctx.addIssue({ code: "custom", message: "Confirm three to five current role priorities, or all available priorities if fewer." });
    }
  }),
  /** Unprojected, attributed wording for Feature restoration on this CV only. */
  manualSections: CvContentSchema.shape.sections.optional(),
  saveRequestKey: z.string().uuid().optional(),
});
export type CvTargetingBriefV1 = z.infer<typeof CvTargetingBriefSchema>;

export type CvTargetingView = {
  draftId: string;
  revision: number;
  status: "unprepared" | "awaiting_priorities" | "confirmed";
  source: CvTargetingBriefV1["source"];
  rubricKey?: string;
  entries: Array<{ entryId: string; kind: CvLibrary["entries"][number]["kind"];
    heading: string; company?: string; treatment: CvEntryTreatment }>;
  priorities: Array<CvRubric["requirements"][number] & { selected: boolean; evidenceEntryIds: string[];
    hasProfileEvidence?: boolean }>;
  essentialOmissionIds: string[];
  acknowledgedEssentialOmissionIds: string[];
  summaryNeedsReview: boolean;
  presentation: CvTargetingBriefV1["presentation"];
};

/** Recommendation only; every essential remains visible and scored regardless of selection. */
export function cvRecommendedPriorityIds(rubric: CvRubric): string[] {
  const weight = (item: CvRubric["requirements"][number]) =>
    (item.importance === "essential" ? 4 : item.importance === "desirable" ? 2 : 0)
      + (item.category === "logistics" ? -3 : 0);
  return [...rubric.requirements].sort((a, b) => weight(b) - weight(a))
    .slice(0, Math.min(5, rubric.requirements.length)).map(item => item.id);
}

export function validateCvTargetingEntries(library: CvLibrary,
  entries: readonly { entryId: string; treatment: CvEntryTreatment }[]): void {
  for (const row of entries) {
    const source = library.entries.find(entry => entry.id === row.entryId);
    if (!source) throw new Error("A chosen Experience entry is no longer available.");
    if (row.treatment === "summarise" && source.kind !== "experience" && source.kind !== "interest")
      throw new Error("Only experience and interests can be summarised; feature or omit qualifications and skill categories.");
  }
}

/** Filtering is by stable entry ID; source rows and their original indices are never rewritten. */
export function projectCvWritingLibrary(library: CvLibrary, brief: CvTargetingBriefV1 | null | undefined): CvLibrary {
  if (!brief) return library;
  validateCvTargetingEntries(library, brief.entries);
  const entries = library.entries.filter(entry => cvEntryTreatment(brief, entry.id) !== "omit");
  const hasOmission = entries.length !== library.entries.length;
  return { ...library, entries,
    ...(hasOmission ? { profile: "" } : {}),
    theme: { ...resolveCvTheme(library.theme), maxPages: brief.presentation.maxPages,
      bodySizePt: brief.presentation.bodySizePt },
    ...(library.employment ? { employment: library.employment.filter(job => entries.some(entry => entry.employmentId === job.id)) } : {}) };
}

/** Suggestions share the writer's eligible source set and preserve every source row ID. */
export function cvEligibleSkillLibrary(library: CvLibrary, brief: CvTargetingBriefV1 | null | undefined): CvLibrary {
  return projectCvWritingLibrary(library, brief);
}

export function cvSkillSourcePolicy(brief: CvTargetingBriefV1 | null | undefined): string {
  return brief ? JSON.stringify({ source: brief.source, entries: brief.entries.map(row => ({
    entryId: row.entryId, treatment: row.treatment,
  })) }) : "legacy";
}

/** Omitted evidence may stay in the full factual audit, but cannot ground the printed summary. */
export function cvTargetedSummaryFinalisationIssue(content: CvContent, brief: CvTargetingBriefV1 | null | undefined,
  assessment: CvAssessment | null | undefined): string | null {
  if (!brief?.entries.some(row => row.treatment === "omit")) return null;
  const omitted = new Set(brief.entries.filter(row => row.treatment === "omit").map(row => row.entryId));
  const forbidden = (id: string) => id === "source:profile" || [...omitted].some(entryId =>
    id === `entry:${entryId}` || id.startsWith(`entry:${entryId}:`));
  if (content.summarySources?.some(forbidden))
    return "Edit the summary to remove claims from omitted Experience, then check this revision again.";
  const summary = assessment?.review.claims.find(claim => claim.claimId === "profile");
  if (!summary || summary.status !== "supported" || !summary.evidence.some(ref => !forbidden(ref.id)))
    return "Check the edited summary against included Experience before finalising this CV.";
  return null;
}

/** A full-evidence plan stays durable; the writer receives only citations still eligible here. */
export function projectCvWritingPlan(fullPlan: CvTailoringPlan, rubric: CvRubric, library: CvLibrary): CvTailoringPlan {
  const allowed = new Set(cvTailoringEvidence(library).map(row => row.id));
  const projected: CvTailoringPlan = { ...fullPlan,
    requirements: fullPlan.requirements.map(row => {
      const evidence = row.evidence.filter(ref => allowed.has(ref.sourceId));
      return evidence.length || row.status === "missing" || row.status === "unknown"
        ? { ...row, evidence }
        : { ...row, status: "missing", evidence: [], reason: "Supporting evidence was omitted from this CV." };
    }),
    gapQuestions: fullPlan.gapQuestions.filter(question => {
      const destination = question.suggestedDestination;
      return rubric.requirements.some(item => item.id === question.requirementId)
        && (destination.kind === "employment"
          ? !!library.employment?.some(job => job.id === destination.employmentId)
          : library.entries.some(entry => entry.id === destination.entryId));
    }),
  };
  return validateCvTailoringPlan(projected, rubric, cvTailoringEvidence(library), library);
}

/** Exact mapped essentials whose positive evidence would disappear on an explicit omission. */
export function cvEssentialOmissionIds(fullPlan: CvTailoringPlan, rubric: CvRubric, library: CvLibrary): string[] {
  const essentials = new Set(rubric.requirements.filter(item => item.importance === "essential").map(item => item.id));
  const allowed = new Set(cvTailoringEvidence(library).map(row => row.id));
  return fullPlan.requirements.filter(row => essentials.has(row.requirementId) && row.evidence.length > 0
    && !row.evidence.some(ref => allowed.has(ref.sourceId))).map(row => row.requirementId);
}

/** Immediate, model-free projection of the person's existing wording for a saved CV revision. */
export function projectCvTargetedContent(content: CvContent, brief: CvTargetingBriefV1,
  previousBrief?: CvTargetingBriefV1 | null): {
  content: CvContent; manualSections: CvContent["sections"]; summaryNeedsReview: boolean;
} {
  const projected = projectCvTargetedSections(content, brief, previousBrief);
  return { content: CvContentSchema.parse({ ...content, sections: projected.sections,
    theme: { ...resolveCvTheme(content.theme), maxPages: brief.presentation.maxPages, bodySizePt: brief.presentation.bodySizePt } }),
    manualSections: projected.manualSections, summaryNeedsReview: projected.summaryNeedsReview };
}
