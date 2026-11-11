/** Browser-safe CV contract. PDFKit is imported only through the server entry point. */
import type { CvContent } from "./cv";
export const CV_SKILL_GUIDANCE = {
  libraryPerSection: 20,
  cvPerSection: 10,
  recommendedHighlightedTotal: 10,
  suggestionCandidatePoolLimit: 16,
  suggestionPreferredWords: 2,
  suggestionMaxWords: 3,
} as const;
export const CV_LIMITS = { bulletsPerSection: 6, skillsPerSection: CV_SKILL_GUIDANCE.cvPerSection, skillSections: 5, sections: 20, skillCharacters: 150, bulletCharacters: 650, summaryCharacters: 1800 } as const;
/** Match the trimmed label accepted by the Library and CV schemas in every editor. */
export function cvSkillCharacterState(value: string) {
  const count = value.trim().length;
  const tooLong = count > CV_LIMITS.skillCharacters;
  return { count, tooLong, approaching: !tooLong && count >= Math.ceil(CV_LIMITS.skillCharacters * 0.8) };
}
/** The page limit is a user preference captured in each CV's theme; these bound what Settings offers. */
export const CV_PAGE_LIMITS = { min: 1, max: 5, default: 3 } as const;
export const CV_PAGE_CHOICES: readonly number[] = Array.from(
  { length: CV_PAGE_LIMITS.max - CV_PAGE_LIMITS.min + 1 },
  (_, index) => CV_PAGE_LIMITS.min + index,
);
export const CV_SUPPORTING_GROUPS = [
  { kind: "education", title: "Education" },
  { kind: "training", title: "Training" },
  { kind: "skill", title: "Skills" },
  { kind: "interest", title: "Interests" },
] as const;
export const CV_GROUPS = [{ kind: "experience", title: "Experience" }, ...CV_SUPPORTING_GROUPS] as const;
export type CvSectionKind = typeof CV_GROUPS[number]["kind"];
export type CvSupportingKind = typeof CV_SUPPORTING_GROUPS[number]["kind"];
export const CV_SECTION_ORDER = Object.fromEntries(CV_GROUPS.map((group, index) => [group.kind, index])) as Record<CvSectionKind, number>;

/** Presentation reorders existing sections, never copies a contribution or changes its sources. */
export function cvDisplayGroups(content: CvContent) {
  const indexed = content.sections.map((section, index) => ({ section, index }));
  const experience = indexed.filter(item => item.section.kind === "experience");
  const mode = content.theme?.experienceLayout ?? "chronological";
  const byId = new Map(experience.map(item => [item.section.entryId, item.section.career]));
  const isProject = (item: typeof indexed[number]) => item.section.career?.kind === "project" ||
    (item.section.career?.groupRecordId && byId.get(item.section.career.groupRecordId)?.kind === "project");
  const chronology = (items: typeof indexed) => [...items].sort((left, right) => {
    const a = left.section.career, b = right.section.career;
    // Old saved CVs keep the exact order their original snapshot had.
    if (!a || !b) return left.index - right.index;
    const groupA = byId.get(a.groupRecordId ?? "") ?? a;
    const groupB = byId.get(b.groupRecordId ?? "") ?? b;
    const key = (record: NonNullable<typeof a>) => record.dates.current ? "9999" : record.dates.end ?? record.dates.start ?? "";
    const order = key(groupB).localeCompare(key(groupA));
    if (order) return order;
    if (a.groupRecordId === b.recordId) return 1;
    if (b.groupRecordId === a.recordId) return -1;
    return left.index - right.index;
  });
  const projects = experience.filter(isProject);
  const roles = experience.filter(item => !isProject(item));
  const groups: Array<{ kind: CvSectionKind; title: string; sections: typeof indexed }> = [];
  // A project view needs actual project records. With none, retain the available Experience.
  if (mode === "chronological" || !projects.length) {
    if (experience.length) groups.push({ kind: "experience", title: "Experience", sections: chronology(experience) });
  } else {
    const projectGroup = { kind: "experience" as const, title: "Projects", sections: projects };
    const roleGroup = { kind: "experience" as const, title: "Experience", sections: chronology(roles) };
    if (mode === "project") groups.push(projectGroup, ...(roles.length ? [roleGroup] : []));
    else groups.push(...(roles.length ? [roleGroup] : []), projectGroup);
  }
  for (const group of CV_SUPPORTING_GROUPS) {
    const sections = indexed.filter(item => item.section.kind === group.kind);
    if (sections.length) groups.push({ ...group, sections });
  }
  return groups;
}

/** Names only the selected supporting kinds, in the same order as the editor and PDF. */
export function cvSupportingTitle(kinds: Iterable<string>): string | null {
  const present = new Set(kinds);
  const names = CV_SUPPORTING_GROUPS.filter(group => present.has(group.kind)).map(group => group.title);
  if (!names.length) return null;
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Counts a skill once even when it is highlighted in several categories. */
export function cvSkillIdentity(label: string): string {
  return label.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-GB");
}
export function countDistinctCvSkills(labels: readonly string[]): number {
  return new Set(labels.map(cvSkillIdentity).filter(Boolean)).size;
}

export const cleanCvText = (value: string) =>
  value
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
type CvSectionText = {
  kind: string;
  heading: string;
  bullets: string[];
  skillItems?: string[];
  bulletSignposts?: Array<string | null>;
};
export function cvSectionHeading(section: CvSectionText): string | null {
  if (section.kind === "skill") return null;
  return cleanCvText(section.heading);
}
export function cvSectionTexts(section: CvSectionText): string[] {
  const values =
    section.skillItems ??
    (section.kind === "skill"
      ? section.bullets.flatMap((bullet) => bullet.split(" · "))
      : section.bullets.map((bullet, index) => section.bulletSignposts?.[index]
        ? `${section.bulletSignposts[index]} · ${bullet}` : bullet));
  return values.map(cleanCvText).filter(Boolean);
}
