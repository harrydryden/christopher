/**
 * Whether a Library can have a CV built from it, said on the Library rather than at Generate.
 *
 * A library of unconfirmed rows passes every field validator and still refuses at generation,
 * because `groupCvLibrary` needs at least one *eligible* block: evidence of a job the person still
 * lists, with at least one confirmed row that is not a label. That rule lives in `packages/core`,
 * and this reads it with the same two functions the build uses — `eligibleCvEvidence` and
 * `isActiveEvidence` — so the page and the build can never disagree about what is ready.
 *
 * Nothing here gates anything. It says what is missing and names the block it is missing from.
 */
import {
  eligibleCvEvidence,
  employmentHeading,
  isActiveEvidence,
  responsibilityRows,
  type CvEvidenceStatus,
  type CvLibrary,
  type Employment,
} from "@christopher/core/cv";

/** One job's evidence as the Library shows it: how much is written, how much is confirmed. */
export interface CvJobReadiness {
  /** Rows with any text in them. */
  rows: number;
  /** Rows the person has confirmed as their own wording. */
  confirmed: number;
  /** Whether the block is evidence or has been archived, and null when the job has none yet. */
  status: CvEvidenceStatus | null;
  /** Whether a CV could be written from this job's evidence as it stands. */
  eligible: boolean;
  /** "3 of 5 rows confirmed". */
  line: string;
}

/** The evidence block written for one job, if there is one. */
function entryForJob(library: CvLibrary, employmentId: string) {
  return library.entries.find(entry => entry.kind === "experience" && entry.employmentId === employmentId);
}

export function cvJobReadiness(library: CvLibrary, employmentId: string): CvJobReadiness {
  const entry = entryForJob(library, employmentId);
  const rows = entry ? responsibilityRows(entry.details) : [];
  const confirmed = new Set(entry?.confirmedResponsibilities ?? []);
  const confirmedRows = rows.filter(row => confirmed.has(row)).length;
  const status = (entry ? (isActiveEvidence(entry) ? "active" : "inactive") : null) as CvEvidenceStatus | null;
  const eligible = !!entry && !!eligibleCvEvidence(entry);
  return {
    rows: rows.length,
    confirmed: confirmedRows,
    status,
    eligible,
    // The status is not in the sentence: a job in employment history is active by being there, and
    // what is left to do about it is always the confirming.
    line: rows.length
      ? `${confirmedRows} of ${rows.length} ${rows.length === 1 ? "row" : "rows"} confirmed`
      : "No responsibilities or outcomes yet",
  };
}

/** Every row of one job's evidence, as `Confirm all` would confirm them. */
export function confirmableRows(library: CvLibrary, employmentId: string): string[] {
  const entry = entryForJob(library, employmentId);
  return entry ? responsibilityRows(entry.details) : [];
}

export interface CvLibraryReadiness {
  ready: boolean;
  /** How many blocks a build could use today. */
  eligible: number;
  /** "Ready to build: yes" or "Ready to build: no — confirm Acme’s rows". */
  line: string;
}

/** What to call a block in a sentence: the employer for a job, the block's own label otherwise. */
function labelFor(library: CvLibrary, entry: CvLibrary["entries"][number]): string {
  if (entry.kind === "experience") {
    const job: Employment | undefined = library.employment?.find(item => item.id === entry.employmentId);
    if (job?.company.trim()) return job.company.trim();
    if (job) return employmentHeading(job);
  }
  return entry.heading.trim() || "this block";
}

/**
 * A block a CV could be written from today.
 *
 * Nothing written is nothing to build from: a block whose details are still empty — the one the
 * Add button has just put on the screen — is not evidence of anything, and a library cannot be
 * stored with it either. A block whose parent role block is archived cannot be used either;
 * `groupCvLibrary` drops it.
 */
function usable(library: CvLibrary, entry: CvLibrary["entries"][number]): boolean {
  return (
    responsibilityRows(entry.details).length > 0 &&
    !!eligibleCvEvidence(entry) &&
    (!entry.roleId || library.entries.some(parent => parent.id === entry.roleId && isActiveEvidence(parent)))
  );
}

/**
 * Whether this Library would build, and if not, the nearest thing that would make it.
 *
 * There is one thing left to do and one thing to name: confirming the rows of a job that has some.
 * Archived evidence is not on the screen and not something to act on, so it is not what the
 * sentence points at; an account with nothing written at all is told where to start instead.
 */
export function cvLibraryReadiness(library: CvLibrary): CvLibraryReadiness {
  const eligible = library.entries.filter(entry => usable(library, entry));
  if (eligible.length)
    return { ready: true, eligible: eligible.length, line: "Ready to build: yes" };
  const written = library.entries.filter(
    entry => isActiveEvidence(entry) && responsibilityRows(entry.details).length > 0,
  );
  const candidate = written.find(entry => entry.kind === "experience") ?? written[0];
  if (!candidate)
    return {
      ready: false,
      eligible: 0,
      line: "Ready to build: no — add a job, write one responsibility or outcome and confirm it",
    };
  return { ready: false, eligible: 0, line: `Ready to build: no — confirm ${labelFor(library, candidate)}’s rows` };
}
