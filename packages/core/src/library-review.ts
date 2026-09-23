/**
 * How much evidence one library entry actually carries, and what to ask for next.
 *
 * Evidence quality is judged today only at CV time, once per CV, inside a $2 assessment against a
 * particular job description. That is the wrong moment and the wrong price: the person writes the
 * entry weeks earlier, with no idea whether a reviewer will find anything in it. This module
 * scores an entry on its own terms, with no job description and no rubric, on the three ideas the
 * CV assessment already uses — coverage (is each facet present), specificity (is the row concrete
 * or generic) and support (is there a number, a scope or a named outcome).
 *
 * Two things are deliberate. The score is computed here, from classifications, and never taken
 * from the model: `scoreLibraryRows` is the only place a number is produced, so a model cannot
 * flatter an entry. And the score gates nothing — an entry rated None is still active evidence if
 * the person says so, exactly as the fit score ranks a role without ever removing it.
 *
 * `rulesLibraryReview` is the no-model baseline, computed from the person's own facet tags. It is
 * what the Library shows the moment a save lands, before the A12 call has run, and it is the whole
 * feature for an account that has spent its budget.
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
import { cvQuoteIsAnchored, mentionsDemographicAttribute } from "./cv-review";
import { sha1 } from "./normalize";

type CvEntry = CvLibrary["entries"][number];

/** How much evidence an entry carries. Mirrors `EVIDENCE_RATINGS` in @ava/db. */
export const EVIDENCE_RATINGS = ["none", "weak", "good", "strong"] as const;
export type EvidenceRating = (typeof EVIDENCE_RATINGS)[number];

/**
 * Who produced a review: the deterministic baseline from the person's own tags, or the model.
 * Mirrors `LIBRARY_REVIEW_SOURCES` in @ava/db.
 */
export const LIBRARY_REVIEW_SOURCES = ["rules", "model"] as const;
export type LibraryReviewSource = (typeof LIBRARY_REVIEW_SOURCES)[number];

/** Entries per model call, so the whole library is written to the cache once and read back. */
export const LIBRARY_REVIEW_BATCH = 8;

/**
 * One row, classified. `verified` is false when the classification could not be tied to the row.
 *
 * `facets` is every type the row serves, and empty when it serves none clearly — which is what
 * "unclear" used to say, and what an unverified row always says. A row counts for each of them, so
 * the problem someone solved and the figure it moved can be one sentence and cover both.
 */
