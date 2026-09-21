/**
 * The evidence score: the formula at its corners, the no-model baseline, what survives a model
 * that cannot quote itself, and the hash that decides which entries are re-reviewed.
 */
import { describe, expect, it } from "vitest";
import {
  LIBRARY_FACET_WEIGHTS,
  LibraryReviewPlanSchema,
  evidenceRatingFor,
  facetForPrompt,
  libraryEntryInputHash,
  normaliseLibraryReview,
  reviewableRows,
  rulesLibraryReview,
  scoreLibraryRows,
  validateLibraryReview,
  type LibraryReviewPlanEntry,
  type LibraryRowReview,
} from "./library-review";
import { sha1 } from "./normalize";
import { EVIDENCE_FACETS, EVIDENCE_FACETS_BY_NEED, EVIDENCE_FACET_PROMPTS, consolidateExperience, setRowFacets, type CvLibrary, type Employment, type EvidenceFacet } from "./cv";

const row = (over: Partial<LibraryRowReview> = {}): LibraryRowReview => ({
  row: over.row ?? "A row",
  facets: ["responsibility"],
  specific: false,
  quantified: false,
  outcomeLinked: false,
  quote: null,
  verified: true,
  ...over,
});

/** One row per facet, so coverage is complete and the quality term is the only variable. */
const oneEach = (over: Partial<LibraryRowReview> = {}) =>
  EVIDENCE_FACETS.map((facet, index) => row({ row: `Row ${index}`, facets: [facet], ...over }));

const job: Employment = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };

function library(details: string, facets: Record<string, EvidenceFacet | EvidenceFacet[]> = {}): CvLibrary {
  let entry: CvLibrary["entries"][number] = { id: "acme-block", kind: "experience", status: "active", heading: "Operations Director · Acme", details, employmentId: "acme" };
  for (const [text, facet] of Object.entries(facets)) entry = setRowFacets(entry, text, Array.isArray(facet) ? facet : [facet]);
  return { name: "Test Candidate", contact: "London", profile: "Operations", structuredExperience: true, employment: [job], entries: [entry] };
}

