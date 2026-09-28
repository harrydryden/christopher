/**
 * How much evidence one library entry actually carries, and what to ask for next.
 *
 * Evidence quality is judged today only at CV time, once per CV, inside a $2 assessment against a
 * particular job description. That is the wrong moment and the wrong price: the person writes the
 * entry weeks earlier, with no idea whether a reviewer will find anything in it. This module
 * scores an entry on its own terms, with no job description, on two ideas: coverage (is each type
 * of evidence present somewhere in the entry) and, row by row, whether each row says what its type
 * needs. A row is scored against the type(s) the person tagged it with, using the checklist for
 * that type in `evidence-rubric.ts` — four marks worth a quarter each — so a Responsibilities row
 * is judged on what was owned, for whom, at what level and scale, and a Metrics moved row on the
 * figure, what it measures, how it moved and what moved it. A row the person has not tagged is
 * scored in its entry against the review's reading of it; one with no type either way has no
 * score.
 *
 * Two things are deliberate. The score is computed here, from classifications, and never taken
 * from the model: `scoreLibraryRows` is the only place a number is produced, so a model cannot
 * flatter an entry. And the score gates nothing — an entry rated None is still active evidence if
 * the person says so, exactly as the fit score ranks a role without ever removing it.
 *
 * The marks are properties of the wording, not of the tag: the review records which of the
 * twenty-four a row earns, and the score is read off against whatever the row is tagged with, so
 * re-tagging re-scores without another review.
 *
 * `rulesLibraryReview` is the no-model baseline, computed from the person's own tags and the
 * wording rules in `detectEvidenceMarks`. It is what the Library shows the moment a save lands,
 * before the A12 call has run, and it is the whole feature for an account that has spent its
 * budget. The A12 review replaces the detected marks with its own judgement of the same marks.
 */
import { z } from "zod";
import {
  EVIDENCE_FACETS,
  EVIDENCE_FACET_PROMPTS,
  evidenceRows,
  responsibilityRows,
  rowFacets,
  type CvLibrary,
  type Employment,
  type EvidenceFacet,
} from "./cv";
import {
  detectEvidenceMarks,
  EVIDENCE_MARKS,
  knownEvidenceMarks,
  scoreRowAgainst,
  type EvidenceFacetScore,
  type EvidenceMark,
} from "./evidence-rubric";
import { cvQuoteIsAnchored, mentionsDemographicAttribute } from "./cv-review";
import { sha1 } from "./normalize";

type CvEntry = CvLibrary["entries"][number];

/** How much evidence an entry carries; @ava/db's column enum is this list, re-exported. */
export const EVIDENCE_RATINGS = ["none", "weak", "good", "strong"] as const;
export type EvidenceRating = (typeof EVIDENCE_RATINGS)[number];

/**
 * Who produced a review. `rules` is the deterministic baseline computed from the person's own
 * facet tags, written the moment a library is saved; `model` is the model's review, which lands
 * when the task has run. @ava/db's column enum is this list, re-exported.
 */
export const LIBRARY_REVIEW_SOURCES = ["rules", "model"] as const;
export type LibraryReviewSource = (typeof LIBRARY_REVIEW_SOURCES)[number];

/** Entries per model call, so the whole library is written to the cache once and read back. */
export const LIBRARY_REVIEW_BATCH = 8;

/**
 * One row, classified. `verified` is false when the classification could not be tied to the row.
 *
 * `facets` is every type the review says the row serves — the person's own tags for the baseline,
 * the model's classification for a model review — and empty when it serves none clearly, which is
 * what "unclear" used to say and what an unverified row always says. It drives the entry's
 * coverage: a row counts for each of them, so the problem someone solved and the figure it moved
 * can be one sentence and cover both.
 *
 * `tagged` is the person's own tags for the row when it was reviewed, and `marks` every mark in
 * the rubric the row's wording earns, for all six types. The row's score is `marks` read against
 * `tagged` (`libraryRowScore`), so it follows the person's choice of type, not the model's; only
 * an untagged row is read against `facets` instead.
 */
