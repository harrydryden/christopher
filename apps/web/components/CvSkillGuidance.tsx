import { countDistinctCvSkills, CV_SKILL_GUIDANCE } from "@col/core/cv-format";

/** The Library can be broad; each CV highlights a smaller, role-specific selection. */
export function CvSkillGuidance({ context, labels }: { context: "library" | "cv"; labels: readonly string[] }) {
  const count = context === "library" ? labels.filter(label => label.trim()).length : countDistinctCvSkills(labels);
  return <p className="text-12 text-muted" role="status">
    {context === "library"
      ? <>{count} saved {count === 1 ? "skill" : "skills"}. Keep a broad collection here; choose about {CV_SKILL_GUIDANCE.recommendedHighlightedTotal} relevant skills for each CV.</>
      : <>{count} highlighted {count === 1 ? "skill" : "skills"} on this CV. Aim for about {CV_SKILL_GUIDANCE.recommendedHighlightedTotal} relevant skills across categories; use fewer or more when the role and your evidence call for it.</>}
  </p>;
}
