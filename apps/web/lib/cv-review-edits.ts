import type { CvContent } from "@ava/core/cv";

export type AddedSkillSection = { entryId: string; heading: string; items: string[] };

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
    const edited = lines(rows[index] ?? (section.skillItems ?? section.bullets).join("\n"));
    if (section.kind === "skill" && edited.length === 0) return [];
    const before = section.skillItems ?? section.bullets;
    const changed = JSON.stringify(edited) !== JSON.stringify(before);
    if (!changed) return [section];
    return [{
      ...section,
      ...(section.skillItems ? { skillItems: edited, bullets: edited } : { bullets: edited }),
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
    return [{ entryId, kind: "skill" as const, heading: heading.trim() || "Skills", skillItems, bullets: skillItems }];
  });
  return [...existing, ...added];
}
