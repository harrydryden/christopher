import type { CvContent } from "@ava/core/cv";
import { CV_LIMITS, cvSectionTexts } from "@ava/core/cv-format";

export type AddedSkillSection = { entryId: string; heading: string; items: string[] };

export function cvReviewSkillLimitIssue(sections: CvContent["sections"]): string | null {
  const over = sections.find((section) => section.kind === "skill" && cvSectionTexts(section).length > CV_LIMITS.skillsPerSection);
  return over ? `${over.heading} has more than ${CV_LIMITS.skillsPerSection} skills. Remove some before saving or previewing.` : null;
}

export function cvReviewSkillCharacterIssue(sections: CvContent["sections"]): string | null {
  const over = sections.find((section) => section.kind === "skill" && cvSectionTexts(section)
    .some(item => item.length > CV_LIMITS.skillCharacters));
  return over ? `${over.heading} has a skill longer than ${CV_LIMITS.skillCharacters} characters. Shorten it before saving or previewing.` : null;
}

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

/** Build the exact sections that a review preview and a direct save will use. */
export function cvReviewSections(
  saved: CvContent,
  rows: string[],
  removedSkillIds: string[],
  addedSkills: AddedSkillSection[],
): CvContent["sections"] {
  const removed = new Set(removedSkillIds);
  if (removedSkillIds.some((id) => !saved.sections.some((section) => section.kind === "skill" && section.entryId === id)))
    throw new Error("Only skill sections can be removed here.");
  const existing = saved.sections.flatMap((section, index) => {
    if (removed.has(section.entryId)) return [];
    const before = section.kind === "skill" ? section.skillItems ?? cvSectionTexts(section) : section.bullets;
    const edited = lines(rows[index] ?? before.join("\n"));
    if (section.kind === "skill" && edited.length === 0) return [];
    const changed = JSON.stringify(edited) !== JSON.stringify(before);
    if (!changed) return [section];
    return [{
      ...section,
      ...(section.kind === "skill" ? { skillItems: edited, bullets: edited.slice(0, CV_LIMITS.bulletsPerSection) } : { bullets: edited }),
      bulletSources: undefined,
    }];
  });
  const seen = new Set(saved.sections.map((section) => section.entryId));
  const added = addedSkills.flatMap(({ entryId, heading, items }) => {
    if (!/^manual-skill-[0-9a-f-]{36}$/.test(entryId) || seen.has(entryId))
      throw new Error("The new skill section has an invalid identifier. Add it again.");
    seen.add(entryId);
    const skillItems = items.map((item) => item.trim()).filter(Boolean);
    if (!skillItems.length) return [];
    return [{ entryId, kind: "skill" as const, heading: heading.trim() || "Skills", skillItems, bullets: skillItems.slice(0, CV_LIMITS.bulletsPerSection) }];
  });
  return [...existing, ...added];
}
