import type { CvContent, CvLibrary } from "@col/core/cv";
import { isActiveStoredEvidence } from "@col/core/cv-helpers";
import type { CvSkillSuggestion } from "@col/core";
import { CV_LIMITS, cvSectionTexts, cvSkillCharacterState, cvSkillIdentity } from "@col/core/cv-format";

export type AddedSkillSection = { entryId: string; heading: string; items: string[]; sourceEntryId?: string };
export type LibrarySupportSection = { id: string; kind: "education" | "training" | "interest"; heading: string; bullets: string[]; issue?: string };

/** One canonical projection for the editor preview, suggestion input and direct save. */
export function cvReviewEditedContent(saved: CvContent, edits: {
  summary: string;
  theme: CvContent["theme"];
  rows: string[];
  removedSkillIds: string[];
  addedSkills: AddedSkillSection[];
  skillHeadings: Readonly<Record<string, string>>;
  bulletSignposts?: Readonly<Record<string, readonly (string | null)[]>>;
  addedSupportIds: string[];
}, available: readonly LibrarySupportSection[]): CvContent {
  const summary = edits.summary.trim();
  const content: CvContent = {
    ...saved,
    theme: edits.theme,
    summary,
    sections: cvReviewSupportingSections(
      cvReviewSections(saved, edits.rows, edits.removedSkillIds, edits.addedSkills, edits.skillHeadings, edits.bulletSignposts),
      edits.addedSupportIds,
      available,
    ),
  };
  if (summary !== saved.summary) delete content.summarySources;
  delete content.fitNotes;
  return content;
}

/** Saved supporting evidence that can be deliberately included in this CV review. */
export function librarySupportSections(library: CvLibrary): LibrarySupportSection[] {
  return library.entries.flatMap(entry => {
    if (!["education", "training", "interest"].includes(entry.kind) || !isActiveStoredEvidence(entry)) return [];
    const bullets = entry.details.split(/\n+/).map(line => line.trim()).filter(Boolean);
    const issue = !bullets.length ? "Add details in Experience before including this section."
      : bullets.length > CV_LIMITS.bulletsPerSection || bullets.some(line => line.length > CV_LIMITS.bulletCharacters)
        ? "Shorten this section in Experience before including it; no details will be cut off." : undefined;
    return [{ id: entry.id, kind: entry.kind as LibrarySupportSection["kind"], heading: entry.heading, bullets, ...(issue ? { issue } : {}) }];
  });
}

/** An explicit review action; canonical labels containing commas stay whole until it is chosen. */
export function splitCvReviewSkillRow(items: string[], index: number): string[] | null {
  const value = items[index];
  if (value === undefined) return null;
  const split = value.split(/[,;\n]| · /).map(item => item.replace(/^\s*(?:(?:[-*•▪‣]|\d+[.)])\s*)+/, "").trim()).filter(Boolean);
  return split.length > 1 ? [...items.slice(0, index), ...split, ...items.slice(index + 1)] : null;
}

export function cvReviewSkillLimitIssue(sections: CvContent["sections"]): string | null {
  const over = sections.find((section) => section.kind === "skill" && cvSectionTexts(section).length > CV_LIMITS.skillsPerSection);
  return over ? `${over.heading} has more than ${CV_LIMITS.skillsPerSection} skills. Remove some before saving or previewing.` : null;
}

/** Existing older CVs may already exceed the new cap; editing them must not add another section. */
export function cvReviewSkillSectionLimitIssue(sections: CvContent["sections"], saved: CvContent["sections"] = []): string | null {
  const skillCount = (items: CvContent["sections"]) => items.filter(section => section.kind === "skill").length;
  return skillCount(sections) > Math.max(CV_LIMITS.skillSections, skillCount(saved))
    ? `This CV supports up to ${CV_LIMITS.skillSections} skill sections. Remove one before adding another.` : null;
}

export function cvReviewSkillCharacterIssue(sections: CvContent["sections"]): string | null {
  const over = sections.find((section) => section.kind === "skill" && (section.skillItems ?? cvSectionTexts(section))
    .some(item => cvSkillCharacterState(item).tooLong));
  return over ? `${over.heading} has a skill longer than ${CV_LIMITS.skillCharacters} characters. Shorten it before saving or previewing.` : null;
}

