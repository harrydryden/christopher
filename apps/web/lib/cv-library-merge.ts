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
 * other save left that unit alone; when both changed the same unit the stored one wins and this
 * says so by name, because a silent merge of two versions of one paragraph is how wording is lost.
 */
import {
  CvLibrarySchema,
  employmentHeading,
  type CvLibrary,
  type Employment,
} from "@christopher/core/cv";

/** What a reload did with the text that was in the editor. */
export interface CvLibraryMerge {
  /** The stored library with the re-applied edits, ready to keep editing. */
  library: CvLibrary;
  /** Edits carried across, named the way the editor labels them. */
  kept: string[];
  /** Edits the stored version had already changed; theirs is kept and yours is not. */
  dropped: string[];
  /** One sentence for the person: what was reloaded and what happened to their text. */
  note: string;
}

type Entry = CvLibrary["entries"][number];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const INTRO = ["name", "contact", "profile", "linkedinUrl", "websiteUrl"] as const;
const INTRO_LABELS: Record<(typeof INTRO)[number], string> = {
  name: "Name",
  contact: "Contact details",
  profile: "Career overview",
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
 * and a unit both sides changed keeps the stored one. Deletions are never re-applied: the stored
 * version is the one every other reader has, and removing a block from it needs a deliberate act,
 * not the side effect of a reload.
 */
function mergeById<T extends { id: string }>(
  base: T[],
  mine: T[],
  latest: T[],
  label: (item: T) => string,
  kept: string[],
  dropped: string[],
): T[] {
  const byId = (items: T[]) => new Map(items.map(item => [item.id, item]));
  const baseById = byId(base);
  const mineById = byId(mine);
  const latestById = byId(latest);
  const merged = latest.map(stored => {
    const ours = mineById.get(stored.id);
    const original = baseById.get(stored.id);
    // Gone from the editor, unchanged in it, or already identical: the stored one stands.
    if (!ours || (original && same(ours, original)) || same(ours, stored)) return stored;
    // Untouched by them: our edit is the only change to this unit.
    if (original && same(original, stored)) {
      kept.push(label(ours));
      return ours;
    }
    dropped.push(label(ours));
    return stored;
  });
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
export function mergeCvLibrary(base: CvLibrary, mine: CvLibrary, latest: CvLibrary, version: number): CvLibraryMerge {
  const kept: string[] = [];
  const dropped: string[] = [];
  const merged: CvLibrary = { ...latest };
  for (const field of INTRO) {
    if (same(mine[field], base[field])) continue;
    if (same(latest[field], base[field])) {
      (merged as Record<string, unknown>)[field] = mine[field];
      kept.push(INTRO_LABELS[field]);
    } else if (!same(latest[field], mine[field])) dropped.push(INTRO_LABELS[field]);
  }
  if (latest.employment !== undefined || mine.employment !== undefined)
    merged.employment = mergeById(
      base.employment ?? [],
      mine.employment ?? [],
      latest.employment ?? [],
      jobLabel,
      kept,
      dropped,
    );
  merged.entries = mergeById(
    base.entries,
    mine.entries,
    latest.entries,
    entry => entryLabel(merged.employment ? merged : latest, entry),
    kept,
    dropped,
  );
  const parsed = CvLibrarySchema.safeParse(merged);
  if (!parsed.success)
    return {
      library: latest,
      kept: [],
      dropped: [...new Set([...kept, ...dropped])],
      note: `Reloaded version ${version}. Your text could not be merged into it, so nothing of yours was applied — copy what you need from the download and reapply it.`,
    };
  return {
    library: parsed.data,
    kept: [...new Set(kept)],
    dropped: [...new Set(dropped)],
    note: mergeNote(version, [...new Set(kept)], [...new Set(dropped)]),
  };
}

/** What the merge did, in one sentence, naming what was not carried. */
export function mergeNote(version: number, kept: string[], dropped: string[]): string {
  const carried = kept.length
    ? `kept your changes to ${kept.join(", ")}`
    : "found nothing of yours to carry across";
  const lost = dropped.length
    ? ` ${dropped.join(", ")} ${dropped.length === 1 ? "was" : "were"} changed in the saved version, so the saved wording is what you see; your version is in the download.`
    : "";
  return `Reloaded version ${version} and ${carried}. Check it, then save again.${lost}`;
}
