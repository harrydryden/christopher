/**
 * Reload the latest Library and keep what the person had typed.
 *
 * A save is rejected when the stored version has moved on ("The library changed. Reload before
 * saving."), which is right — versions are immutable and a blind overwrite would erase whatever
 * the other save wrote. But telling someone to reload is telling them to throw away everything
 * they have typed since they opened the page, and the two edits almost never touch the same block.
 *
 * So the reload is a three-way merge over the units the Library already has: the intro fields, the
 * employment rows and the evidence blocks, each keyed by its own stable id. An edit lands when the
 * other save left that unit alone. When both changed a unit, the result names both versions and
 * accepts an explicit choice; the caller keeps the complete original draft until then.
 */
import {
  CvLibrarySchema,
  employmentHeading,
  type CvLibrary,
  type Employment,
} from "@col/core/cv";

/** What a reload did with the text that was in the editor. */
export interface CvLibraryMerge {
  /** The stored library with the re-applied edits, ready to keep editing. */
  library: CvLibrary;
  /** Edits carried across, named the way the editor labels them. */
  kept: string[];
  /** Edits the stored version had already changed; theirs is kept and yours is not. */
  dropped: string[];
  /** Both versions of each collision, with a stable key for an explicit choice in the editor. */
  conflicts: CvLibraryConflict[];
  /** False when even the chosen units cannot form a valid Library. */
  valid: boolean;
  /** One sentence for the person: what was reloaded and what happened to their text. */
  note: string;
}

export interface CvLibraryConflict {
  key: string;
  label: string;
  mine: unknown;
  stored: unknown;
}

