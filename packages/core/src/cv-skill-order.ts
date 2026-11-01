import type { CvContent, CvLibrary, CvPlan } from "./cv";
import { CV_LIMITS, CV_SKILL_GUIDANCE, cvSectionTexts, cvSkillIdentity } from "./cv-format";

/** A validated CV revision's preference, not an instruction to add any skill to a new build. */
export type CvSkillOrderHint = Array<{ entryId: string; items: string[] }>;

/** A checkpoint is JSONB, so validate its bounded shape again before using it on a retry. */
export function cvValidSkillOrderHint(value: unknown): CvSkillOrderHint | undefined {
  if (!Array.isArray(value) || value.length > CV_LIMITS.sections) return undefined;
  const seen = new Set<string>();
  const rows: CvSkillOrderHint = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || typeof row.entryId !== "string" || !row.entryId || seen.has(row.entryId)
      || !Array.isArray(row.items) || row.items.length > CV_SKILL_GUIDANCE.libraryPerSection
      || row.items.some((item: unknown) => typeof item !== "string" || !item.trim() || item.length > CV_LIMITS.skillCharacters))
      return undefined;
    seen.add(row.entryId);
    rows.push({ entryId: row.entryId, items: [...row.items] });
  }
  return rows;
}

export function cvSkillOrderHint(content: CvContent): CvSkillOrderHint {
  return content.sections.filter(section => section.kind === "skill")
    .map(section => ({ entryId: section.entryId, items: [...(section.skillItems ?? cvSectionTexts(section))] }));
}

function selectedItemOrder(items: readonly string[], preferred: readonly string[]): string[] {
  const remaining = [...items];
  const ordered: string[] = [];
  for (const label of preferred) {
    const index = remaining.findIndex(item => cvSkillIdentity(item) === cvSkillIdentity(label));
    if (index >= 0) ordered.push(...remaining.splice(index, 1));
  }
  return [...ordered, ...remaining];
}

/** Reorder only matching skill slots in a working copy; other evidence keeps its chronology. */
export function cvOrderedSkillLibrary(library: CvLibrary, hint: CvSkillOrderHint | undefined): CvLibrary {
  if (!hint?.length) return library;
  const rank = new Map(hint.map((row, index) => [row.entryId, index]));
  const ordered = library.entries.filter(entry => entry.kind === "skill")
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (rank.get(a.entry.id) ?? Infinity) - (rank.get(b.entry.id) ?? Infinity) || a.index - b.index)
    .map(({ entry }) => entry);
  let skillIndex = 0;
  return { ...library, entries: library.entries.map(entry => entry.kind === "skill" ? ordered[skillIndex++]! : entry) };
}

/** Preserve order among labels the writer actually selected; never restore an omitted label. */
export function cvOrderedSkillPlan(plan: CvPlan, hint: CvSkillOrderHint | undefined): CvPlan {
  if (!hint?.length) return plan;
  const byId = new Map(hint.map(row => [row.entryId, row.items]));
  return { ...plan, sections: plan.sections.map(section => {
    const preferred = byId.get(section.entryId);
    if (!preferred || !section.skillItems) return section;
    // Bullets and their source rows are one cited unit. Skill items drive the printed pills, so
    // moving them must not silently attach an old bullet citation to a different claim.
    return { ...section, skillItems: selectedItemOrder(section.skillItems, preferred) };
  }) };
}
