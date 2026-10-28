import { randomUUID } from "node:crypto";
import { CV_LIMITS, CV_SKILL_GUIDANCE, cvSkillIdentity } from "@col/core/cv-format";
import { CvContentSchema, CvLibrarySchema, isActiveStoredEvidence, type CvContent, type CvLibrary, type CvSkillSuggestion } from "@col/core";
import { cvReviewSkillSectionLimitIssue, cvReviewSuggestedSections, cvSuggestionAssignments, type CvSuggestionSkillTarget } from "./cv-review-edits";
import { UserFacingError } from "./validation";

const same = (a: string, b: string) => cvSkillIdentity(a) === cvSkillIdentity(b);

/** Only selected proposals enter a new Library version and the matching CV revision. */
export function acceptCvSkillSuggestions(library: CvLibrary, content: CvContent, selected: readonly CvSkillSuggestion[]) {
  const entries = structuredClone(library.entries);
  const targets: CvSuggestionSkillTarget[] = entries.flatMap(entry => entry.kind === "skill" && isActiveStoredEvidence(entry) && entry.skillItems?.length
    ? [{ id: entry.id, heading: entry.heading, items: entry.skillItems }] : []);
  const assignments = cvSuggestionAssignments(content.sections, selected, targets);
  const grouped = new Map<string, { heading: string; targetId?: string; labels: string[] }>();
  for (const { suggestion, heading, targetId } of assignments) {
    const key = targetId ?? `new:${cvSkillIdentity(heading)}`;
    const group = grouped.get(key) ?? { heading, targetId, labels: [] };
    group.labels.push(suggestion.label);
    grouped.set(key, group);
  }
  const actualTargets = [...targets];
  for (const { heading, targetId, labels } of grouped.values()) {
    // Legacy prose-only blocks have no canonical skill list. Keep them intact until the owner edits
    // them in the Library, rather than silently replacing their rendered contents with one label.
    let entry = targetId ? entries.find(item => item.id === targetId && item.kind === "skill") : undefined;
    const existingItems = entry?.skillItems ?? [];
    const skillItems = [...existingItems];
    for (const label of labels) if (!skillItems.some(held => same(held, label))) skillItems.push(label);
    if (skillItems.length > CV_SKILL_GUIDANCE.libraryPerSection) throw new UserFacingError(`${heading} has too many skills. Remove some before saving.`);
    if (entry) {
      entry.skillItems = skillItems;
    } else {
      if (entries.length >= 100) throw new UserFacingError("Your Experience has reached its section limit. Remove a section before saving skills.");
      entry = { id: `suggested-skill-${randomUUID()}`, kind: "skill", heading, details: skillItems.join("\n"), skillItems };
      entries.push(entry);
    }
    actualTargets.push({ id: entry.id, heading: entry.heading, items: entry.skillItems ?? [] });
  }
  const sections = cvReviewSuggestedSections(content.sections, selected, actualTargets);
  const sectionIssue = cvReviewSkillSectionLimitIssue(sections, content.sections);
  if (sectionIssue) throw new UserFacingError(sectionIssue);
  if (sections.length > CV_LIMITS.sections) throw new UserFacingError("This CV has reached its section limit. Remove a section before saving skills.");
  for (const section of sections) if (section.kind === "skill" && (section.skillItems ?? section.bullets).length > CV_LIMITS.skillsPerSection)
    throw new UserFacingError(`${section.heading} exceeds the CV skill limit. Choose fewer suggestions.`);
  return { library: CvLibrarySchema.parse({ ...library, entries }), content: CvContentSchema.parse({ ...content, sections }) };
}
