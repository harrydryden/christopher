import { validateCvRubric } from "@col/core/cv-review";

type RubricSource = {
  jobDescription: string;
  assessment?: { rubric: unknown } | null;
  buildCheckpoint?: { sourceRubric?: unknown } | null;
  targetingBrief?: { priority?: { rubric?: unknown; requirements?: unknown } } | null;
};

/** Carry only a verified role rubric; evidence plans and review results belong to the old revision. */
export function cvRevisionRubricCheckpoint(source: RubricSource, nextJobDescription: string) {
  if (source.jobDescription !== nextJobDescription) return null;
  // A ranked assessment may contain member-edited or added requirements. Its brief retains the
  // original employer-quoted rubric; never promote the effective assessment to a source rubric.
  const ranked = Array.isArray(source.targetingBrief?.priority?.requirements);
  const candidates = [source.targetingBrief?.priority?.rubric,
    ...(!ranked ? [source.assessment?.rubric] : []), source.buildCheckpoint?.sourceRubric];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return { sourceRubric: validateCvRubric(nextJobDescription, candidate) }; }
    catch { /* An invalid old rubric must be extracted afresh. */ }
  }
  return null;
}