export interface LibraryRowReview {
  row: string;
  facets: EvidenceFacet[];
  tagged: EvidenceFacet[];
  marks: EvidenceMark[];
  quote: string | null;
  verified: boolean;
}

export interface LibraryEntryReview {
  entryId: string;
  rows: LibraryRowReview[];
  /** Verified rows carrying each facet. A facet is present when its count is above zero. */
  coverage: Record<EvidenceFacet, number>;
  /** Facets no verified row carries, heaviest weight first. */
  missing: EvidenceFacet[];
  /** At most three questions that would raise the score, each answerable in a line. */
  prompts: string[];
  score: number;
  rating: EvidenceRating;
  /**
   * Set when the model classified none of the entry's rows — it left the entry out of its answer,
   * or answered for rows the entry does not have. Such a review says nothing about the entry, and
   * is not stored as the model's judgement of it: the entry stays on its baseline and is asked
   * about again on the next pass.
   */
  unread?: true;
}

/**
 * What each facet is worth in the coverage term, summing to eight.
 *
 * These are the weights a CV reviewer rewards: an outcome and a number are what a requirement is
 * matched against, so they count double, and what someone was responsible for — the part everyone
 * writes unprompted — counts once. A Strong entry is therefore one the CV assessment will find
 * evidence in, rather than one that is merely long.
 */
export const LIBRARY_FACET_WEIGHTS: Readonly<Record<EvidenceFacet, number>> = {
  responsibility: 1,
  problem: 1,
  outcome: 2,
  metric: 2,
  milestone: 1,
  style: 1,
};

const TOTAL_FACET_WEIGHT = Object.values(LIBRARY_FACET_WEIGHTS).reduce((sum, weight) => sum + weight, 0);

/** The lower bound of each rating, in score order. None < 25 ≤ Weak < 50 ≤ Good < 75 ≤ Strong. */
export const EVIDENCE_RATING_FLOORS: ReadonlyArray<readonly [EvidenceRating, number]> = [
  ["strong", 75],
  ["good", 50],
  ["weak", 25],
  ["none", 0],
];

export function evidenceRatingFor(score: number): EvidenceRating {
  return EVIDENCE_RATING_FLOORS.find(([, floor]) => score >= floor)?.[0] ?? "none";
}

/** Facets ordered by what they are worth, heaviest first, then by the canonical facet order. */
const BY_WEIGHT = [...EVIDENCE_FACETS].sort(
  (a, b) => LIBRARY_FACET_WEIGHTS[b] - LIBRARY_FACET_WEIGHTS[a] || EVIDENCE_FACETS.indexOf(a) - EVIDENCE_FACETS.indexOf(b),
);

/**
 * One row's score in its entry's aggregate: the marks it earns read against the types it is
 * scored as, a quarter a mark and the mean across those types (`scoreRowAgainst`).
 *
 * The types are the person's tags when the row has any, and otherwise the review's own reading of
 * the row (`facets`). The person's choice of type always wins; an untagged row the review
 * classified is scored against that classification, so the entry's rating does not count as
 * nothing a row whose types its coverage half already reads. For a rules review `facets` is the
 * tags, so an untagged baseline row still has no types. Null when there are none either way,
 * because a row nobody has said the purpose of cannot be short of anything in particular. The
 * row's own cell on the page is not this: it scores against the tags only, and an untagged row
 * there reads "Select type". An unverified row — one the review could not tie to the person's
 * wording — earns no marks and serves no type, so it scores 0 once typed.
 *
 * `tagged` defaults to the tags the row carried when it was reviewed; pass the tags on screen to
 * re-score without another review. Like the entry's score it is computed here and gates nothing.
 */
export function libraryRowScore(
  row: LibraryRowReview,
  tagged: readonly EvidenceFacet[] = row.tagged,
): { score: number | null; facets: EvidenceFacet[]; byFacet: EvidenceFacetScore[]; marks: EvidenceMark[] } {
  const marks = row.verified ? row.marks : [];
  const scoredFacets = tagged.length ? tagged : row.facets;
  const facets = EVIDENCE_FACETS.filter(facet => scoredFacets.includes(facet));
  return { ...scoreRowAgainst(marks, facets), facets, marks };
}

