import type { CvContent } from "./cv";
import { CV_LIMITS, CV_SKILL_GUIDANCE } from "./cv-format";

/** Wording visible in the Write editor. It helps tailor skills but is never grounding evidence. */
export function cvSkillDraftContext(content: CvContent) {
  return {
    summary: content.summary.trim(),
    sections: content.sections.map(section => ({ kind: section.kind, heading: section.heading,
      bullets: section.bullets, ...(section.skillItems ? { skillItems: section.skillItems } : {}) })),
  };
}

export type CvSkillDraftContext = ReturnType<typeof cvSkillDraftContext>;
export const MAX_CV_SKILL_DRAFT_CONTEXT_BYTES = 60_000;

/** Fail closed on old or malformed queued task payloads without importing a browser schema. */
export function isCvSkillDraftContext(value: unknown): value is CvSkillDraftContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<CvSkillDraftContext>;
  return typeof context.summary === "string" && context.summary.length <= CV_LIMITS.summaryCharacters
    && Array.isArray(context.sections) && context.sections.length <= CV_LIMITS.sections
    && context.sections.every(section => section && typeof section === "object"
      && ["experience", "education", "training", "skill", "interest"].includes(section.kind)
      && typeof section.heading === "string" && section.heading.length <= 250
      && Array.isArray(section.bullets) && section.bullets.length <= CV_LIMITS.bulletsPerSection
      && section.bullets.every(item => typeof item === "string" && item.length <= CV_LIMITS.bulletCharacters)
      && (section.skillItems === undefined || (section.kind === "skill" && Array.isArray(section.skillItems)
        && section.skillItems.length <= CV_SKILL_GUIDANCE.libraryPerSection
        && section.skillItems.every(item => typeof item === "string" && item.length <= CV_LIMITS.skillCharacters))));
}

export function cvDraftContextHighlightedSkills(context: CvSkillDraftContext) {
  return context.sections.flatMap(section => section.kind === "skill"
    ? [{ category: section.heading, labels: section.skillItems ?? section.bullets }] : []);
}
