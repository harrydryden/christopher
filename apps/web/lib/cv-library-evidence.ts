/**
 * How the Library talks about how well a block is evidenced: the words, the ordering and the lines.
 *
 * Deliberately free of the entry scorer. `packages/core`'s `library-review` reaches `node:crypto`
 * through the quote anchoring it shares with the CV assessment, so it cannot be loaded in a browser
 * — and the Library editor is a client component that has to say, live as somebody types and tags
 * a row, what that row is still missing. So the shapes and the sentences live here, the arithmetic
 * stays in core (`@col/core/evidence-rubric` is the browser-safe half of it: the marks, the
 * checklists and `scoreRowAgainst`), and `cv-library-reviews.ts` is where the stored reviews meet
 * this on the server.
 *
 * Nothing here gates anything. A block rated None is still active evidence if the person says so.
 */
import { EVIDENCE_FACETS_BY_NEED, EVIDENCE_FACET_LABELS, evidenceRows, rowFacets, type EvidenceFacet } from "@col/core/cv-helpers";
import type { CvLibrary } from "@col/core/cv";
// Types only: the scorer they belong to reaches `node:crypto` and never reaches the browser.
import type { EvidenceRating, LibraryReviewSource } from "@col/core/library-review";
import {
  EVIDENCE_MARK_SPECS,
  detectEvidenceMarks,
  scoreRowAgainst,
  scoredAsLine,
  type EvidenceMark,
} from "@col/core/evidence-rubric";

type CvEntry = CvLibrary["entries"][number];

/** The rating words, as the badge and the three-cell bar spell them. */
export const EVIDENCE_RATING_LABELS: Readonly<Record<EvidenceRating, string>> = {
  none: "None",
  weak: "Weak",
  good: "Good",
  strong: "Strong",
};

/** One question the entry could answer, and the type to tag the answer with when it is known. */
export interface EvidencePrompt {
  question: string;
  facet: EvidenceFacet | null;
}

/**
 * One reviewed row, as the inputs to its score rather than the number: the browser scores it live
 * against the tags on the screen, so re-tagging a row re-scores it without waiting for a review.
 */
export interface EvidenceRowView {
  row: string;
  /** The person's own tags for the row when it was reviewed. */
  tagged: EvidenceFacet[];
  /** The marks the review says the wording earns, across every type; none when unverified. */
  marks: EvidenceMark[];
  /** What the review reads the row as serving: the tags, or the model's own classification. */
  reviewFacets: EvidenceFacet[];
  /** Whether the review's quote of the row was found in the row. */
  verified: boolean;
}

export interface EvidenceEntryView {
  entryId: string;
  /** The job this block evidences, or null for education, a skill or an interest. */
  employmentId: string | null;
  /** "Operations Director · Acme", or the block's own label. */
  label: string;
  score: number;
  rating: EvidenceRating;
  source: LibraryReviewSource;
  /** No stored review describes this wording: the baseline stands in, pending the pass. */
  provisional: boolean;
  /** A model review has still to land, and the pass that would write one is in flight. */
  evaluating: boolean;
  missing: EvidenceFacet[];
  /** "No outcomes or metrics moved yet". */
  missingLine: string;
  prompts: EvidencePrompt[];
  /** The rows the score was computed over, so the editor can say when the text has moved on. */
  reviewedRows: string[];
  /** Each of those rows scored on its own, in the same order. */
  rows: EvidenceRowView[];
}

export interface LibraryEvidence {
  entries: EvidenceEntryView[];
  /** "Evidence: Good · 2 jobs are Weak", or null when no job carries evidence yet. */
  line: string | null;
  /** The sentence the last pass was refused with, when a budget could not admit it. */
  refusal: string | null;
  /** Whether anything is still waiting on a model review: what the poller is mounted for. */
  evaluating: boolean;
}

export const NO_EVIDENCE: LibraryEvidence = { entries: [], line: null, refusal: null, evaluating: false };

/**
 * Types no row of this entry is tagged with, the ones worth the most first.
 *
 * The union across the rows, because a row carries as many types as it serves: one narrative that
 * is both the problem solved and the metric it moved covers both, and neither is still missing.
 */
export function untaggedFacets(entry: CvEntry): EvidenceFacet[] {
  const tagged = new Set(evidenceRows(entry).flatMap(row => rowFacets(entry, row)));
  return EVIDENCE_FACETS_BY_NEED.filter(facet => !tagged.has(facet));
}

/**
 * One line of what is missing, in the words a person would use: the two types worth the most, and
 * how many others are still untagged, because six names in a row is a list rather than a hint.
 *
 * The labels are the ones the Type column offers, lowercased and left plural — "No outcomes or
 * metrics moved yet" — so the hint and the control name the same six things. The word facet is
 * ours, not the person's, and appears nowhere they can read.
 */
export function missingFacetLine(missing: EvidenceFacet[]): string {
  if (!missing.length) return "All six types are covered";
  const named = missing.slice(0, 2).map(facet => EVIDENCE_FACET_LABELS[facet].toLowerCase());
  const rest = missing.length - named.length;
  return `No ${named.join(" or ")} yet${rest ? ` · ${rest} other ${rest === 1 ? "type" : "types"} untagged` : ""}`;
}