export interface LibraryRowReview {
  row: string;
  facets: EvidenceFacet[];
  specific: boolean;
  quantified: boolean;
  outcomeLinked: boolean;
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
 * The score, pinned:
 *
 *     score = round(50 × coverage + 25 × specificShare + 25 × quantifiedShare)
 *
 *     coverage        = Σ LIBRARY_FACET_WEIGHTS[facet] over facets a verified row carries, ÷ 8
 *                       (a row carrying two of them covers both)
 *     specificShare   = verified rows marked specific    ÷ every row, 0 when there are none
 *     quantifiedShare = verified rows marked quantified  ÷ every row, 0 when there are none
 *
 * So half the score is breadth — all six facets present — and half is how the rows are written,
 * split evenly between being concrete and carrying a number. All six facets covered by rows that
 * are every one of them specific and quantified reads 100; an entry with no rows reads 0. An
 * unverified row counts in the denominator and in neither numerator, so a model that cannot tie
 * its classification to the row lowers the score rather than raising it.
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
  let specific = 0;
  let quantified = 0;
  for (const row of rows) {
    if (!row.verified) continue;
    // Each type once, however many times the row was tagged with it.
    for (const facet of new Set(row.facets)) coverage[facet] += 1;
    if (row.specific) specific += 1;
    if (row.quantified) quantified += 1;
  }
  const present = EVIDENCE_FACETS.filter(facet => coverage[facet] > 0);
  const covered = present.reduce((sum, facet) => sum + LIBRARY_FACET_WEIGHTS[facet], 0) / TOTAL_FACET_WEIGHT;
  const share = (count: number) => (rows.length ? count / rows.length : 0);
  const score = Math.round(50 * covered + 25 * share(specific) + 25 * share(quantified));
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
 * A number, a percentage or an amount of money anywhere in the row.
 *
 * Deliberately crude: a year in "Shipped in 2024" counts, and so it should — a row that names a
 * date is more use to a reviewer than one that does not — and the cost of the occasional false
 * positive is a slightly generous score on an entry the person can see for themselves.
 */
const QUANTITY = /[0-9%£$€]/u;

/**
 * Units a claim is usually measured in, for rows that name a scope without a digit ("cut handover
 * time from days to hours", "a team across four countries"). A short list on purpose: this is the
 * baseline shown before the model has run, not the judgement.
 */
const UNIT = /\b(hrs?|hours?|days?|weeks?|months?|years?|people|staff|users?|customers?|clients?|countries|teams?|sites?|fte|nps|arr|mrr|sla|kpis?)\b/i;

/** A word that is capitalised and is not simply the one the row opens with. */
function namesSomething(words: string[]): boolean {
  return words.slice(1).some(word => /^\p{Lu}/u.test(word));
}

/**
 * Concrete rather than generic: at least eight words, and naming something a reader could check —
 * a capitalised term, a number, or one of the units above. "Responsible for operations" fails on
 * both counts; "Ran the UK warehouse team through a move to a new site" passes on length and the
 * capitalised term.
 */
function looksSpecific(row: string): boolean {
  const words = row.split(/\s+/u).filter(Boolean);
  return words.length >= 8 && (namesSomething(words) || QUANTITY.test(row) || UNIT.test(row));
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
 * The review an account gets without a model call, from its own facet tags and two heuristics.
 *
 * Every row is `verified`, because the person wrote it and tagged it: there is nothing to anchor.
 * An untagged row carries no types and covers no facet, which is exactly the state the prompts are
 * there to fix.
 */
export function rulesLibraryReview(entry: CvEntry, library: CvLibrary): LibraryEntryReview {
  assertEntryOf(entry, library);
  const rows: LibraryRowReview[] = reviewableRows(entry).map(row => {
    const facets = rowFacets(entry, row);
    return {
      row,
      facets,
      specific: looksSpecific(row),
      quantified: QUANTITY.test(row),
      outcomeLinked: facets.includes("outcome") || facets.includes("metric"),
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
      specific: z.boolean(),
      quantified: z.boolean(),
      outcomeLinked: z.boolean(),
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
 * anchored in that row, is kept as `verified: false` and counts as neither specific nor quantified
 * — marked, never silently deleted, so the Library can say which rows went unread. A row it
 * covered without quoting is verified: the row text itself was matched exactly, so there is
 * nothing unanchored about it. Demographic attributes in a prompt are refused outright, as
 * `validateCvRubric` refuses them in a requirement.
 *
 * A row's types are deduplicated and anything outside the vocabulary is dropped from them, rather
 * than failing the row: the schema already holds the model to the six, and losing a whole entry's
 * classification over a repeated word would be a poor trade.
 */
export function validateLibraryReview(entry: CvEntry, plan: LibraryReviewPlanEntry): LibraryEntryReview {
  if (plan.entryId !== entry.id) throw new Error("The evidence review named an entry it was not given.");
  const covered = new Map<string, LibraryReviewPlanEntry["rows"][number]>();
  for (const row of plan.rows) {
    const key = normaliseRow(row.row);
    if (!covered.has(key)) covered.set(key, row);
  }
  const rows: LibraryRowReview[] = reviewableRows(entry).map(row => {
    const said = covered.get(normaliseRow(row));
    const anchored = !!said && (said.quote === null || cvQuoteIsAnchored(said.quote, row));
    if (!said || !anchored) {
      return { row, facets: [], specific: false, quantified: false, outcomeLinked: false, quote: null, verified: false };
    }
    return {
      row,
      facets: knownFacets(said.facets),
      specific: said.specific,
      quantified: said.quantified,
      outcomeLinked: said.outcomeLinked,
      quote: said.quote,
      verified: true,
    };
  });
  for (const prompt of plan.prompts) {
    if (mentionsDemographicAttribute(prompt)) throw new Error("Demographic attributes cannot be evidence prompts.");
  }
  const scored = scoreLibraryRows(rows);
  return { entryId: entry.id, rows, ...scored, prompts: plan.prompts.slice(0, 3) };
}

/**
 * Everything a review of this entry was computed from: its rows in order, the types on each, and
 * the job it belongs to. Nothing version-scoped, deliberately — an entry nobody touched keeps the
 * same hash across a save, so its review carries forward to the new library version and only the
 * entry whose typo was fixed is reviewed again.
 *
 * The types are written in canonical order and joined, so a row's tags read as one string: adding
 * a second type to a row changes the hash and re-reviews that entry, and a row that was tagged
 * with exactly one type — every row stored before a row could carry several — hashes to what it
 * always did. Representing the same tags differently is not a reason to buy the same answer again.
 */
export function libraryEntryInputHash(entry: CvEntry, employment: Employment | null): string {
  const rows = responsibilityRows(entry.details);
  return sha1(JSON.stringify([
    rows,
    rows.map(row => rowFacets(entry, row).join(",")),
    employment?.company ?? "",
    employment?.jobTitle ?? "",
  ]));
}

/**
 * Deliberately loose: a stored review is this application's own writing, and the point of reading
 * it is to show a person their Library rather than to audit what an older release stored. Both
 * shapes of a row's classification are accepted, and the fields a review is scored from are read
 * as what they are or left at their empty value.
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
 */
export function normaliseLibraryReview(raw: unknown): LibraryEntryReview {
  const stored = StoredLibraryReviewSchema.parse(raw);
  const rows: LibraryRowReview[] = stored.rows.map(row => ({
    row: row.row,
    facets: knownFacets(row.facets ?? (row.facet === undefined ? [] : [row.facet])),
    specific: row.specific === true,
    quantified: row.quantified === true,
    outcomeLinked: row.outcomeLinked === true,
    quote: row.quote ?? null,
    verified: row.verified === true,
  }));
  return { entryId: stored.entryId, rows, ...scoreLibraryRows(rows), prompts: stored.prompts.slice(0, 3) };
}