type Entry = CvLibrary["entries"][number];
// Postgres jsonb may return the same object with its keys in a different order from the editor's
// draft. Compare JSON values without treating that ordering as a concurrent edit. Array order is
// meaningful; JSON.stringify's treatment of absent object properties and undefined array items
// is preserved, as is the existing top-level undefined/null equivalence.
function canonicalJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item) ?? "null").join(",")}]`;
  if (value && typeof value === "object") {
    const fields = Object.keys(value).sort().flatMap(key => {
      const encoded = canonicalJson((value as Record<string, unknown>)[key]);
      return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
    });
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

const INTRO = ["name", "email", "phone", "location", "contact", "profile", "linkedinUrl", "websiteUrl"] as const;
const INTRO_LABELS: Record<(typeof INTRO)[number], string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  location: "Location",
  contact: "Other contact details",
  profile: "Bio",
  linkedinUrl: "LinkedIn",
  websiteUrl: "Website",
};

const jobLabel = (job: Employment) =>
  [job.company, job.jobTitle].filter(part => part.trim()).join(" · ") || employmentHeading(job) || "a job";
const entryLabel = (library: CvLibrary, entry: Entry) => {
  const job = library.employment?.find(item => item.id === entry.employmentId);
  return (job ? jobLabel(job) : entry.heading.trim()) || "an evidence block";
};

/**
 * Merge one collection keyed by id. Additions land, edits land where the stored copy is untouched,
 * and a unit both sides changed keeps the stored one. A local deletion also requires an explicit
 * choice, because silently reviving a removed block loses the person's intent while silently
 * deleting a concurrently saved block loses the other writer's work.
 */
function mergeById<T extends { id: string }>(
  kind: "employment" | "entry",
  base: T[],
  mine: T[],
  latest: T[],
  label: (item: T) => string,
  kept: string[],
  dropped: string[],
  conflicts: CvLibraryConflict[],
  preferMine: ReadonlySet<string>,
): T[] {
  const byId = (items: T[]) => new Map(items.map(item => [item.id, item]));
  const baseById = byId(base);
  const mineById = byId(mine);
  const latestById = byId(latest);
  const merged: T[] = [];
  for (const stored of latest) {
    const ours = mineById.get(stored.id);
    const original = baseById.get(stored.id);
    if (!ours && original) {
      const key = `${kind}:${stored.id}`;
      const removed = `${label(original)} (removed)`;
      conflicts.push({ key, label: removed, mine: null, stored });
      if (preferMine.has(key)) kept.push(removed);
      else { dropped.push(removed); merged.push(stored); }
      continue;
    }
    // Untouched in the editor, newly added by the other writer, or already identical.
    if (!ours || (original && same(ours, original)) || same(ours, stored)) {
      merged.push(stored);
      continue;
    }
    // Untouched by them: our edit is the only change to this unit.
    if (original && same(original, stored)) {
      kept.push(label(ours));
      merged.push(ours);
      continue;
    }
    const key = `${kind}:${stored.id}`;
    conflicts.push({ key, label: label(ours), mine: ours, stored });
    if (preferMine.has(key)) {
      kept.push(label(ours));
      merged.push(ours);
      continue;
    }
    dropped.push(label(ours));
    merged.push(stored);
  }
  // Ours alone and never stored: an addition, which cannot collide with anything.
  for (const ours of mine) {
    if (latestById.has(ours.id) || baseById.has(ours.id)) continue;
    kept.push(label(ours));
    merged.push(ours);
  }
  return merged;
}

/**
 * The stored library with the editor's own edits re-applied where they do not collide.
 *
 * `base` is what the editor was opened on, `mine` is what is in it now, `latest` is what is
 * stored. The result parses as a library; if the merge produces something the schema refuses —
 * a dangling employment link, a duplicate job — the stored version is returned untouched and the
 * note says the text could not be carried, so nothing is saved that generation cannot read.
 */
export function mergeCvLibrary(
  base: CvLibrary,
  mine: CvLibrary,
  latest: CvLibrary,
  version: number,
  preferMine: ReadonlySet<string> = new Set(),
): CvLibraryMerge {
  const kept: string[] = [];
  const dropped: string[] = [];
  const conflicts: CvLibraryConflict[] = [];
  const merged: CvLibrary = { ...latest };
  for (const field of INTRO) {
    if (same(mine[field], base[field])) continue;
    if (same(latest[field], base[field])) {
      (merged as Record<string, unknown>)[field] = mine[field];
      kept.push(INTRO_LABELS[field]);
    } else if (!same(latest[field], mine[field])) {
      const key = `intro:${field}`;
      conflicts.push({ key, label: INTRO_LABELS[field], mine: mine[field], stored: latest[field] });
      if (preferMine.has(key)) {
        (merged as Record<string, unknown>)[field] = mine[field];
        kept.push(INTRO_LABELS[field]);
      } else dropped.push(INTRO_LABELS[field]);
    }
  }
  if (latest.employment !== undefined || mine.employment !== undefined)
    merged.employment = mergeById(
      "employment",
      base.employment ?? [],
      mine.employment ?? [],
      latest.employment ?? [],
      jobLabel,
      kept,
      dropped,
      conflicts,
      preferMine,
    );
  merged.entries = mergeById(
    "entry",
    base.entries,
    mine.entries,
    latest.entries,
    entry => entryLabel(merged.employment ? merged : latest, entry),
    kept,
    dropped,
    conflicts,
    preferMine,
  );
  const parsed = CvLibrarySchema.safeParse(merged);
  if (!parsed.success)
    return {
      library: latest,
      kept: [],
      dropped: [...new Set([...kept, ...dropped])],
      conflicts,
      valid: false,
      note: `Reloaded version ${version}. Some changes could not be merged safely. Your complete original draft is available below to copy or download; reapply the affected wording after checking it.`,
    };
  return {
    // The opened latest version is already normalised. Keep its property order so the editor's
    // JSON equality correctly recognises a "keep saved" choice as no unsaved change.
    library: merged,
    kept: [...new Set(kept)],
    dropped: [...new Set(dropped)],
    conflicts,
    valid: true,
    note: mergeNote(version, [...new Set(kept)], [...new Set(dropped)]),
  };
}

/** What the merge did, in one sentence, naming what was not carried. */
export function mergeNote(version: number, kept: string[], dropped: string[]): string {
  const carried = kept.length
    ? `kept your changes to ${kept.join(", ")}`
    : "found nothing of yours to carry across";
  const lost = dropped.length
    ? ` ${dropped.join(", ")} ${dropped.length === 1 ? "was" : "were"} not carried automatically. Choose which version to keep below; your complete original draft remains available to copy or download.`
    : "";
  return `Reloaded version ${version} and ${carried}. Check it, then save again.${lost}`;
}