describe("scoreLibraryRows", () => {
  it("reads 0 for an entry with nothing in it, and asks for the heaviest facets first", () => {
    const empty = scoreLibraryRows([]);
    expect(empty).toMatchObject({ score: 0, rating: "none" });
    expect(empty.coverage).toEqual({ responsibility: 0, problem: 0, outcome: 0, metric: 0, milestone: 0, style: 0 });
    // Outcome and metric are worth two each, so they are what a blank entry is asked for first.
    expect(empty.missing).toEqual(["outcome", "metric", "responsibility", "problem", "milestone", "style"]);
  });

  it("reads 100 only when all six facets are covered by specific, quantified rows", () => {
    const perfect = scoreLibraryRows(oneEach({ specific: true, quantified: true }));
    expect(perfect).toMatchObject({ score: 100, rating: "strong", missing: [] });
    expect(perfect.coverage).toEqual({ responsibility: 1, problem: 1, outcome: 1, metric: 1, milestone: 1, style: 1 });
    // 50 × coverage + 25 × specific share + 25 × quantified share, pinned term by term.
    expect(scoreLibraryRows(oneEach()).score).toBe(50);
    expect(scoreLibraryRows(oneEach({ specific: true })).score).toBe(75);
    expect(scoreLibraryRows(oneEach({ quantified: true })).score).toBe(75);
  });

  it("weights coverage by facet: an outcome or a metric is worth two of anything else", () => {
    const weightOf = (facet: EvidenceFacet) => scoreLibraryRows([row({ facets: [facet] })]).score;
    // 50 × (weight ÷ 8), with no specific or quantified rows to add to it.
    expect(weightOf("responsibility")).toBe(Math.round(50 / 8));
    expect(weightOf("outcome")).toBe(Math.round(100 / 8));
    expect(weightOf("metric")).toBe(weightOf("outcome"));
    expect(Object.values(LIBRARY_FACET_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(8);
    // A second row of the same facet counts in coverage but adds no breadth.
    expect(scoreLibraryRows([row({ facets: ["outcome"] }), row({ row: "b", facets: ["outcome"] })]).coverage.outcome).toBe(2);
    expect(scoreLibraryRows([row({ facets: ["outcome"] }), row({ row: "b", facets: ["outcome"] })]).score).toBe(weightOf("outcome"));
  });

  it("bands at None < 25, Weak < 50, Good < 75, Strong", () => {
    expect([24, 25, 49, 50, 74, 75, 100].map(evidenceRatingFor)).toEqual(
      ["none", "weak", "weak", "good", "good", "strong", "strong"]);
    expect(evidenceRatingFor(0)).toBe("none");
    expect(evidenceRatingFor(24.9)).toBe("none");
    // Three single-weight facets: 50 × 3/8 = 18.75 → 19, below the Weak floor.
    expect(scoreLibraryRows([row({ facets: ["responsibility"] }), row({ row: "b", facets: ["problem"] }), row({ row: "c", facets: ["milestone"] })]))
      .toMatchObject({ score: 19, rating: "none" });
    // Outcome and metric alone: 50 × 4/8 = 25, exactly the Weak floor.
    expect(scoreLibraryRows([row({ facets: ["outcome"] }), row({ row: "b", facets: ["metric"] })]))
      .toMatchObject({ score: 25, rating: "weak" });
    // All six facets, five of six rows specific: 50 + 25 × 5/6 = 70.83 → 71, one band below Strong.
    const almost = oneEach().map((item, index) => ({ ...item, specific: index > 0 }));
    expect(scoreLibraryRows(almost)).toMatchObject({ score: 71, rating: "good" });
  });

  it("gives an unverified row no types and no quality, and still counts it against the share", () => {
    const rows = [row({ facets: ["outcome"], specific: true, quantified: true }), row({ row: "b", facets: ["metric"], specific: true, quantified: true, verified: false })];
    const scored = scoreLibraryRows(rows);
    expect(scored.coverage).toMatchObject({ outcome: 1, metric: 0 });
    expect(scored.missing).toContain("metric");
    // 50 × 2/8 + 25 × 1/2 + 25 × 1/2 = 37.5 → 38, against 75 had both rows been verified.
    expect(scored.score).toBe(38);
    expect(scoreLibraryRows(rows.map(item => ({ ...item, verified: true }))).score).toBe(75);
    // A verified row whose types the model could not name covers nothing but still counts.
    expect(scoreLibraryRows([row({ facets: [], specific: true, quantified: true })]).score).toBe(50);
    // One row can carry two types and covers both: outcome and metric are 50 × 4/8 on their own.
    expect(scoreLibraryRows([row({ facets: ["metric", "outcome"] })])).toMatchObject({ score: 25, rating: "weak" });
    expect(scoreLibraryRows([row({ facets: ["metric", "outcome"] })]).coverage).toMatchObject({ outcome: 1, metric: 1 });
    // A type repeated on one row is one row's worth of it, not two.
    expect(scoreLibraryRows([row({ facets: ["outcome", "outcome"] })]).coverage.outcome).toBe(1);
  });
});

describe("rulesLibraryReview", () => {
  const generic = "Responsible for operations";
  const scoped = "Responsible for operations across the warehouse and the transport team";
  const named = "Rebuilt the Acme onboarding flow from scratch with the design group";
  const counted = "Cut onboarding time by 40%";
  const waffle = "We worked together to make sure that everything was done properly and on schedule";

  const subject = library([generic, scoped, named, counted, waffle].join("\n"), {
    [scoped]: "responsibility", [named]: "milestone", [counted]: "metric",
  });
  const review = rulesLibraryReview(subject.entries[0]!, subject);
  const byRow = new Map(review.rows.map(item => [item.row, item]));

  it("marks a row specific only when it is long enough and names something checkable", () => {
    expect(byRow.get(generic)!.specific).toBe(false);   // three words
    expect(byRow.get(scoped)!.specific).toBe(true);     // ten words, names a unit ("team")
    expect(byRow.get(named)!.specific).toBe(true);      // eleven words, names "Acme"
    expect(byRow.get(counted)!.specific).toBe(false);   // five words: a number is not enough
    expect(byRow.get(waffle)!.specific).toBe(false);    // long, but names nothing
  });

  it("marks a row quantified on a number, a percentage or an amount of money", () => {
    expect(byRow.get(counted)!.quantified).toBe(true);
    expect(byRow.get(scoped)!.quantified).toBe(false);
    for (const text of ["Saved £40k a year", "Grew it to 3 sites", "Took 25% out of the cost"]) {
      const one = library(text);
      expect(rulesLibraryReview(one.entries[0]!, one).rows[0]!.quantified).toBe(true);
    }
  });

  it("takes the types from the person's own tags, quotes the row itself, and verifies it", () => {
    expect(byRow.get(named)!.facets).toEqual(["milestone"]);
    expect(byRow.get(generic)!.facets).toEqual([]);
    expect(byRow.get(counted)).toMatchObject({ facets: ["metric"], outcomeLinked: true, quote: counted, verified: true });
    expect(byRow.get(named)!.outcomeLinked).toBe(false);
    expect(review.coverage).toMatchObject({ responsibility: 1, milestone: 1, metric: 1, outcome: 0, problem: 0, style: 0 });
  });

  it("counts a row tagged with two types for both of them", () => {
    const both = "Cut the weekend backlog by 40% after taking over a broken handover";
    const subject = library([both, "Did some things"].join("\n"), { [both]: ["metric", "problem"] });
    const review = rulesLibraryReview(subject.entries[0]!, subject);
    expect(review.rows[0]).toMatchObject({ facets: ["problem", "metric"], outcomeLinked: true, verified: true });
    expect(review.coverage).toMatchObject({ problem: 1, metric: 1 });
    expect(review.missing).toEqual(["outcome", "responsibility", "milestone", "style"]);
    // Problem and metric together, one of the two rows specific and quantified:
    // 50 × 3/8 + 25 × 1/2 + 25 × 1/2 = 43.75 → 44.
    expect(review.score).toBe(44);
    // An untagged row carries no types, which is what the prompts are there to fix.
    expect(review.rows[1]).toMatchObject({ facets: [], outcomeLinked: false, verified: true });
  });

  it("asks at most three questions, for the heaviest facets it cannot find", () => {
    expect(review.missing).toEqual(["outcome", "problem", "style"]);
    expect(review.prompts).toEqual([
      "What changed as a result?",
      "What problem or constraint were you there to solve?",
      "How do you work with other people to get this done?",
    ]);
    const blank = library("Did some things");
    expect(rulesLibraryReview(blank.entries[0]!, blank)).toMatchObject({ score: 0, rating: "none" });
    expect(rulesLibraryReview(blank.entries[0]!, blank).prompts).toHaveLength(3);
  });

  it("ignores the subsidiary labels a consolidation inserts, and refuses another library's entry", () => {
    const labelled = library(["Acme Subsidiary:", named, counted].join("\n"));
    expect(reviewableRows(labelled.entries[0]!)).toEqual([named, counted]);
    expect(rulesLibraryReview(labelled.entries[0]!, labelled).rows.map(item => item.row)).toEqual([named, counted]);
    expect(() => rulesLibraryReview({ ...labelled.entries[0]!, id: "elsewhere" }, labelled)).toThrow(/another library/);
  });
});

describe("validateLibraryReview", () => {
  const first = "Rebuilt the Acme onboarding flow from scratch with the design group";
  const second = "Cut onboarding time by 40%";
  const subject = library([first, second].join("\n"));
  const entry = subject.entries[0]!;
  const said = (over: Partial<LibraryReviewPlanEntry["rows"][number]> = {}) => ({
    row: first, facets: ["outcome"] as EvidenceFacet[], specific: true, quantified: true, outcomeLinked: true, quote: "Rebuilt the Acme onboarding flow", ...over,
  });
  const plan = (rows: LibraryReviewPlanEntry["rows"], prompts: string[] = []): LibraryReviewPlanEntry => ({ entryId: entry.id, rows, prompts });

  it("keeps the entry's own rows and drops the ones the model invented", () => {
    const result = validateLibraryReview(entry, plan([said(), said({ row: "A row nobody wrote", quote: null })]));
    expect(result.rows.map(item => item.row)).toEqual([first, second]);
    expect(result.rows[0]).toMatchObject({ facets: ["outcome"], specific: true, quantified: true, verified: true });
    // The row the model never mentioned is marked, not dropped: the Library can say it went unread.
    expect(result.rows[1]).toMatchObject({ row: second, facets: [], specific: false, quantified: false, verified: false, quote: null });
  });

  it("matches a row after NFKC and whitespace normalisation, but only once", () => {
    const spaced = plan([said({ row: `  Rebuilt   the Acme onboarding\tflow from scratch with the design group ` }), said({ specific: false, quantified: false })]);
    const result = validateLibraryReview(entry, spaced);
    // The first classification of a row wins; a second one for the same row is ignored.
    expect(result.rows[0]).toMatchObject({ verified: true, specific: true, quantified: true });
  });

  it("marks a row unverified when its quote is not anchored in that row", () => {
    const result = validateLibraryReview(entry, plan([said({ quote: "Rebuilt the Globex onboarding flow" })]));
    expect(result.rows[0]).toMatchObject({ verified: false, specific: false, quantified: false, quote: null, facets: [] });
    expect(result.score).toBe(0);
    // A classification with no quote at all is verified: the row text itself was matched exactly.
    expect(validateLibraryReview(entry, plan([said({ quote: null })])).rows[0]).toMatchObject({ verified: true, facets: ["outcome"] });
  });

  it("scores from the classifications, never from the model, and keeps its prompts", () => {
    const both = plan([said(), said({ row: second, facets: ["metric"], quote: "by 40%" })], ["What changed as a result?"]);
    const result = validateLibraryReview(entry, both);
    // Outcome and metric: 50 × 4/8 + 25 + 25 = 75.
    expect(result).toMatchObject({ entryId: entry.id, score: 75, rating: "strong", prompts: ["What changed as a result?"] });
    expect(result.missing).toEqual(["responsibility", "problem", "milestone", "style"]);
  });

  it("refuses demographic prompts and a plan for another entry", () => {
    expect(() => validateLibraryReview(entry, plan([said()], ["What is your date of birth?"]))).toThrow(/Demographic/);
    expect(() => validateLibraryReview(entry, plan([said()], ["Which religion do you practise?"]))).toThrow(/Demographic/);
    expect(() => validateLibraryReview(entry, { ...plan([said()]), entryId: "somewhere-else" })).toThrow(/not given/);
  });

  it("bounds what the model may return", () => {
    const valid = { entries: [plan([said()], ["Ask something"])] };
    expect(LibraryReviewPlanSchema.parse(valid).entries[0]!.rows[0]!.facets).toEqual(["outcome"]);
    expect(LibraryReviewPlanSchema.safeParse({ entries: [plan([said({ facets: ["vibes"] as never })])] }).success).toBe(false);
    // None is an empty list, and no row may name more types than there are.
    expect(LibraryReviewPlanSchema.safeParse({ entries: [plan([said({ facets: [] })])] }).success).toBe(true);
    expect(LibraryReviewPlanSchema.safeParse({ entries: [plan([said({ facets: [...EVIDENCE_FACETS, "outcome"] as never })])] }).success).toBe(false);
    expect(LibraryReviewPlanSchema.safeParse({ entries: [plan([said()], ["a", "b", "c", "d"])] }).success).toBe(false);
    expect(LibraryReviewPlanSchema.safeParse({ entries: [plan([said()], ["x".repeat(161)])] }).success).toBe(false);
    // Eight entries a batch, so the whole library is written to the cache once and read back.
    expect(LibraryReviewPlanSchema.safeParse({ entries: Array.from({ length: 9 }, () => plan([])) }).success).toBe(false);
  });
});

describe("libraryEntryInputHash", () => {
  const first = "Rebuilt the Acme onboarding flow from scratch with the design group";
  const second = "Cut onboarding time by 40%";
  const subject = library([first, second].join("\n"), { [second]: "metric" });
  const entry = subject.entries[0]!;
  const hash = libraryEntryInputHash(entry, job);

  it("is stable across library versions when nothing about the entry changed", () => {
    // A save that changes another entry, the library's name or its version leaves this one alone.
    const later = library([first, second].join("\n"), { [second]: "metric" });
    expect(libraryEntryInputHash(later.entries[0]!, job)).toBe(hash);
    expect(libraryEntryInputHash({ ...entry, heading: "Renamed", status: "inactive" }, job)).toBe(hash);
    expect(libraryEntryInputHash({ ...entry, confirmedResponsibilities: [first] }, job)).toBe(hash);
  });

  it("changes when a row, its order, its types or the job it belongs to changes", () => {
    const changed = [
      libraryEntryInputHash(library([first, "Cut onboarding time by 45%"].join("\n"), { [second]: "metric" }).entries[0]!, job),
      libraryEntryInputHash(library([second, first].join("\n"), { [second]: "metric" }).entries[0]!, job),
      libraryEntryInputHash(library([first, second].join("\n"), { [second]: "outcome" }).entries[0]!, job),
      // A second type on a row is a different classification, so that entry is reviewed again.
      libraryEntryInputHash(library([first, second].join("\n"), { [second]: ["metric", "outcome"] }).entries[0]!, job),
      libraryEntryInputHash(library([first, second].join("\n")).entries[0]!, job),
      libraryEntryInputHash(entry, { ...job, company: "Globex" }),
      libraryEntryInputHash(entry, { ...job, jobTitle: "Head of Operations" }),
      libraryEntryInputHash(entry, null),
    ];
    expect(new Set([hash, ...changed]).size).toBe(changed.length + 1);
    // Dates are not in it: moving an end date re-renders the heading, it does not change the evidence.
    expect(libraryEntryInputHash(entry, { ...job, current: false, endDate: "2026-01" })).toBe(hash);
  });

  it("survives the consolidation the editor runs on every open and save", () => {
    const consolidated = consolidateExperience(subject);
    expect(consolidated.facetedRows).toBe(true);
    expect(libraryEntryInputHash(consolidated.entries[0]!, job)).toBe(hash);
  });

  it("hashes a row of one type exactly as the release that stored it as a string did", () => {
    // Every review stored to date was written against this hash. Rows in order, each row's types
    // joined, the company and the job title: one type joins to itself and an untagged row to "",
    // so nobody's Library is re-reviewed, and nothing is paid for again, over how tags are stored.
    expect(libraryEntryInputHash(entry, job)).toBe(sha1(JSON.stringify([[first, second], ["", "metric"], job.company, job.jobTitle])));
    expect(libraryEntryInputHash(library([first, second].join("\n"), { [second]: ["outcome", "metric"] }).entries[0]!, job))
      .toBe(sha1(JSON.stringify([[first, second], ["", "outcome,metric"], job.company, job.jobTitle])));
    // And the entry as that release actually stored it — the tag a bare string, not a one-item
    // list — hashes to the same thing unparsed, which is the shape the worker's handler reads
    // `cv_libraries.content` in.
    const stored = { ...entry, rowFacets: { [second]: "metric" } } as unknown as typeof entry;
    expect(libraryEntryInputHash(stored, job)).toBe(libraryEntryInputHash(entry, job));
  });
});

describe("normaliseLibraryReview", () => {
  const stored = (rows: unknown[]) => ({
    entryId: "acme-block", rows, coverage: { responsibility: 0, problem: 0, outcome: 1, metric: 0, milestone: 0, style: 0 },
    missing: ["metric"], prompts: ["What changed as a result?"], score: 75, rating: "strong",
  });

  it("reads a review written before a row could carry several types", () => {
    const review = normaliseLibraryReview(stored([
      { row: "Rebuilt the onboarding flow", facet: "outcome", specific: true, quantified: true, outcomeLinked: true, quote: "Rebuilt the onboarding flow", verified: true },
      { row: "Did some things", facet: "unclear", specific: false, quantified: false, outcomeLinked: false, quote: null, verified: true },
    ]));
    expect(review.rows.map(row => row.facets)).toEqual([["outcome"], []]);
    expect(review.rows[0]).toMatchObject({ specific: true, quantified: true, verified: true, quote: "Rebuilt the onboarding flow" });
    expect(review.prompts).toEqual(["What changed as a result?"]);
    // Recomputed from the rows, and the same number the release that wrote it stored.
    expect(review).toMatchObject({ entryId: "acme-block", score: Math.round(50 * 2 / 8 + 25 * 0.5 + 25 * 0.5), rating: "weak" });
    expect(review.coverage).toMatchObject({ outcome: 1, metric: 0 });
    expect(review.missing).toEqual(["metric", "responsibility", "problem", "milestone", "style"]);
  });

  it("reads today's shape unchanged, and anything outside the vocabulary as nothing", () => {
    const rows = [{ row: "Cut handover time by 40%", facets: ["metric", "problem", "vibes"], specific: true, quantified: true, outcomeLinked: true, quote: "by 40%", verified: true }];
    const review = normaliseLibraryReview(stored(rows));
    expect(review.rows[0]!.facets).toEqual(["problem", "metric"]);
    expect(normaliseLibraryReview(stored([{ row: "A row nobody classified" }])).rows[0])
      .toEqual({ row: "A row nobody classified", facets: [], specific: false, quantified: false, outcomeLinked: false, quote: null, verified: false });
    expect(() => normaliseLibraryReview({ rows: [] })).toThrow();
  });
});

it("reports missing facets in the order the editor asks for them", () => {
  // `EVIDENCE_FACETS_BY_NEED` is written out in cv.ts so the editor can order its hints without
  // loading the scorer; this is what holds it to the weights the scorer actually uses.
  expect(rulesLibraryReview(library("A row with nothing tagged on it").entries[0]!, library("A row with nothing tagged on it")).missing)
    .toEqual([...EVIDENCE_FACETS_BY_NEED]);
});

describe("facetForPrompt", () => {
  it("names the facet behind each baseline question and refuses to guess at any other", () => {
    for (const facet of EVIDENCE_FACETS) expect(facetForPrompt(EVIDENCE_FACET_PROMPTS[facet])).toBe(facet);
    // Whitespace and case are the model's to get wrong; the question is still the same question.
    expect(facetForPrompt("  what changed as a  result?  ")).toBe("outcome");
    expect(facetForPrompt("What did the board say about the migration?")).toBeNull();
    expect(facetForPrompt("")).toBeNull();
  });
});