/**
 * The score, pinned:
 *
 *     score = round(50 × coverage + 50 × meanRowScore)
 *
 *     coverage     = Σ LIBRARY_FACET_WEIGHTS[facet] over facets a verified row carries, ÷ 8
 *                    (a row carrying two of them covers both)
 *     meanRowScore = Σ libraryRowScore(row) ÷ 100 over every row, ÷ the number of rows, 0 when
 *                    there are none; a row is scored against its tags, or the review's reading
 *                    when it has none, and a row with neither, or unverified, counts 0
 *
 * So half the score is breadth — all six types present — and half is how well the rows are
 * written for the types they serve. All six types covered by rows that each earn every mark of
 * their types reads 100; an entry with no rows reads 0. An unverified row counts in the
 * denominator and adds nothing, so a model that cannot tie its classification to the row lowers
 * the score rather than raising it, and a row neither the person nor the review gave a type does
 * the same. An untagged row the model classified counts against the model's reading, so both
 * halves of the score read the row the same way.
 *
 * Bands: None < 25, Weak < 50, Good < 75, Strong at 75 and above.
 */
export function scoreLibraryRows(rows: LibraryRowReview[]): {
  score: number;
  rating: EvidenceRating;
  coverage: Record<EvidenceFacet, number>;
  missing: EvidenceFacet[];
} {
  const coverage = Object.fromEntries(EVIDENCE_FACETS.map(facet => [facet, 0])) as Record<EvidenceFacet, number>;
  let rowPoints = 0;
  for (const row of rows) {
    rowPoints += libraryRowScore(row).score ?? 0;
    if (!row.verified) continue;
    // Each type once, however many times the row was tagged with it.
    for (const facet of new Set(row.facets)) coverage[facet] += 1;
  }
  const present = EVIDENCE_FACETS.filter(facet => coverage[facet] > 0);
  const covered = present.reduce((sum, facet) => sum + LIBRARY_FACET_WEIGHTS[facet], 0) / TOTAL_FACET_WEIGHT;
  const meanRow = rows.length ? rowPoints / 100 / rows.length : 0;
  const score = Math.round(50 * covered + 50 * meanRow);
  return { score, rating: evidenceRatingFor(score), coverage, missing: BY_WEIGHT.filter(facet => coverage[facet] === 0) };
}

/** The questions for the facets an entry is missing: the heaviest three, in weight order. */
function promptsForMissing(missing: EvidenceFacet[]): string[] {
  return missing.slice(0, 3).map(facet => EVIDENCE_FACET_PROMPTS[facet]);
}

/**
 * Which facet a prompt is asking for, when the review says so, and null when it does not.
 *
 * The baseline's prompts are the facet questions themselves, so the Library can tag the row it
 * offers to add. A model writes its own wording, and a prompt that is not one of the six questions
 * is left untagged rather than guessed at: the person picks the facet, as they do for every other
 * row.
 */
export function facetForPrompt(prompt: string): EvidenceFacet | null {
  const asked = prompt.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  return EVIDENCE_FACETS.find(facet =>
    EVIDENCE_FACET_PROMPTS[facet].normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() === asked) ?? null;
}

/**
 * Rows a review is about: an entry's responsibility rows, minus the subsidiary labels that
 * `consolidateExperience` inserts to head a merged block. A label is not evidence —
 * `eligibleCvEvidence` already treats it that way — and counting one would penalise a person for
 * a merge they did not make.
 */
export function reviewableRows(entry: CvEntry): string[] {
  return evidenceRows(entry);
}

/** The review must belong to the library version it will be stored against. */
function assertEntryOf(entry: CvEntry, library: CvLibrary) {
  if (!library.entries.some(candidate => candidate.id === entry.id)) {
    throw new Error("The evidence review was given an entry from another library.");
  }
}

