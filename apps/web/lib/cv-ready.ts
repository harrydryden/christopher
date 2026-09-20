/**
 * Whether a Library can have a CV built from it, said on the Library rather than at Generate.
 *
 * A library of drafts passes every field validator and still refuses at generation, because
 * `groupCvLibrary` needs at least one *eligible* block: active, and for an experience block at
 * least one confirmed row that is not a label. That rule lives in `packages/core`, and this reads
 * it with the same two functions the build uses — `eligibleCvEvidence` and `isActiveEvidence` —
 * so the page and the build can never disagree about what is ready.
 *
 * Nothing here gates anything. It says what is missing and names the block it is missing from.
 */
import {
  eligibleCvEvidence,
  employmentHeading,
  isActiveEvidence,
  responsibilityRows,
  type CvLibrary,
  type Employment,
} from "@christopher/core/cv";

export type CvEvidenceStatus = "draft" | "active" | "inactive";

/** One job's evidence as the Library shows it: how much is written, how much is confirmed. */
export interface CvJobReadiness {
  /** Rows with any text in them. */
  rows: number;
  /** Rows the person has confirmed as their own wording. */
  confirmed: number;
  /** The block's lifecycle status, or null when the job has no evidence block yet. */
  status: CvEvidenceStatus | null;
  /** Whether a CV could be written from this job's evidence as it stands. */
  eligible: boolean;
  /** "3 of 5 rows confirmed · draft". */
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
  const status = (entry ? entry.status ?? "active" : null) as CvEvidenceStatus | null;
  const eligible = !!entry && !!eligibleCvEvidence(entry);
  return {
    rows: rows.length,
    confirmed: confirmedRows,
    status,
    eligible,
    line: entry
      ? `${confirmedRows} of ${rows.length} ${rows.length === 1 ? "row" : "rows"} confirmed · ${status}`
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
  /** "Ready to build: yes" or "Ready to build: no — activate Acme and confirm its rows". */
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

/** A block whose parent role block is archived cannot be used either; `groupCvLibrary` drops it. */
function usable(library: CvLibrary, entry: CvLibrary["entries"][number]): boolean {
  return (
    !!eligibleCvEvidence(entry) &&
    (!entry.roleId || library.entries.some(parent => parent.id === entry.roleId && isActiveEvidence(parent)))
  );
}

/**
 * Whether this Library would build, and if not, the nearest thing that would make it.
 *
 * The advice names one block, chosen as the least work: something already confirmed only needs
 * activating; something already active only needs its rows confirming.
 */
export function cvLibraryReadiness(library: CvLibrary): CvLibraryReadiness {
  const eligible = library.entries.filter(entry => usable(library, entry));
  if (eligible.length)
    return { ready: true, eligible: eligible.length, line: "Ready to build: yes" };
  const written = library.entries.filter(entry => responsibilityRows(entry.details).length > 0);
  const confirmedSomewhere = written.find(
    entry => entry.kind !== "experience" || (entry.confirmedResponsibilities ?? []).length > 0,
  );
  // Inactive first: activating a block that already carries confirmed wording is one control.
  const candidate =
    (confirmedSomewhere && !isActiveEvidence(confirmedSomewhere) ? confirmedSomewhere : undefined) ??
    written.find(entry => isActiveEvidence(entry)) ??
    written[0];
  if (!candidate)
    return {
      ready: false,
      eligible: 0,
      line: "Ready to build: no — add a job, write one responsibility or outcome, confirm it and set the block to Active",
    };
  const label = labelFor(library, candidate);
  const needsActivating = !isActiveEvidence(candidate);
  const needsConfirming = candidate.kind === "experience" && !eligibleCvEvidence({ ...candidate, status: "active" });
  const advice = needsActivating
    ? needsConfirming
      ? `activate ${label} and confirm its rows`
      : `activate ${label}`
    : `confirm ${label}’s rows`;
  return { ready: false, eligible: 0, line: `Ready to build: no — ${advice}` };
}