/** "2 jobs are Weak", "1 job has no evidence yet". */
function bandClause(count: number, rating: EvidenceRating): string {
  const jobs = `${count} ${count === 1 ? "job" : "jobs"}`;
  if (rating === "none") return `${jobs} ${count === 1 ? "has" : "have"} no evidence yet`;
  return `${jobs} ${count === 1 ? "is" : "are"} ${EVIDENCE_RATING_LABELS[rating]}`;
}

/**
 * The Library-wide line: the rating of the whole history, then the jobs that drag it down.
 *
 * The overall rating is the mean of the jobs' scores rather than the worst of them, so one thin
 * job does not describe a history that is otherwise well evidenced — and the clause after it names
 * how many such jobs there are anyway, which is the part worth acting on.
 */
export function libraryEvidenceLine(jobs: EvidenceEntryView[], ratingFor: (score: number) => EvidenceRating): string | null {
  if (!jobs.length) return null;
  const mean = Math.round(jobs.reduce((sum, entry) => sum + entry.score, 0) / jobs.length);
  const clauses = (["none", "weak"] as const)
    .map(rating => ({ rating, count: jobs.filter(entry => entry.rating === rating).length }))
    .filter(band => band.count > 0)
    .map(band => bandClause(band.count, band.rating));
  return [`Evidence: ${EVIDENCE_RATING_LABELS[ratingFor(mean)]}`, ...clauses].join(" · ");
}

/** The views by entry id, which is how the editor reaches for one while rendering a job. */
export function evidenceByEntry(evidence: LibraryEvidence): Map<string, EvidenceEntryView> {
  return new Map(evidence.entries.map(entry => [entry.entryId, entry]));
}

/** What is still missing for one of the types a row is scored as. */
export interface RowGuidanceGroup {
  facet: EvidenceFacet;
  /** The type as the Type column names it. */
  label: string;
  /** One line to act on per missing mark, in the order the type's checklist reads. */
  asks: string[];
}

/** What a row's score cell shows, and what its panel says when opened. */
export interface RowGuidance {
  /** 0–100, or null when the row has no type and so nothing it could be short of. */
  score: number | null;
  heading: string;
  /** Only what is missing, grouped by type; nothing about what the row already has. */
  missing: RowGuidanceGroup[];
  footer: string;
  /**
   * The types the review read an untyped row as, for the person to adopt in one click. Empty once
   * the row carries a type of its own, or when the review read it as nothing.
   */
  suggested: EvidenceFacet[];
}

const SELECT_TYPE_FOOTER = "Choose one or more types in the Type column; the row is scored against what each type needs.";

/**
 * A row's score and what it still needs, against the types on the screen now.
 *
 * The marks are the review's when the row's saved text is the text on the screen, and otherwise
 * the rules baseline read from the wording as typed — so the cell follows the person as they type
 * and tag, and the full review's judgement stands exactly as long as it describes this wording.
 * The number is `scoreRowAgainst`'s; nothing here invents one.
 */
export function rowGuidance({ text, facets, view, source, evaluating }: {
  /** The row as it is on the screen, keyed as the saved library keys it. */
  text: string;
  /** The row's types as they are on the screen. */
  facets: readonly EvidenceFacet[];
  view: EvidenceRowView | undefined;
  source: LibraryReviewSource;
  evaluating: boolean;
}): RowGuidance {
  if (!facets.length) {
    const read = view?.reviewFacets.length && source === "model" ? ` The full review reads this row as ${scoredAsLine(view.reviewFacets)}.` : "";
    const suggested = view?.reviewFacets.length ? [...view.reviewFacets] : [];
    return { score: null, heading: "Select type", missing: [], footer: SELECT_TYPE_FOOTER + read, suggested };
  }
  // The review's marks stand only for the wording they were read from, and only when the review
  // could tie them to it; otherwise the baseline reads the row as it is on the screen.
  const reviewed = !!view && view.row === text && view.verified;
  const marks = reviewed ? view.marks : detectEvidenceMarks(text);
  const { score, byFacet } = scoreRowAgainst(marks, facets);
  const scoredAs = scoredAsLine(facets);
  const missing = byFacet
    .filter(item => item.missing.length)
    .map<RowGuidanceGroup>(item => ({
      facet: item.facet,
      label: EVIDENCE_FACET_LABELS[item.facet],
      asks: item.missing.map(mark => EVIDENCE_MARK_SPECS[mark].ask),
    }));
  const by = reviewed && source === "model"
    ? "From the full review."
    : evaluating ? "From your own wording while the full review runs." : "From your own wording; Re-score for the full review.";
  return {
    score,
    heading: `${score}/100 · Scored as ${scoredAs}`,
    missing,
    footer: missing.length ? by : `Nothing missing for ${scoredAs}. ${by}`,
    suggested: [],
  };
}

/** Whether the rows on screen are the rows a score was computed over. */
export function rowsMovedOn(entry: CvEntry, reviewedRows: string[]): boolean {
  const rows = evidenceRows(entry);
  return rows.length !== reviewedRows.length || rows.some((row, index) => row !== reviewedRows[index]);
}