/**
 * The review an account gets without a model call, from its own tags and the wording rules.
 *
 * Every row is `verified`, because the person wrote it and tagged it: there is nothing to anchor.
 * Its marks are what `detectEvidenceMarks` finds in the wording. An untagged row carries no types,
 * covers no facet and has no score, which is exactly the state the prompts are there to fix.
 */
export function rulesLibraryReview(entry: CvEntry, library: CvLibrary): LibraryEntryReview {
  assertEntryOf(entry, library);
  const rows: LibraryRowReview[] = reviewableRows(entry).map(row => {
    const facets = rowFacets(entry, row);
    return {
      row,
      facets,
      tagged: facets,
      marks: detectEvidenceMarks(row),
      quote: row,
      verified: true,
    };
  });
  const scored = scoreLibraryRows(rows);
  return { entryId: entry.id, rows, ...scored, prompts: promptsForMissing(scored.missing) };
}

const reviewQuote = z.string().trim().min(1).max(1600);

/** What the model returns for one batch. Classifications and questions only: it never writes evidence. */
export const LibraryReviewPlanSchema = z.object({
  entries: z.array(z.object({
    entryId: z.string().min(1).max(100),
    rows: z.array(z.object({
      row: z.string().min(1).max(40000),
      /** Every type the row serves, and empty when it serves none clearly. */
      facets: z.array(z.enum(EVIDENCE_FACETS)).max(EVIDENCE_FACETS.length),
      /** Every mark in the rubric the row's wording earns, whatever it was tagged with. */
      marks: z.array(z.enum(EVIDENCE_MARKS as [EvidenceMark, ...EvidenceMark[]])).max(EVIDENCE_MARKS.length),
      quote: reviewQuote.nullable(),
    })).max(20),
    prompts: z.array(z.string().trim().min(1).max(160)).max(3),
  })).min(1).max(LIBRARY_REVIEW_BATCH),
});
export type LibraryReviewPlan = z.infer<typeof LibraryReviewPlanSchema>;
export type LibraryReviewPlanEntry = LibraryReviewPlan["entries"][number];

const normaliseRow = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();

/** The types named here, unique, in the canonical order, and nothing that is not one of the six. */
const knownFacets = (facets: readonly string[]): EvidenceFacet[] => EVIDENCE_FACETS.filter(facet => facets.includes(facet));

/**
 * Turn what the model said about one entry into the entry's review, keeping the entry's own rows
 * as the unit and the person's wording as the truth.
 *
 * The rules are the assessment's, for the same reason: the model classifies and asks, it never
 * rewrites. A row it invented is dropped. A row it did not cover, and a row whose quote is not
 * anchored in that row, is kept as `verified: false` and earns no marks — marked, never silently deleted, so the Library can say which rows went unread. A row it
 * covered without quoting is verified: the row text itself was matched exactly, so there is
 * nothing unanchored about it. When it covered none of them, the review is marked `unread`.
 * Demographic attributes in a prompt are refused outright, as `validateCvRubric` refuses them in a
 * requirement.
 *
 * A row's types and marks are deduplicated and anything outside the vocabulary is dropped from
 * them, rather than failing the row: the schema already holds the model to the rubric, and losing
 * a whole entry's classification over a repeated word would be a poor trade. `tagged` is always
 * the person's own tags, whatever the model classified the row as.
 *
 * `known` holds rows an earlier review of this entry already classified, keyed by their normalised
 * text (`knownLibraryRows`). A row found there takes that classification as it was stored — its
 * reading, marks, quote and verification — with only `tagged` replaced by the tags saved now, and
 * whatever the plan says about it is ignored: the model was told not to classify it, so an answer
 * for it is not one it was asked for. `unread` then means the entry had rows needing
 * classification and the model returned none of them; an entry whose rows were all known is never
 * unread.
 */
