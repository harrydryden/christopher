/**
 * The row operations the Library editor performs, away from the component that renders them.
 *
 * A job's evidence is one entry whose `details` are its rows, and the entry is created the first
 * time a row is typed into a job that has none. That, tagging a row with the types it serves,
 * appending an empty row for the person to fill and removing a job with its evidence are the
 * motions the Experience tab has; all of them are pure functions over the library, so what the
 * editor does to a tag when a row is reworded can be tested without rendering anything.
 *
 * The tagging rules are `packages/core`'s and stay there: `updateResponsibilityRows` carries a
 * row's types across an edit, because a type classifies what a row is for rather than asserting
 * that it is true. Removal is the one case core cannot tell apart from a rewording, so
 * `removeJobRow` below settles it before handing the rows over.
 */
import {
  employmentHeading,
  isActiveEvidence,
  responsibilityRows,
  setRowFacets,
  updateResponsibilityRows,
  type EvidenceFacet,
} from "@ava/core/cv-helpers";
import type { CvLibrary, Employment } from "@ava/core/cv";

type CvEntry = CvLibrary["entries"][number];

/** The evidence block written for one job, if there is one yet. */
export function jobEntry(library: CvLibrary, employmentId: string): CvEntry | undefined {
  return library.entries.find(entry => entry.kind === "experience" && entry.employmentId === employmentId);
}

/**
 * One job's rows as the editor holds them: the raw lines, including the blank one just added, so
 * a row being typed into keeps its position. `responsibilityRows` is the saved reading of the same
 * text and drops the blanks.
 */
export function jobRows(library: CvLibrary, employmentId: string): string[] {
  const entry = jobEntry(library, employmentId);
  return entry ? entry.details.split("\n") : [];
}

/** Replace one job's rows, writing the job's first evidence block when it has none. */
export function setJobRows(library: CvLibrary, job: Employment, rows: string[], newId = () => crypto.randomUUID()): CvLibrary {
  const entry = jobEntry(library, job.id);
  if (entry) {
    return { ...library, entries: library.entries.map(item => item.id === entry.id ? updateResponsibilityRows(item, rows) : item) };
  }
  return {
    ...library,
    entries: [...library.entries, {
      id: newId(),
      kind: "experience",
      // A job in employment history is evidence of itself: there is no state for the person to
      // set, and a block written here is active the moment it exists.
      status: "active",
      employmentId: job.id,
      heading: employmentHeading(job) || "New job",
      details: rows.join("\n"),
      confirmedResponsibilities: [],
    }],
  };
}

/**
 * Tag one row of one entry with every type it serves, or clear it with an empty list.
 *
 * One narrative is often the problem somebody solved *and* the figure it moved, so the tag is a
 * list rather than a choice; core writes it deduplicated and in the canonical order.
 */
export function tagRow(library: CvLibrary, entryId: string, row: string, facets: readonly EvidenceFacet[]): CvLibrary {
  return { ...library, entries: library.entries.map(item => item.id === entryId ? setRowFacets(item, row, facets) : item) };
}

/**
 * Append an empty row to a job and say where it landed, so the caret can go there.
 *
 * The types the row is meant to serve cannot be stored yet — they are keyed by the row's exact
 * text and an empty row has none — so the editor holds them against the position until there is
 * something to tag. `pendingRowKey` is that position's name.
 */
export function addJobRow(library: CvLibrary, job: Employment): { library: CvLibrary; index: number } {
  const rows = jobRows(library, job.id);
  return { library: setJobRows(library, job, [...rows, ""]), index: rows.length };
}

export function pendingRowKey(employmentId: string, index: number): string {
  return `${employmentId}#${index}`;
}

/**
 * Remove one row from a job, taking its types with it.
 *
 * `updateResponsibilityRows` pairs rows by text and then by position, which is right for an edit
 * and wrong for a removal: the row that moves up into the gap would inherit the tags of the row
 * that went. So they are cleared before the rows move, and the survivors keep only the tags their
 * own text carries.
 *
 * The last row leaves an empty one behind rather than taking the block with it. Dropping the block
 * is how a job's evidence is archived, and that belongs to removing the job from employment
 * history — not to a control that says Remove beside one line of it.
 */
export function removeJobRow(library: CvLibrary, job: Employment, index: number): CvLibrary {
  const rows = jobRows(library, job.id);
  const entry = jobEntry(library, job.id);
  const dropped = responsibilityRows(rows[index] ?? "")[0];
  const cleared = entry && dropped ? tagRow(library, entry.id, dropped, []) : library;
  const kept = rows.filter((_, position) => position !== index);
  return setJobRows(cleared, job, kept.length ? kept : [""]);
}

/** An archived block, and what putting it back would bring with it. */
export type ArchivedBlock = {
  /** The block itself: what Restore sets active. */
  entryId: string;
  /** The job it is evidence for, when it is evidence for one. */
  employmentId?: string;
  /** The job as employment history reads it, or the block's own label when it has no job. */
  heading: string;
  /** How many rows come back with it; a block that is not a job's evidence has none. */
  rows: number | null;
};

