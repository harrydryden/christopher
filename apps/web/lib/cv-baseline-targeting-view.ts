import type { CvAutoInputV1 } from "@col/core/cv-editing-modes";
import type { CvContent, CvLibrary } from "@col/core/cv";
import type { CvAssessment } from "@col/core/cv-assessment";
import type { CvTailoringPlan } from "@col/core/cv-tailoring";
import { cvRankedPriorityChoices, type CvTargetingView } from "@col/core/cv-targeting";
import { cvTargetingSource } from "@col/core/cv-targeting-identity";
import { cvTargetingEvidenceEntryIds, cvTargetingHasProfileEvidence } from "@/lib/cv-targeting-choices";

/** A published Auto baseline keeps its rubric and evidence map after its producer draft is pruned. */
export function cvBaselineTargetingView(input: { id: string; content: CvContent; library: CvLibrary;
  assessment: CvAssessment | null; plan: CvTailoringPlan | null; snapshot: CvAutoInputV1 }): CvTargetingView | null {
  if (!input.assessment) return null;
  const rubric = input.assessment.rubric;
  const priorities = cvRankedPriorityChoices(rubric);
  const mapped = new Map(input.plan?.requirements.map(row => [row.requirementId, row]) ?? []);
  return {
    draftId: input.id, revision: 0, status: "unprepared",
    source: cvTargetingSource(1, input.library, input.snapshot.description),
    entries: input.library.entries.map(entry => ({ entryId: entry.id, kind: entry.kind, heading: entry.heading,
      ...(entry.company ? { company: entry.company } : {}), treatment: "feature" as const })),
    priorities: priorities.map((row, index) => ({ ...rubric.requirements.find(item => item.id === row.id)!,
      text: row.text, essential: row.essential, rank: index + 1, origin: "role" as const,
      customised: false, selected: index < 5,
      evidenceEntryIds: cvTargetingEvidenceEntryIds(mapped.get(row.id)?.evidence ?? []),
      hasProfileEvidence: cvTargetingHasProfileEvidence(mapped.get(row.id)?.evidence ?? []),
    })),
    essentialOmissionIds: [], acknowledgedEssentialOmissionIds: [], summaryNeedsReview: false,
    presentation: { maxPages: input.content.theme?.maxPages ?? 2,
      bodySizePt: input.content.theme?.bodySizePt === 11 ? 11 : 12 },
  };
}
