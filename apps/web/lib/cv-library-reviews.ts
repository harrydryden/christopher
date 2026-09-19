/**
 * Turning the reviews stored against a Library into what the page shows.
 *
 * The score is never computed here. `scoreLibraryRows` in `packages/core` is the only place a
 * number is produced, so this either reads back the stored review of an entry's exact wording or,
 * when none describes it yet, falls back to `rulesLibraryReview` — the no-model baseline computed
 * from the person's own facet tags. A baseline standing in for a review that has not run is marked
 * provisional, so the page can say so rather than pass it off as the whole answer.
 *
 * This is the server half of the Library's evidence display; the words and the shapes are in
 * `cv-library-evidence.ts`, which the editor loads in the browser.
 */
import {
  employmentHeading,
  evidenceRows,
  type CvLibrary,
} from "@christopher/core/cv";
import {
  evidenceRatingFor,
  facetForPrompt,
  rulesLibraryReview,
  type LibraryEntryReview,
  type LibraryReviewSource,
} from "@christopher/core/library-review";
import {
  libraryEvidenceLine,
  NO_EVIDENCE,
  missingFacetLine,
  type EvidenceEntryView,
  type EvidencePrompt,
  type LibraryEvidence,
} from "./cv-library-evidence";

type CvEntry = CvLibrary["entries"][number];

/** Entry kinds an evidence review is about, as the worker's handler defines them. */
const REVIEWABLE_KINDS = new Set(["experience", "education", "skill"]);

/** A stored review, as much of it as the page reads. */
export interface StoredLibraryReview {
  entryId: string;
  source: LibraryReviewSource;
  review: LibraryEntryReview;
}

/** Whether a pass is in flight for this account, and the sentence that refused the last one. */
export interface LibraryReviewRun {
  pending: boolean;
  /** The budget refusal the worker recorded, verbatim; null when the pass was not refused. */
  refusal: string | null;
}

/** What to call a block in a sentence: the job it evidences, or its own label. */
function labelFor(library: CvLibrary, entry: CvEntry): string {
  const job = library.employment?.find(item => item.id === entry.employmentId);
  if (job) return employmentHeading(job) || job.company.trim() || "New job";
  return entry.heading.trim() || "This block";
}

function promptsOf(review: LibraryEntryReview): EvidencePrompt[] {
  return review.prompts.map(question => ({ question, facet: facetForPrompt(question) }));
}

/**
 * Every reviewable block's evidence, read back or computed, with the line that sums it up.
 *
 * `stored` holds only reviews of the wording as it is saved now — `latestLibraryReviews` matches
 * on the input hash — so an entry missing from it is one nobody has reviewed in this shape, and
 * its baseline is computed here instead. That is what the Library shows in the seconds between a
 * save and the pass starting, and for good on an account whose budget the pass was refused by.
 */
export function libraryEvidence(
  library: CvLibrary | null,
  stored: ReadonlyMap<string, StoredLibraryReview>,
  run: LibraryReviewRun = { pending: false, refusal: null },
): LibraryEvidence {
  if (!library) return NO_EVIDENCE;
  const entries = library.entries
    .filter(entry => REVIEWABLE_KINDS.has(entry.kind) && evidenceRows(entry).length > 0)
    .map<EvidenceEntryView>(entry => {
      const held = stored.get(entry.id);
      const review = held?.review ?? rulesLibraryReview(entry, library);
      const source = held?.source ?? "rules";
      return {
        entryId: entry.id,
        employmentId: entry.employmentId ?? null,
        label: labelFor(library, entry),
        score: review.score,
        rating: review.rating,
        source,
        provisional: !held,
        evaluating: source !== "model" && run.pending,
        missing: review.missing,
        missingLine: missingFacetLine(review.missing),
        prompts: promptsOf(review),
        reviewedRows: review.rows.map(row => row.row),
      };
    });
  return {
    entries,
    line: libraryEvidenceLine(entries.filter(entry => entry.employmentId), evidenceRatingFor),
    refusal: run.refusal,
    evaluating: entries.some(entry => entry.evaluating),
  };
}
