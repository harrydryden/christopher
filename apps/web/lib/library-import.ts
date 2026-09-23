/**
 * What the Library page says about a document on its way in.
 *
 * Pure shaping, so the card is a component that renders sentences rather than one that works out
 * what state an import is in. An import is in exactly one of four: still being read, read and
 * proposing things, refused with a reason, or resolved and off the page. The row tells them apart
 * without another query — `listOpenLibraryImports` says so — and everything below turns that into
 * the words the person sees.
 */
import { countProposedItems, StoredLibraryProposalSchema, type LibraryProposal } from "@ava/core/library-import";

export type LibraryImportState = "reading" | "proposed" | "failed";

/**
 * How long a document may be "being read" before the page stops implying anything is coming.
 *
 * The task has four minutes and up to three attempts with a backoff between them, so a worker
 * that is merely busy is well inside this. Past it, either the worker is not running or the task
 * was given up on — and an import row is only ever written by the handler that finishes it, so
 * nothing else will ever move this row on. The card says so and offers a way out, because a
 * Library carrying a document that has been read for an hour, with no control on it and its
 * fingerprint refusing the same upload again, is a dead end.
 */
export const LIBRARY_IMPORT_SLOW_MS = 15 * 60_000;

/** The columns of an import this page needs. Deliberately not the row type: no content, no bytes. */
export interface LibraryImportRowView {
  id: string;
  kind: "cv" | "linkedin" | "website" | "paste";
  filename: string | null;
  url: string | null;
  proposal: unknown;
  error: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

export interface LibraryImportView {
  id: string;
  state: LibraryImportState;
  /** What the person called this document, in a few words. */
  source: string;
  /** The proposal, parsed, when there is one to show. */
  proposal: LibraryProposal | null;
  counts: { jobs: number; rows: number; education: number; skills: number };
  headline: string;
  error: string | null;
  /** True when the text is still on the row, so reading it again is worth offering. */
  retryable: boolean;
  /** True when a document has been "being read" for longer than anything could still be running. */
  stalled: boolean;
}

const KIND_LABELS: Record<LibraryImportRowView["kind"], string> = {
  cv: "CV",
  linkedin: "LinkedIn profile",
  website: "Website",
  paste: "Pasted text",
};

/** The name to show a document by: what it was called, then where it came from, then its kind. */
export function libraryImportSource(row: Pick<LibraryImportRowView, "kind" | "filename" | "url">): string {
  if (row.filename?.trim()) return row.filename.trim().slice(0, 120);
  if (row.url?.trim()) {
    try {
      const url = new URL(row.url);
      return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 120);
    } catch {
      return row.url.slice(0, 120);
    }
  }
  return KIND_LABELS[row.kind];
}

/** "4 jobs, 17 responsibilities and 2 qualifications", or the one of those that is not zero. */
export function proposalHeadline(
  counts: { jobs: number; rows: number; education: number; skills: number },
  source: string,
): string {
  const parts = [
    [counts.jobs, "job", "jobs"],
    [counts.rows, "responsibility", "responsibilities"],
    [counts.education, "qualification", "qualifications"],
    [counts.skills, "skill", "skills"],
  ] as const;
  const found = parts.filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  if (!found.length) return `Nothing to add from ${source}`;
  const list = found.length === 1 ? found[0]! : `${found.slice(0, -1).join(", ")} and ${found.at(-1)}`;
  return `Found in ${source}: ${list}`;
}

/**
 * One import as the page renders it.
 *
 * `hasDocument` is whether the text is still on the row, which decides whether a refusal is worth
 * offering to try again: a budget refusal or a model that answered nothing can be asked again for
 * the price of one call, while a file that could never be converted has nothing left to read.
 *
 * A proposal that does not parse is treated as a refusal rather than thrown: the row is the
 * worker's writing, and a version of the product that changes the shape must not take the Library
 * page down with it.
 */
export function libraryImportView(row: LibraryImportRowView, hasDocument = false, now = new Date()): LibraryImportView {
  const source = libraryImportSource(row);
  const empty = { jobs: 0, rows: 0, education: 0, skills: 0 };
  if (row.error) {
    return {
      id: row.id, state: "failed", source, proposal: null, counts: empty,
      headline: `Could not read ${source}`, error: row.error,
      retryable: hasDocument, stalled: false,
    };
  }
  if (!row.processedAt || row.proposal == null) {
    return {
      id: row.id, state: "reading", source, proposal: null, counts: empty,
      headline: `Reading ${source}…`, error: null, retryable: false,
      stalled: now.getTime() - row.createdAt.getTime() > LIBRARY_IMPORT_SLOW_MS,
    };
  }
  const parsed = StoredLibraryProposalSchema.safeParse(row.proposal);
  if (!parsed.success) {
    return {
      id: row.id, state: "failed", source, proposal: null, counts: empty,
      headline: `Could not read ${source}`,
      error: "What was read from this document can no longer be shown. Dismiss it and import the document again.",
      retryable: false, stalled: false,
    };
  }
  const counts = countProposedItems(parsed.data);
  return {
    id: row.id, state: "proposed", source, proposal: parsed.data, counts,
    headline: proposalHeadline(counts, source), error: null, retryable: false, stalled: false,
  };
}

/** Dates as the proposal card shows them beside a job: "Mar 2020 – Jun 2022", or nothing. */
export function proposedDates(job: { startDate: string; endDate: string; current: boolean }): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = (value: string) =>
    /^\d{4}-\d{2}$/.test(value) ? `${months[Number(value.slice(5)) - 1]} ${value.slice(0, 4)}` : value;
  const end = job.current ? "Present" : label(job.endDate);
  return [label(job.startDate), end].filter(Boolean).join(" – ");
}
