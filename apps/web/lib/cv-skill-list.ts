import type { CvLibrary } from "@col/core/cv";

/** A pasted skill list is labels, never supporting evidence from the Details field. */
export function parseCvSkillList(value: string, preserved: readonly string[] = []): string[] {
  const canonical = new Set(preserved);
  const seen = new Set<string>();
  return value.split("\n").flatMap((line) => {
    const whole = line.trim();
    // A stored label may legitimately contain commas or semicolons. Keep that exact line when
    // another skill in the same field is edited or pasted beside it.
    const isCanonical = canonical.has(whole);
    const parts = isCanonical ? [whole] : line.split(/[,;]+/);
    return parts.flatMap((part) => {
      const label = isCanonical ? part : part.replace(/^\s*(?:(?:[-*•▪‣]|\d+[.)])\s*)+/, "").trim();
      const key = label.toLowerCase();
      if (!label || seen.has(key)) return [];
      seen.add(key);
      return [label];
    });
  });
}

/** Split one stored combined label only after the person asks; all other labels stay verbatim. */
export function splitCvLibrarySkillItem(items: readonly string[], index: number): string[] | null {
  const value = items[index];
  if (value === undefined) return null;
  const parts = parseCvSkillList(value);
  return parts.length > 1 ? [...items.slice(0, index), ...parts, ...items.slice(index + 1)] : null;
}

/** Identify skill fields whose raw text differs from the opened Library, independent of Details. */
export function editedCvSkillEntryIds(value: CvLibrary, baseline: CvLibrary): string[] {
  return value.entries.flatMap((entry) => {
    if (entry.kind !== "skill" || entry.status === "inactive") return [];
    const before = baseline.entries.find(candidate => candidate.id === entry.id);
    return JSON.stringify(entry.skillItems ?? []) === JSON.stringify(before?.skillItems ?? []) ? [] : [entry.id];
  });
}

/** Parse only explicitly edited skill fields; leave canonical arrays and archived evidence intact. */
export function normaliseSubmittedLibrarySkills(value: unknown, editedIds: readonly string[], original?: unknown): unknown {
  if (!editedIds.length || !value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) return value;
  const selected = new Set(editedIds);
  const originalEntries = original && typeof original === "object" && "entries" in original && Array.isArray(original.entries)
    ? original.entries : [];
  return {
    ...value,
    entries: value.entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string" || !selected.has(entry.id) ||
          !("kind" in entry) || entry.kind !== "skill" || ("status" in entry && entry.status === "inactive") ||
          !("skillItems" in entry) || !Array.isArray(entry.skillItems) || !entry.skillItems.every((item: unknown) => typeof item === "string")) return entry;
      const originalEntry = originalEntries.find((item: unknown) => item && typeof item === "object" && "id" in item && item.id === entry.id);
      const preserved = originalEntry && typeof originalEntry === "object" && "skillItems" in originalEntry &&
        Array.isArray(originalEntry.skillItems) && originalEntry.skillItems.every((item: unknown) => typeof item === "string")
        ? originalEntry.skillItems as string[] : [];
      const skillItems = parseCvSkillList(entry.skillItems.join("\n"), preserved);
      return { ...entry, skillItems: skillItems.length ? skillItems : undefined };
    }),
  };
}
