/** A pasted skill list is labels, never supporting evidence from the Details field. */
export function parseCvSkillList(value: string): string[] {
  const seen = new Set<string>();
  return value.split(/[\n,;]+/).flatMap((part) => {
    const label = part.replace(/^\s*(?:(?:[-*•▪‣]|\d+[.)])\s*)+/, "").trim();
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) return [];
    seen.add(key);
    return [label];
  });
}

/** Normalise only explicit skill labels in a Library save; preserve every Details paragraph. */
export function normaliseSubmittedLibrarySkills(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) return value;
  return {
    ...value,
    entries: value.entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("kind" in entry) || entry.kind !== "skill" ||
          ("status" in entry && entry.status === "inactive") ||
          !("skillItems" in entry) || !Array.isArray(entry.skillItems) || !entry.skillItems.every((item: unknown) => typeof item === "string")) return entry;
      const skillItems = parseCvSkillList(entry.skillItems.join("\n"));
      return { ...entry, skillItems: skillItems.length ? skillItems : undefined };
    }),
  };
}
