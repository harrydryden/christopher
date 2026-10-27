import { CV_SKILL_GUIDANCE } from "@col/core/cv-format";

/** A broad saved Library is useful; the per-CV recommendation is a selection, not a Library limit. */
export function CvLibrarySkillGuidance({ count }: { count: number }) {
  return <p className="text-12 text-muted" role="status">
    {count} saved {count === 1 ? "skill" : "skills"}. Keep a broad collection here; choose about {CV_SKILL_GUIDANCE.recommendedHighlightedTotal} relevant skills for each CV.
  </p>;
}
