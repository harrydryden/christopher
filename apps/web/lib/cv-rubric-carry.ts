import { validateCvRubric } from "@col/core/cv-review";

type RubricSource = {
  jobDescription: string;
  assessment?: { rubric: unknown } | null;
  buildCheckpoint?: { sourceRubric?: unknown } | null;
};

/** Carry only a verified role rubric; evidence plans and review results belong to the old revision. */
export function cvRevisionRubricCheckpoint(source: RubricSource, nextJobDescription: string) {
  if (source.jobDescription !== nextJobDescription) return null;
  for (const candidate of [source.assessment?.rubric, source.buildCheckpoint?.sourceRubric]) {
    if (!candidate) continue;
    try { return { sourceRubric: validateCvRubric(nextJobDescription, candidate) }; }
    catch { /* An invalid old rubric must be extracted afresh. */ }
  }
  return null;
}
