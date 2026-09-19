/**
 * The row operations the Library editor performs, away from the component that renders them.
 *
 * A job's evidence is one entry whose `details` are its rows, and the entry is created the first
 * time a row is typed into a job that has none. That, tagging a row with the facet it serves, and
 * appending an empty row for the person to fill are the three motions the Experience tab has; all
 * three are pure functions over the library, so what the editor does to a facet when a row is
 * reworded can be tested without rendering anything.
 *
 * The facet rules are `packages/core`'s and stay there: `updateResponsibilityRows` carries a tag
 * across an edit, because a tag classifies what a row is for rather than asserting that it is
 * true. Removal is the one case core cannot tell apart from a rewording, so `removeJobRow` below
 * settles it before handing the rows over.
 */
import {
  employmentHeading,
  responsibilityRows,
  setRowFacet,
  updateResponsibilityRows,
  type CvLibrary,
  type Employment,
  type EvidenceFacet,
} from "@christopher/core/cv";

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
      status: "draft",
      employmentId: job.id,
      heading: employmentHeading(job) || "New job",
      details: rows.join("\n"),
      confirmedResponsibilities: [],
    }],
  };
}

/** Tag one row of one entry with the facet it serves, or clear its tag with `null`. */
export function tagRow(library: CvLibrary, entryId: string, row: string, facet: EvidenceFacet | null): CvLibrary {
  return { ...library, entries: library.entries.map(item => item.id === entryId ? setRowFacet(item, row, facet) : item) };
}

/**
 * Append an empty row to a job and say where it landed, so the caret can go there.
 *
 * The facet the row is meant to serve cannot be stored yet — facets are keyed by the row's exact
 * text and an empty row has none — so the editor holds it against the position until there is
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
 * Remove one row from a job, taking its facet with it.
 *
 * `updateResponsibilityRows` pairs rows by text and then by position, which is right for an edit
 * and wrong for a removal: the row that moves up into the gap would inherit the tag of the row
 * that went. So the tag is cleared before the rows move, and the survivors keep only the tags
 * their own text carries.
 */
export function removeJobRow(library: CvLibrary, job: Employment, index: number): CvLibrary {
  const rows = jobRows(library, job.id);
  const entry = jobEntry(library, job.id);
  const dropped = responsibilityRows(rows[index] ?? "")[0];
  const cleared = entry && dropped ? tagRow(library, entry.id, dropped, null) : library;
  return setJobRows(cleared, job, rows.filter((_, position) => position !== index));
}