export function validateLibraryReview(
  entry: CvEntry,
  plan: LibraryReviewPlanEntry,
  known: ReadonlyMap<string, LibraryRowReview> = new Map(),
): LibraryEntryReview {
  if (plan.entryId !== entry.id) throw new Error("The evidence review named an entry it was not given.");
  const covered = new Map<string, LibraryReviewPlanEntry["rows"][number]>();
  for (const row of plan.rows) {
    const key = normaliseRow(row.row);
    if (!covered.has(key)) covered.set(key, row);
  }
  let classified = 0;
  let needed = 0;
  const rows: LibraryRowReview[] = reviewableRows(entry).map(row => {
    const tagged = rowFacets(entry, row);
    const held = known.get(normaliseRow(row));
    if (held) return { ...held, row, tagged };
    needed++;
    const said = covered.get(normaliseRow(row));
    if (said) classified++;
    const anchored = !!said && (said.quote === null || cvQuoteIsAnchored(said.quote, row));
    if (!said || !anchored) {
      return { row, facets: [], tagged, marks: [], quote: null, verified: false };
    }
    return {
      row,
      facets: knownFacets(said.facets),
      tagged,
      marks: knownEvidenceMarks(said.marks),
      quote: said.quote,
      verified: true,
    };
  });
  for (const prompt of plan.prompts) {
    if (mentionsDemographicAttribute(prompt)) throw new Error("Demographic attributes cannot be evidence prompts.");
  }
  const scored = scoreLibraryRows(rows);
  return {
    entryId: entry.id, rows, ...scored, prompts: plan.prompts.slice(0, 3),
    ...(needed && !classified ? { unread: true as const } : {}),
  };
}

/**
 * The rows a review already classified, for the next review of the same entry to keep: each
 * verified row keyed by its normalised text. An unverified row is left out — it says nothing about
 * the wording — so it is asked about again.
 */
export function knownLibraryRows(review: LibraryEntryReview): Map<string, LibraryRowReview> {
  const known = new Map<string, LibraryRowReview>();
  for (const row of review.rows) {
    const key = normaliseRow(row.row);
    if (row.verified && !known.has(key)) known.set(key, row);
  }
  return known;
}

/** The rows of an entry a review has to classify, given the rows already known. */
export function rowsToClassify(entry: CvEntry, known: ReadonlyMap<string, LibraryRowReview> = new Map()): string[] {
  return reviewableRows(entry).filter(row => !known.has(normaliseRow(row)));
}

/**
 * Whether an answer covers an entry: it names the entry and classifies every row that needed
 * classifying. An entry whose rows were all known is covered by being answered for at all, which
 * is where its prompts come from.
 */
export function libraryPlanCovers(
  entry: CvEntry,
  plan: LibraryReviewPlanEntry | undefined,
  known: ReadonlyMap<string, LibraryRowReview> = new Map(),
): boolean {
  if (!plan || plan.entryId !== entry.id) return false;
  const returned = new Set(plan.rows.map(row => normaliseRow(row.row)));
  return rowsToClassify(entry, known).every(row => returned.has(normaliseRow(row)));
}

/**
 * Which rubric a review was judged against. 1 was specific / quantified / outcome-linked; 2 is the
 * type-specific marks in `evidence-rubric.ts`; 3 is the same marks with the person's tags out of
 * the entry's hash. Move it when what a review records, or what its hash covers, changes meaning.
 *
 * Moving it re-reviews every entry but not every row: a re-review keeps the rows an earlier model
 * review of the entry classified (`knownLibraryRows`), whatever hash that review was filed under,
 * which is right from 2 to 3 because the marks mean the same. A version that changes what the marks
 * mean must also stop that reuse, or the old judgements are carried into the new rubric.
 */
export const LIBRARY_RUBRIC_VERSION = 3;

/**
 * Everything a review of this entry was computed from: its rows in order and the job it belongs
 * to. Nothing version-scoped, deliberately — an entry nobody touched keeps the same hash across a
 * save, so its review carries forward to the new library version and only the entry whose typo
 * was fixed is reviewed again.
 *
 * The person's tags are not in it. A review's marks and its reading of each row's types are
 * judgements about the wording, which a re-tag does not change, and the page re-scores a row
 * against the tags on screen itself (`libraryRowScore`), so re-tagging a row must not re-review
 * its entry and pay for the same answer again.
 *
 * The rubric's version leads the hashed list. A review written under an earlier rubric recorded
 * judgements the current score does not read (it has no marks), or was filed under a hash that
 * covered the tags, so moving the version makes every stored review stop matching its entry: the
 * Library falls back to the baseline and offers Re-score once, and the old reviews are left where
 * they are rather than deleted.
 */