/**
 * Everything the editor is holding out of sight that the person can still get back.
 *
 * A removed job is here by the block archived with it, and so is a block the release before this
 * one archived with its own "Archive block" control — education, a skill or an interest that would
 * otherwise be stored where nothing on the screen could reach it.
 *
 * An inactive experience block whose job also has an active one is not offered: the schema allows
 * one block per job, so putting it back would refuse the next save rather than restore anything.
 */
export function archivedBlocks(library: CvLibrary): ArchivedBlock[] {
  const archived = archivedJobIds(library);
  return library.entries.flatMap((entry): ArchivedBlock[] => {
    if (isActiveEvidence(entry)) return [];
    if (entry.kind !== "experience") return [{ entryId: entry.id, heading: entry.heading, rows: null }];
    if (!entry.employmentId || !archived.has(entry.employmentId)) return [];
    const job = (library.employment ?? []).find(item => item.id === entry.employmentId);
    return [{
      entryId: entry.id,
      employmentId: entry.employmentId,
      heading: (job && employmentHeading(job)) || entry.heading,
      rows: responsibilityRows(entry.details).length,
    }];
  });
}

/**
 * Put a removed job back: the inverse of `removeJob`, and the only way back from it.
 *
 * The block is marked active where it stands, so employment history lists the job again, the table
 * shows its rows, and the tags and confirmations archived with it come back with them. Like every
 * other motion here it changes what the editor is holding and nothing else — it is stored when the
 * person saves.
 *
 * A removal that had nothing to archive took the job and its empty block out of the library
 * outright, so there is nothing to put back and nothing that needs putting back.
 */
export function restoreJob(library: CvLibrary, employmentId: string): CvLibrary {
  return { ...library, entries: library.entries.map(entry => entry.employmentId === employmentId ? { ...entry, status: "active" as const } : entry) };
}

/** The same motion for a block with no job: education, a skill or an interest archived by an earlier release. */
export function restoreBlock(library: CvLibrary, entryId: string): CvLibrary {
  return { ...library, entries: library.entries.map(entry => entry.id === entryId ? { ...entry, status: "active" as const } : entry) };
}

/** Every experience block written for a job that has been archived, by the job it belongs to. */
function archivedJobIds(library: CvLibrary): Set<string> {
  const archived = new Set<string>();
  const live = new Set<string>();
  for (const entry of library.entries) {
    if (entry.kind !== "experience" || !entry.employmentId) continue;
    (isActiveEvidence(entry) ? live : archived).add(entry.employmentId);
  }
  for (const id of live) archived.delete(id);
  return archived;
}

/**
 * The jobs the editor shows: employment history, without the jobs whose evidence was archived.
 *
 * A job in employment history is active by being there, so a job whose only evidence is archived
 * is a job that was removed. Its employment record stays in the stored library because an archived
 * block has to keep the record it points at (`retainArchivedEvidence` puts it back for exactly
 * that reason) — kept for earlier versions and CVs already built, and shown nowhere but the
 * Archived jobs list `restoreJob` works from.
 */
export function editableEmployment(library: CvLibrary): Employment[] {
  const archived = archivedJobIds(library);
  return (library.employment ?? []).filter(job => !archived.has(job.id));
}

/** Put back the jobs the editor does not show, so an edit to the rest never drops one. */
export function withArchivedEmployment(library: CvLibrary, shown: Employment[]): Employment[] {
  const archived = archivedJobIds(library);
  return [...shown, ...(library.employment ?? []).filter(job => archived.has(job.id) && !shown.some(item => item.id === job.id))];
}

/**
 * Remove a job from employment history and take its evidence out of the editor with it.
 *
 * The rows are not deleted, they are archived where they are: the block is marked inactive and
 * the employment record it points at is kept, so the wording survives in the saved versions and
 * in the CVs already built from it, and `editableEmployment` shows neither again until
 * `restoreJob` puts them back.
 *
 * Archived in place rather than dropped and put back by `retainArchivedEvidence` on the way into
 * the database, because what the editor is holding is also what it posts, exports and merges: a
 * library whose only job has just been removed still has the one block the schema asks for, the
 * download beside a failed reload still carries the wording, and the reload's merge reads the
 * archiving as the edit it is rather than as a deletion it would decline to re-apply. Retention
 * still runs and still agrees; it is the belt here and not the braces.
 *
 * A job nobody has written a row for has nothing to archive, so it and its empty block simply go.
 */
export function removeJob(library: CvLibrary, employmentId: string): CvLibrary {
  if (!library.employment) return library;
  const written = library.entries.some(entry =>
    entry.employmentId === employmentId && responsibilityRows(entry.details).length > 0);
  return written
    ? { ...library, entries: library.entries.map(entry => entry.employmentId === employmentId ? { ...entry, status: "inactive" as const } : entry) }
    : {
      ...library,
      employment: library.employment.filter(job => job.id !== employmentId),
      entries: library.entries.filter(entry => entry.employmentId !== employmentId),
    };
}