const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

/** Keep a signpost with its claim when prose lines move, rather than with its old row number. */
export function reconcileCvBulletSignposts(before: string, after: string, labels: readonly (string | null)[]): {
  labels: (string | null)[]; cleared: boolean;
} {
  const oldLines = lines(before);
  const newLines = lines(after);
  const positions = new Map<string, number[]>();
  oldLines.forEach((line, index) => positions.set(line, [...(positions.get(line) ?? []), index]));
  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();
  const next = newLines.map((line, newIndex) => {
    const oldIndex = positions.get(line)?.shift();
    if (oldIndex === undefined) return null;
    matchedOld.add(oldIndex);
    matchedNew.add(newIndex);
    return labels[oldIndex] ?? null;
  });
  const unmatchedOld = oldLines.flatMap((_, index) => matchedOld.has(index) ? [] : [index]);
  const unmatchedNew = newLines.flatMap((_, index) => matchedNew.has(index) ? [] : [index]);
  // One line changed in place: retain its deliberately entered label. A deletion, insertion or
  // ambiguous multi-line replacement cannot safely inherit a label from another claim.
  if (oldLines.length === newLines.length && unmatchedOld.length === 1 && unmatchedNew.length === 1
    && unmatchedOld[0] === unmatchedNew[0]) {
    next[unmatchedNew[0]!] = labels[unmatchedOld[0]!] ?? null;
    matchedOld.add(unmatchedOld[0]!);
  }
  let ambiguousCleared = false;
  for (const line of new Set(oldLines)) {
    const oldIndices = oldLines.flatMap((value, index) => value === line ? [index] : []);
    const newIndices = newLines.flatMap((value, index) => value === line ? [index] : []);
    if (oldIndices.length <= 1 || newIndices.length === oldIndices.length || !newIndices.length) continue;
    if (new Set(oldIndices.map(index => labels[index] ?? null)).size <= 1) continue;
    for (const index of newIndices) next[index] = null;
    ambiguousCleared = true;
  }
  return { labels: next, cleared: ambiguousCleared || oldLines.some((line, index) =>
    !!labels[index] && !matchedOld.has(index) &&
    !newLines.some((remaining, position) => remaining === line && next[position] === labels[index])) };
}