export function libraryEntryInputHash(entry: CvEntry, employment: Employment | null): string {
  return sha1(JSON.stringify([
    LIBRARY_RUBRIC_VERSION,
    responsibilityRows(entry.details),
    employment?.company ?? "",
    employment?.jobTitle ?? "",
  ]));
}

/**
 * Deliberately loose: a stored review is this application's own writing, and the point of reading
 * it is to show a person their Library rather than to audit what an older release stored. Both
 * shapes of a row's classification are accepted, and the fields a review is scored from are read
 * as what they are or left at their empty value. `specific`, `quantified` and `outcomeLinked` are
 * what the first rubric wrote; they are accepted and no longer read.
 */
const StoredLibraryReviewSchema = z.object({
  entryId: z.string().min(1).max(100),
  rows: z.array(z.object({
    row: z.string(),
    /** Written by a release where a row had one type, or none ("unclear"). */
    facet: z.string().optional(),
    facets: z.array(z.string()).optional(),
    specific: z.boolean().optional(),
    quantified: z.boolean().optional(),
    outcomeLinked: z.boolean().optional(),
    marks: z.array(z.string()).optional(),
    tagged: z.array(z.string()).optional(),
    quote: z.string().nullable().optional(),
    verified: z.boolean().optional(),
  })).default([]),
  prompts: z.array(z.string()).default([]),
});

/**
 * A stored review, read back in today's shape whichever release wrote it.
 *
 * `cv_library_reviews.review` holds what the pass that produced it wrote, and a review from before
 * a row could carry several types names a single `facet`, which is `"unclear"` when the row served
 * none. An entry whose rows nobody has tagged hashes the same either way, so those reviews are not
 * rewritten by a re-review — they are simply read through here, by every reader.
 *
 * The score, its rating and the coverage are recomputed from the rows rather than taken from the
 * stored object, which returns exactly what was stored for every review written to date (one facet
 * is one facet, as a string or as a one-item list) and keeps a review that is read back internally
 * consistent with the rows it is about.
 *
 * A review written before marks existed carries none, so the wording rules stand in for that part
 * (`detectEvidenceMarks`), and one written before `tagged` existed reads as untagged — its rows
 * are scored against the review's own reading of them until the person's current tags are passed
 * to `libraryRowScore`.
 */
export function normaliseLibraryReview(raw: unknown): LibraryEntryReview {
  const stored = StoredLibraryReviewSchema.parse(raw);
  const rows: LibraryRowReview[] = stored.rows.map(row => ({
    row: row.row,
    facets: knownFacets(row.facets ?? (row.facet === undefined ? [] : [row.facet])),
    tagged: knownFacets(row.tagged ?? []),
    marks: row.marks ? knownEvidenceMarks(row.marks) : detectEvidenceMarks(row.row),
    quote: row.quote ?? null,
    verified: row.verified === true,
  }));
  return { entryId: stored.entryId, rows, ...scoreLibraryRows(rows), prompts: stored.prompts.slice(0, 3) };
}

/**
 * A model review read against the tags the entry carries now, rescored.
 *
 * The entry's hash leaves the tags out, so a review of the same wording is still this entry's
 * review after the person re-tags a row — but the `tagged` it recorded, and the score read off
 * them, are the tags as they were. The marks and the review's own reading of each row are about
 * the wording and stand; only the tags are replaced. A rules review is not re-read here: its
 * `facets` are the tags too, so the baseline is simply computed again (`rulesLibraryReview`).
 */
export function retagLibraryReview(review: LibraryEntryReview, entry: CvEntry): LibraryEntryReview {
  const rows = review.rows.map(row => ({ ...row, tagged: rowFacets(entry, row.row) }));
  return { ...review, rows, ...scoreLibraryRows(rows) };
}
