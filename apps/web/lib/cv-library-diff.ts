/**
 * What changed between two saved versions of a Library.
 *
 * A save appends an immutable version, so the only way to see what a past edit did is to compare
 * two of them. Rows are the unit everywhere else in the Library — the writer, the confirmation,
 * the types a row is tagged with and the evidence review all key on a row's exact text — so they
 * are the unit here too: per block, the rows that arrived, the rows that went, and the rows that
 * were reworded.
 *
 * Rewording is told from a removal followed by an addition the same way `updateResponsibilityRows`
 * carries a row's types across an edit: rows that match by text are paired first, and whatever is
 * left over on each side is paired by position. Two versions apart that is a guess, so it is
 * presented as one — "reworded", with both texts shown — rather than as a fact about what the
 * person did.
 *
 * What is compared is two parsed libraries, which the page hands over: the shapes an earlier
 * release stored are upgraded first, so a row whose tag was one string and a block that was stored
 * as a draft are not changes anybody made. The one status that is a change is the archiving a
 * person does by removing a job: the block and the employment record are both kept, so without it
 * the save that removed a job would read as no change at all.
 */
import {
  employmentHeading,
  isActiveStoredEvidence,
  responsibilityRows,
  type CvLibrary,
  type Employment,
} from "@ava/core/cv";

type CvEntry = CvLibrary["entries"][number];

export interface LibraryRowChange {
  before: string;
  after: string;
}

export interface LibraryBlockDiff {
  entryId: string;
  /** "Operations Director · Acme", or the block's own label. */
  label: string;
  added: string[];
  removed: string[];
  changed: LibraryRowChange[];
}

export interface LibraryDiff {
  from: number;
  to: number;
  /** Jobs and blocks in both versions whose rows moved. */
  blocks: LibraryBlockDiff[];
  blocksAdded: string[];
  blocksRemoved: string[];
  employmentAdded: string[];
  employmentRemoved: string[];
  /** Nothing differs between the two versions. */
  unchanged: boolean;
}

function labelFor(library: CvLibrary, entry: CvEntry): string {
  const job = library.employment?.find(item => item.id === entry.employmentId);
  if (job) return employmentHeading(job) || job.company.trim() || "New job";
  return entry.heading.trim() || "Untitled block";
}

function jobLabel(job: Employment): string {
  return employmentHeading(job) || job.company.trim() || "New job";
}

/** Rows paired by text, then by position, so a reworded row reads as one change and not two. */
export function diffRows(before: string[], after: string[]): Omit<LibraryBlockDiff, "entryId" | "label"> {
  const kept = new Set(after);
  const wasThere = new Set(before);
  const goneFrom = before.filter(row => !kept.has(row));
  const newIn = after.filter(row => !wasThere.has(row));
  const pairs = Math.min(goneFrom.length, newIn.length);
  return {
    changed: goneFrom.slice(0, pairs).map((row, index) => ({ before: row, after: newIn[index]! })),
    removed: goneFrom.slice(pairs),
    added: newIn.slice(pairs),
  };
}

function blockDiff(from: CvLibrary, to: CvLibrary, before: CvEntry, after: CvEntry): LibraryBlockDiff | null {
  const rows = diffRows(responsibilityRows(before.details), responsibilityRows(after.details));
  if (!rows.added.length && !rows.removed.length && !rows.changed.length) return null;
  // Named as the newer version names it, because that is the wording the person is looking at.
  return { entryId: after.id, label: labelFor(to, after) || labelFor(from, before), ...rows };
}

/**
 * The two versions compared, newest second. Blocks are matched by their stable id, employment by
 * its own, so a renamed company is a changed heading rather than a job removed and another added.
 */
export function diffCvLibraries(from: CvLibrary, to: CvLibrary, fromVersion: number, toVersion: number): LibraryDiff {
  const before = new Map(from.entries.map(entry => [entry.id, entry]));
  const after = new Map(to.entries.map(entry => [entry.id, entry]));
  const blocks = [...after.values()]
    .flatMap(entry => {
      const previous = before.get(entry.id);
      const diff = previous ? blockDiff(from, to, previous, entry) : null;
      return diff ? [diff] : [];
    });
  const blocksAdded = [...after.values()].filter(entry => !before.has(entry.id)).map(entry => labelFor(to, entry));
  // Gone, or archived where it stands: removing a job keeps its block and the record it points
  // at, so an entry that was evidence in the older version and is not in the newer one went.
  const blocksRemoved = [...before.values()]
    .filter(entry => {
      if (!isActiveStoredEvidence(entry)) return false;
      const now = after.get(entry.id);
      return !now || !isActiveStoredEvidence(now);
    })
    .map(entry => labelFor(after.has(entry.id) ? to : from, entry));
  const jobsBefore = new Map((from.employment ?? []).map(job => [job.id, job]));
  const jobsAfter = new Map((to.employment ?? []).map(job => [job.id, job]));
  const employmentAdded = [...jobsAfter.values()].filter(job => !jobsBefore.has(job.id)).map(jobLabel);
  const employmentRemoved = [...jobsBefore.values()].filter(job => !jobsAfter.has(job.id)).map(jobLabel);
  return {
    from: fromVersion,
    to: toVersion,
    blocks,
    blocksAdded,
    blocksRemoved,
    employmentAdded,
    employmentRemoved,
    unchanged: !blocks.length && !blocksAdded.length && !blocksRemoved.length && !employmentAdded.length && !employmentRemoved.length,
  };
}

/** "3 rows added, 1 reworded" — the diff in one line, for the card's heading. */
export function libraryDiffSummary(diff: LibraryDiff): string {
  const counts: Array<[number, string]> = [
    [diff.blocks.reduce((n, block) => n + block.added.length, 0), "row added"],
    [diff.blocks.reduce((n, block) => n + block.removed.length, 0), "row removed"],
    [diff.blocks.reduce((n, block) => n + block.changed.length, 0), "row reworded"],
    [diff.blocksAdded.length, "block added"],
    [diff.blocksRemoved.length, "block removed"],
    [diff.employmentAdded.length, "job added"],
    [diff.employmentRemoved.length, "job removed"],
  ];
  const said = counts.filter(([n]) => n > 0).map(([n, noun]) => {
    const [subject, ...rest] = noun.split(" ");
    return `${n} ${subject}${n === 1 ? "" : "s"} ${rest.join(" ")}`;
  });
  return said.length ? said.join(", ") : "No changes between these versions";
}

/**
 * Which two versions a request is asking to compare: `?diff=7,9`, or `?a=7&b=9`.
 *
 * Out of order is read in order, because "compare 9 with 7" and "compare 7 with 9" are the same
 * question and only one of the two answers reads as a history. Anything that is not two distinct
 * versions is no request at all.
 */
export function requestedDiff(
  params: { diff?: string; a?: string; b?: string },
  available: number[],
): { from: number; to: number } | null {
  const raw = params.diff ? params.diff.split(",") : [params.a ?? "", params.b ?? ""];
  const [first, second] = raw.map(value => Number(String(value).trim()));
  if (![first, second].every(value => Number.isInteger(value))) return null;
  const known = new Set(available);
  if (!known.has(first!) || !known.has(second!) || first === second) return null;
  return { from: Math.min(first!, second!), to: Math.max(first!, second!) };
}