/** Build the exact sections that a review preview and a direct save will use. */
export function cvReviewSections(
  saved: CvContent,
  rows: string[],
  removedSkillIds: string[],
  addedSkills: AddedSkillSection[],
  skillHeadings: Readonly<Record<string, string>> = {},
  bulletSignposts: Readonly<Record<string, readonly (string | null)[]>> = {},
): CvContent["sections"] {
  const removed = new Set(removedSkillIds);
  if (removedSkillIds.some((id) => !saved.sections.some((section) => section.kind !== "experience" && section.entryId === id)))
    throw new Error("Only supporting sections can be removed here.");
  const existing = saved.sections.flatMap((section, index) => {
    if (removed.has(section.entryId)) return [];
    const before = section.kind === "skill" ? section.skillItems ?? cvSectionTexts(section) : section.bullets;
    const edited = lines(rows[index] ?? before.join("\n"));
    if (section.kind === "skill" && edited.length === 0) return [];
    const heading = section.kind === "skill" ? (skillHeadings[section.entryId] ?? section.heading).trim() : section.heading;
    if (section.kind === "skill" && (!heading || heading.length > 250))
      throw new Error("Give each skill section a heading of 1 to 250 characters.");
    const textChanged = JSON.stringify(edited) !== JSON.stringify(before);
    const suppliedSignposts = bulletSignposts[section.entryId];
    const alignedSignposts = suppliedSignposts ?? reconcileCvBulletSignposts(before.join("\n"), edited.join("\n"),
      section.bulletSignposts ?? []).labels;
    const signposts = section.kind === "skill" ? undefined : edited.map((_, bulletIndex) =>
      alignedSignposts[bulletIndex]?.trim() || null);
    const nextSignposts = signposts?.some(Boolean) ? signposts : undefined;
    const signpostsChanged = JSON.stringify(nextSignposts ?? null) !== JSON.stringify(section.bulletSignposts ?? null);
    const changed = heading !== section.heading || textChanged || signpostsChanged;
    if (!changed) return [section];
    return [{
      ...section,
      ...(section.kind === "skill" ? { heading, skillItems: edited, bullets: edited.slice(0, CV_LIMITS.bulletsPerSection) } : { bullets: edited }),
      ...(textChanged ? { bulletSources: undefined } : {}),
      ...(section.kind !== "skill" ? { bulletSignposts: nextSignposts } : {}),
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

export function cvReviewSupportingSections(sections: CvContent["sections"], selectedIds: readonly string[], available: readonly LibrarySupportSection[]): CvContent["sections"] {
  const seen = new Set(sections.map(section => section.entryId));
  const added = selectedIds.flatMap(id => {
    const source = available.find(item => item.id === id);
    if (!source) throw new Error("A supporting section is no longer available. Refresh this CV.");
    if (source.issue) throw new Error(source.issue);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ entryId: source.id, kind: source.kind, heading: source.heading, bullets: source.bullets }];
  });
  if (sections.length + added.length > 20) throw new Error("This CV has reached its section limit.");
  return [...sections, ...added];
}

export type CvSuggestionSkillTarget = { id: string; heading: string; items: readonly string[] };
const sameSkill = (a: string, b: string) => cvSkillIdentity(a) === cvSkillIdentity(b);

/** One ordering and global-label rule shared by the preview and the committed Library/CV merge. */
export function cvSuggestionAssignments(sections: CvContent["sections"], selected: readonly CvSkillSuggestion[],
  skillTargets: readonly CvSuggestionSkillTarget[]): Array<{ suggestion: CvSkillSuggestion; targetId?: string; heading: string }> {
  const held = sections.filter(section => section.kind === "skill").flatMap(section => section.skillItems ?? cvSectionTexts(section));
  const assignments: Array<{ suggestion: CvSkillSuggestion; targetId?: string; heading: string }> = [];
  for (const suggestion of selected) {
    if (held.some(label => sameSkill(label, suggestion.label))) continue;
    held.push(suggestion.label);
    const target = skillTargets.find(entry => entry.items.some(label => sameSkill(label, suggestion.label)))
      ?? skillTargets.find(entry => sameSkill(entry.heading, suggestion.category));
    assignments.push({ suggestion, targetId: target?.id, heading: target?.heading ?? suggestion.category });
  }
  return assignments;
}

/** A preview-only projection; the server assigns Library entry IDs when the selection is saved. */
export function cvReviewSuggestedSections(sections: CvContent["sections"], selected: readonly CvSkillSuggestion[],
  skillTargets: readonly CvSuggestionSkillTarget[] = []): CvContent["sections"] {
  const projected = structuredClone(sections);
  const byCategory = new Map<string, { heading: string; targetId?: string; labels: string[]; firstId: string }>();
  for (const { suggestion, targetId, heading } of cvSuggestionAssignments(sections, selected, skillTargets)) {
    const key = targetId ?? `new:${cvSkillIdentity(heading)}`;
    const group = byCategory.get(key) ?? { heading, targetId, labels: [], firstId: suggestion.id };
    group.labels.push(suggestion.label);
    byCategory.set(key, group);
  }
  for (const { heading, targetId, labels, firstId } of byCategory.values()) {
    const existing = targetId ? projected.find(section => section.kind === "skill" && section.entryId === targetId) : undefined;
    if (existing) {
      const held = existing.skillItems ?? cvSectionTexts(existing);
      const merged = [...held];
      for (const label of labels) if (!merged.some(item => sameSkill(item, label))) merged.push(label);
      existing.skillItems = merged; existing.bullets = merged.slice(0, CV_LIMITS.bulletsPerSection);
      delete existing.bulletSources;
    } else {
      projected.push({ entryId: targetId ?? `preview-suggested-${firstId}`, kind: "skill", heading,
        skillItems: labels, bullets: labels.slice(0, CV_LIMITS.bulletsPerSection) });
    }
  }
  return projected;
}
