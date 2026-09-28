/**
 * The evidence score: the formula at its corners, the no-model baseline, what survives a model
 * that cannot quote itself, and the hash that decides which entries are re-reviewed.
 */
import { describe, expect, it } from "vitest";
import {
  LIBRARY_FACET_WEIGHTS,
  LIBRARY_RUBRIC_VERSION,
  LibraryReviewPlanSchema,
  evidenceRatingFor,
  facetForPrompt,
  libraryEntryInputHash,
  libraryRowScore,
  knownLibraryRows,
  libraryPlanCovers,
  normaliseLibraryReview,
  retagLibraryReview,
  reviewableRows,
  rowsToClassify,
  rulesLibraryReview,
  scoreLibraryRows,
  validateLibraryReview,
  type LibraryReviewPlanEntry,
  type LibraryRowReview,
} from "./library-review";
import { sha1 } from "./normalize";
import { EVIDENCE_MARKS, EVIDENCE_MARKS_BY_FACET, detectEvidenceMarks, type EvidenceMark } from "./evidence-rubric";
import { EVIDENCE_FACETS, EVIDENCE_FACETS_BY_NEED, EVIDENCE_FACET_PROMPTS, consolidateExperience, setRowFacets, type CvLibrary, type Employment, type EvidenceFacet } from "./cv";

/** A reviewed row, tagged by the person with what the review says it serves unless told otherwise. */
const row = (over: Partial<LibraryRowReview> = {}): LibraryRowReview => ({
  row: over.row ?? "A row",
  facets: over.facets ?? ["responsibility"],
  tagged: over.tagged ?? over.facets ?? ["responsibility"],
  marks: [],
  quote: null,
  verified: true,
  ...over,
});

/** The first `count` marks of each type's checklist. */
const firstMarks = (count: number, facets: readonly EvidenceFacet[] = EVIDENCE_FACETS): EvidenceMark[] =>
  facets.flatMap(facet => EVIDENCE_MARKS_BY_FACET[facet].slice(0, count));

/** One row per facet, so coverage is complete and the rows' own scores are the only variable. */
const oneEach = (marks: number = 0) =>
  EVIDENCE_FACETS.map((facet, index) => row({ row: `Row ${index}`, facets: [facet], marks: firstMarks(marks, [facet]) }));

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

  it("reads 100 only when all six facets are covered by rows that earn every mark of their type", () => {
    const perfect = scoreLibraryRows(oneEach(4));
    expect(perfect).toMatchObject({ score: 100, rating: "strong", missing: [] });
    expect(perfect.coverage).toEqual({ responsibility: 1, problem: 1, outcome: 1, metric: 1, milestone: 1, style: 1 });
    // 50 × coverage + 50 × the mean row score, pinned term by term.
    expect(scoreLibraryRows(oneEach(0)).score).toBe(50);
    expect(scoreLibraryRows(oneEach(2)).score).toBe(75);
    expect(scoreLibraryRows(oneEach(3)).score).toBe(88);
  });

  it("weights coverage by facet: an outcome or a metric is worth two of anything else", () => {
    const weightOf = (facet: EvidenceFacet) => scoreLibraryRows([row({ facets: [facet] })]).score;
    // 50 × (weight ÷ 8), with no marks for the rows to add to it.
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
    // All six facets, five rows at 50 and one at 25: 50 + 50 × 275/600 = 72.9 → 73, one band below Strong.
    const almost = oneEach(2).map((item, index) => (index ? item : { ...item, marks: item.marks.slice(0, 1) }));
    expect(scoreLibraryRows(almost)).toMatchObject({ score: 73, rating: "good" });
  });

  it("gives an unverified row no types and no marks, and still counts it in the mean", () => {
    const rows = [
      row({ facets: ["outcome"], marks: [...EVIDENCE_MARKS_BY_FACET.outcome] }),
      row({ row: "b", facets: ["metric"], marks: [...EVIDENCE_MARKS_BY_FACET.metric], verified: false }),
    ];
    const scored = scoreLibraryRows(rows);
    expect(scored.coverage).toMatchObject({ outcome: 1, metric: 0 });
    expect(scored.missing).toContain("metric");
    // 50 × 2/8 + 50 × (100 + 0)/200 = 37.5 → 38, against 75 had both rows been verified.
    expect(scored.score).toBe(38);
    expect(scoreLibraryRows(rows.map(item => ({ ...item, verified: true }))).score).toBe(75);
    // One row can carry two types and covers both: outcome and metric are 50 × 4/8 on their own.
    expect(scoreLibraryRows([row({ facets: ["metric", "outcome"] })])).toMatchObject({ score: 25, rating: "weak" });
    expect(scoreLibraryRows([row({ facets: ["metric", "outcome"] })]).coverage).toMatchObject({ outcome: 1, metric: 1 });
    // A type repeated on one row is one row's worth of it, not two.
    expect(scoreLibraryRows([row({ facets: ["outcome", "outcome"] })]).coverage.outcome).toBe(1);
  });

  it("scores a row the person has not typed against the model's reading of it", () => {
    // Covers outcome in the model's reading (50 × 2/8 = 12.5) and, untagged, is scored against
    // that reading too, so both halves read the row the same way: 12.5 + 50 → 63.
    const untyped = row({ facets: ["outcome"], tagged: [], marks: [...EVIDENCE_MARKS] });
    expect(scoreLibraryRows([untyped]).score).toBe(63);
    // Tagged, the person's choice wins: typed as a milestone it covers outcome (the model's
    // reading drives coverage) and scores the milestone marks it earns, here all of them.
    expect(scoreLibraryRows([{ ...untyped, tagged: ["milestone"] }]).score).toBe(63);
    expect(scoreLibraryRows([{ ...untyped, marks: [...EVIDENCE_MARKS_BY_FACET.outcome], tagged: ["milestone"] }]).score).toBe(13);
    // Untagged and unclassified — a rules review's untagged row — it counts 0: 50 × 0 + 50 × 0.
    expect(scoreLibraryRows([row({ facets: [], tagged: [], marks: [...EVIDENCE_MARKS] })]).score).toBe(0);
    // A verified row the model could not name the types of covers nothing, and scores from its tags.
    expect(scoreLibraryRows([row({ facets: [], tagged: ["metric"], marks: firstMarks(2, ["metric"]) })]).score).toBe(25);
  });
});

describe("libraryRowScore", () => {
  const close: EvidenceMark[] = ["outcome.change", "outcome.cause", "outcome.magnitude", ...EVIDENCE_MARKS_BY_FACET.metric];

  it("scores a row the person has not typed against the review's reading, and has none without one", () => {
    const untyped = libraryRowScore(row({ facets: ["outcome", "metric"], tagged: [], marks: close }));
    expect(untyped).toMatchObject({ score: 88, facets: ["outcome", "metric"], marks: close });
    // A rules review's untagged row: its facets are its tags, so there is nothing to score against.
    expect(libraryRowScore(row({ facets: [], tagged: [], marks: close }))).toEqual({ score: null, facets: [], byFacet: [], marks: close });
  });

  it("reads the row's marks against its tags, a quarter a mark", () => {
    const scored = libraryRowScore(row({ facets: ["metric"], marks: ["metric.figure", "metric.measure", "style.effect"] }));
    expect(scored.score).toBe(50);
    expect(scored.facets).toEqual(["metric"]);
    expect(scored.byFacet).toEqual([{ facet: "metric", score: 50, earned: ["metric.figure", "metric.measure"], missing: ["metric.movement", "metric.driver"] }]);
  });

  it("shows the mean across the row's types", () => {
    expect(libraryRowScore(row({ facets: ["metric", "outcome"], marks: close })).score).toBe(88);
    expect(libraryRowScore(row({ facets: ["metric", "outcome"], marks: close })).facets).toEqual(["outcome", "metric"]);
  });

  it("re-scores against the tags it is given, without another review", () => {
    const reviewed = row({ facets: ["outcome"], tagged: ["outcome"], marks: close });
    expect(libraryRowScore(reviewed).score).toBe(75);
    expect(libraryRowScore(reviewed, ["metric"]).score).toBe(100);
    expect(libraryRowScore(reviewed, ["style"]).score).toBe(0);
    // Every tag removed on screen: back to the review's own reading of the row.
    expect(libraryRowScore(reviewed, []).score).toBe(75);
    expect(libraryRowScore({ ...reviewed, facets: [] }, []).score).toBeNull();
  });

  it("gives a row the review could not tie to the wording no marks, so 0 once typed", () => {
    const unverified = libraryRowScore(row({ facets: ["metric"], marks: close, verified: false }));
    expect(unverified).toMatchObject({ score: 0, marks: [] });
  });

  it("scores a baseline row from the person's own tags and wording", () => {
    const text = "Cut month-end close from 10 to 6 days by rebuilding consolidation in Anaplan";
    const stored = library(text, { [text]: "metric" });
    const review = rulesLibraryReview(stored.entries[0]!, stored);
    expect(libraryRowScore(review.rows[0]!).score).toBe(100);
    expect(libraryRowScore(review.rows[0]!, ["outcome"]).score).toBe(75);
    expect(libraryRowScore(review.rows[0]!, ["outcome", "metric"]).score).toBe(88);
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

  it("takes each row's marks from its own wording, and its types from the person's own tags", () => {
    for (const text of [generic, scoped, named, counted, waffle]) {
      expect(byRow.get(text)!.marks).toEqual(detectEvidenceMarks(text));
    }
    expect(byRow.get(generic)!.marks).toContain("responsibility.ownership");
    expect(byRow.get(named)!.facets).toEqual(["milestone"]);
    expect(byRow.get(named)!.tagged).toEqual(["milestone"]);
    expect(byRow.get(generic)!.facets).toEqual([]);
    expect(byRow.get(generic)!.tagged).toEqual([]);
    expect(byRow.get(counted)).toMatchObject({ facets: ["metric"], tagged: ["metric"], quote: counted, verified: true });
    expect(review.coverage).toMatchObject({ responsibility: 1, milestone: 1, metric: 1, outcome: 0, problem: 0, style: 0 });
  });

  it("counts a row tagged with two types for both of them, and scores it against each", () => {
    const both = "Cut the weekend backlog by 40% after taking over a broken handover";
    const subject = library([both, "Did some things"].join("\n"), { [both]: ["metric", "problem"] });
    const review = rulesLibraryReview(subject.entries[0]!, subject);
    expect(review.rows[0]).toMatchObject({ facets: ["problem", "metric"], tagged: ["problem", "metric"], verified: true });
    expect(review.coverage).toMatchObject({ problem: 1, metric: 1 });
    expect(review.missing).toEqual(["outcome", "responsibility", "milestone", "style"]);
    // Problem 75 (it never says what made it hard) and metric 100: the row reads 88. The untyped
    // row reads nothing. 50 × 3/8 + 50 × 88/200 = 40.75 → 41.
    expect(libraryRowScore(review.rows[0]!).score).toBe(88);
    expect(review.score).toBe(41);
    // An untagged row carries no types and no score, which is what the prompts are there to fix.
    expect(review.rows[1]).toMatchObject({ facets: [], tagged: [], marks: [], verified: true });
    expect(libraryRowScore(review.rows[1]!).score).toBeNull();
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
  // The person tagged the first row a milestone; the model is about to read it as an outcome.
  const subject = library([first, second].join("\n"), { [first]: "milestone" });
  const entry = subject.entries[0]!;
  const earned: EvidenceMark[] = ["outcome.change", "milestone.deliverable", "milestone.role"];
  const said = (over: Partial<LibraryReviewPlanEntry["rows"][number]> = {}): LibraryReviewPlanEntry["rows"][number] => ({
    row: first, facets: ["outcome"] as EvidenceFacet[], marks: earned, quote: "Rebuilt the Acme onboarding flow", ...over,
  });
  const plan = (rows: LibraryReviewPlanEntry["rows"], prompts: string[] = []): LibraryReviewPlanEntry => ({ entryId: entry.id, rows, prompts });

  it("keeps the entry's own rows and drops the ones the model invented", () => {
    const result = validateLibraryReview(entry, plan([said(), said({ row: "A row nobody wrote", quote: null })]));
    expect(result.rows.map(item => item.row)).toEqual([first, second]);
    // `facets` is the model's reading, `tagged` the person's own, and the row is scored on the tags.
    expect(result.rows[0]).toMatchObject({ facets: ["outcome"], tagged: ["milestone"], marks: earned, verified: true });
    expect(libraryRowScore(result.rows[0]!).score).toBe(50);
    // The row the model never mentioned is marked, not dropped: the Library can say it went unread.
    expect(result.rows[1]).toMatchObject({ row: second, facets: [], tagged: [], marks: [], verified: false, quote: null });
  });

  it("matches a row after NFKC and whitespace normalisation, but only once", () => {
    const spaced = plan([said({ row: `  Rebuilt   the Acme onboarding\tflow from scratch with the design group ` }), said({ marks: [] })]);
    const result = validateLibraryReview(entry, spaced);
    // The first classification of a row wins; a second one for the same row is ignored.
    expect(result.rows[0]).toMatchObject({ verified: true, marks: earned });
  });

  it("marks a row unverified when its quote is not anchored in that row", () => {
    const result = validateLibraryReview(entry, plan([said({ quote: "Rebuilt the Globex onboarding flow" })]));
    expect(result.rows[0]).toMatchObject({ verified: false, marks: [], quote: null, facets: [], tagged: ["milestone"] });
    expect(libraryRowScore(result.rows[0]!).score).toBe(0);
    expect(result.score).toBe(0);
    // A classification with no quote at all is verified: the row text itself was matched exactly.
    expect(validateLibraryReview(entry, plan([said({ quote: null })])).rows[0]).toMatchObject({ verified: true, facets: ["outcome"] });
  });

  it("scores from the classifications, never from the model, and keeps its prompts", () => {
    const both = plan([said(), said({ row: second, facets: ["metric"], quote: "by 40%" })], ["What changed as a result?"]);
    const result = validateLibraryReview(entry, both);
    // Outcome and metric covered, 50 × 4/8 = 25; the milestone row reads 50 and the untagged one
    // nothing, 50 × 50/200 = 12.5: 37.5 → 38.
    expect(result).toMatchObject({ entryId: entry.id, score: 38, rating: "weak", prompts: ["What changed as a result?"] });
    expect(result.missing).toEqual(["responsibility", "problem", "milestone", "style"]);
  });

  it("scores an untagged row the model classified against that classification in the entry mean", () => {
    const counted = plan([said(), said({ row: second, facets: ["metric"], marks: ["metric.figure", "metric.movement"], quote: "by 40%" })]);
    const result = validateLibraryReview(entry, counted);
    expect(result.rows[1]).toMatchObject({ facets: ["metric"], tagged: [] });
    expect(libraryRowScore(result.rows[1]!)).toMatchObject({ score: 50, facets: ["metric"] });
    // Outcome and metric covered, 25; the milestone row and the untagged metric row both read 50,
    // 50 × 100/200 = 25: 50, where scoring the untagged row as nothing read 38.
    expect(result).toMatchObject({ score: 50, rating: "good" });
  });

  describe("with rows an earlier review already classified", () => {
    const earlier = validateLibraryReview(entry, plan([said(), said({ row: second, facets: ["metric"], marks: ["metric.figure"], quote: "by 40%" })]));
    const known = knownLibraryRows(earlier);

    it("keeps each known row as it was stored, with the tags saved now, and ignores the plan about it", () => {
      expect([...known.keys()]).toEqual([first, second]);
      // The person has since tagged the second row an outcome; the model is (wrongly) asked again about the first.
      const retagged = library([first, second].join("\n"), { [first]: "milestone", [second]: "outcome" }).entries[0]!;
      const result = validateLibraryReview(retagged, plan([said({ facets: ["style"], marks: ["style.effect"] })]), known);
      expect(result.rows[0]).toMatchObject({ row: first, facets: ["outcome"], marks: earned, tagged: ["milestone"], verified: true });
      expect(result.rows[1]).toMatchObject({ row: second, facets: ["metric"], marks: ["metric.figure"], tagged: ["outcome"], quote: "by 40%", verified: true });
      expect(result).not.toHaveProperty("unread");
    });

    it("classifies only the rows it does not know, and is unread only when those all went unanswered", () => {
      const edited = "Cut onboarding time by 40% in one quarter";
      const changed = library([first, edited].join("\n"), { [first]: "milestone" }).entries[0]!;
      expect(rowsToClassify(changed, known)).toEqual([edited]);
      const answered = validateLibraryReview(changed, plan([said({ row: edited, facets: ["metric"], marks: ["metric.figure", "metric.movement"], quote: null })]), known);
      expect(answered.rows.map(row => [row.row, row.facets, row.verified])).toEqual([[first, ["outcome"], true], [edited, ["metric"], true]]);
      expect(answered).not.toHaveProperty("unread");
      // Asked for the edited row and given nothing about it: unread, whatever the known rows say.
      const silent = validateLibraryReview(changed, plan([]), known);
      expect(silent.unread).toBe(true);
      expect(silent.rows[0]).toMatchObject({ verified: true, facets: ["outcome"] });
      expect(silent.rows[1]).toMatchObject({ verified: false, facets: [] });
      // An answer about the known row alone is no answer about the one it was asked for.
      expect(validateLibraryReview(changed, plan([said()]), known).unread).toBe(true);
      // Every row known: nothing needed classifying, so never unread, and the plan's prompts stand.
      const reordered = library([second, first].join("\n"), { [first]: "milestone" }).entries[0]!;
      expect(rowsToClassify(reordered, known)).toEqual([]);
      expect(validateLibraryReview(reordered, plan([], ["What changed as a result?"]), known)).toMatchObject({ prompts: ["What changed as a result?"] });
      expect(validateLibraryReview(reordered, plan([]), known)).not.toHaveProperty("unread");
    });

    it("says an answer covers an entry only when every row it needed came back", () => {
      const edited = "Cut onboarding time by 40% in one quarter";
      const changed = library([first, edited].join("\n"), { [first]: "milestone" }).entries[0]!;
      expect(libraryPlanCovers(changed, undefined, known)).toBe(false);
      expect(libraryPlanCovers(changed, plan([said()]), known)).toBe(false);
      expect(libraryPlanCovers(changed, plan([said({ row: ` ${edited} ` })]), known)).toBe(true);
      // Without known rows, every row has to come back.
      expect(libraryPlanCovers(changed, plan([said({ row: edited })]))).toBe(false);
      expect(libraryPlanCovers(changed, plan([said(), said({ row: edited })]))).toBe(true);
    });

    it("leaves an unverified row out of what is known, so it is asked about again", () => {
      const partial = validateLibraryReview(entry, plan([said()]));
      expect(partial.rows[1]!.verified).toBe(false);
      expect([...knownLibraryRows(partial).keys()]).toEqual([first]);
    });
  });

  it("keeps only the marks the rubric knows, each once", () => {
    const loose = said({ marks: ["style.effect", "vibes", "milestone.role", "milestone.role"] as never });
    expect(validateLibraryReview(entry, plan([loose])).rows[0]!.marks).toEqual(["milestone.role", "style.effect"]);
  });

  it("refuses demographic prompts and a plan for another entry", () => {
    expect(() => validateLibraryReview(entry, plan([said()], ["What is your date of birth?"]))).toThrow(/Demographic/);
    expect(() => validateLibraryReview(entry, plan([said()], ["Which religion do you practise?"]))).toThrow(/Demographic/);
    expect(() => validateLibraryReview(entry, { ...plan([said()]), entryId: "somewhere-else" })).toThrow(/not given/);
  });

  it("marks an entry the model classified none of the rows of as unread, and no other", () => {
    // Left out of the answer: the engine hands on an empty plan for it.
    expect(validateLibraryReview(entry, plan([]))).toMatchObject({ unread: true, score: 0 });
    // Answered only for rows the entry does not have.
    expect(validateLibraryReview(entry, plan([said({ row: "A row nobody wrote", quote: null })])).unread).toBe(true);
    // One row classified, even with a quote that does not anchor, is an answer about this entry.
    expect(validateLibraryReview(entry, plan([said({ quote: "Rebuilt the Globex onboarding flow" })]))).not.toHaveProperty("unread");
    expect(validateLibraryReview(entry, plan([said()]))).not.toHaveProperty("unread");
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
    // Marks come from the rubric, at most all twenty-four of them.
    expect(LibraryReviewPlanSchema.safeParse({ entries: [plan([said({ marks: [] })])] }).success).toBe(true);
    expect(LibraryReviewPlanSchema.safeParse({ entries: [plan([said({ marks: ["metric.vibes"] as never })])] }).success).toBe(false);
    expect(LibraryReviewPlanSchema.safeParse({ entries: [plan([said({ marks: [...EVIDENCE_MARKS, "metric.figure"] })])] }).success).toBe(false);
    // The first rubric's judgements are not part of the answer any more.
    expect(LibraryReviewPlanSchema.parse({ entries: [plan([{ ...said(), specific: true } as never])] }).entries[0]!.rows[0]).not.toHaveProperty("specific");
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

  it("changes when a row, its order or the job it belongs to changes", () => {
    const changed = [
      libraryEntryInputHash(library([first, "Cut onboarding time by 45%"].join("\n"), { [second]: "metric" }).entries[0]!, job),
      libraryEntryInputHash(library([second, first].join("\n"), { [second]: "metric" }).entries[0]!, job),
      libraryEntryInputHash(entry, { ...job, company: "Globex" }),
      libraryEntryInputHash(entry, { ...job, jobTitle: "Head of Operations" }),
      libraryEntryInputHash(entry, null),
    ];
    expect(new Set([hash, ...changed]).size).toBe(changed.length + 1);
    // Dates are not in it: moving an end date re-renders the heading, it does not change the evidence.
    expect(libraryEntryInputHash(entry, { ...job, current: false, endDate: "2026-01" })).toBe(hash);
  });

  it("does not change when a row is re-tagged: the review is about the wording, not the tags", () => {
    // A different type, a second type, and every tag removed: the page re-scores each against the
    // review's marks itself, so none of them is worth another review of the entry.
    const retags: Array<Record<string, EvidenceFacet | EvidenceFacet[]>> = [{ [second]: "outcome" }, { [second]: ["metric", "outcome"] }, {}, { [first]: "milestone", [second]: "metric" }];
    for (const facets of retags) {
      expect(libraryEntryInputHash(library([first, second].join("\n"), facets).entries[0]!, job)).toBe(hash);
    }
    // Editing a row's wording does change it.
    expect(libraryEntryInputHash(library([first, "Cut onboarding time by 40% in a quarter"].join("\n"), { [second]: "metric" }).entries[0]!, job)).not.toBe(hash);
  });

  it("survives the consolidation the editor runs on every open and save", () => {
    const consolidated = consolidateExperience(subject);
    expect(consolidated.facetedRows).toBe(true);
    expect(libraryEntryInputHash(consolidated.entries[0]!, job)).toBe(hash);
  });

  it("leads with the rubric version, so a review under an earlier rubric no longer matches", () => {
    expect(LIBRARY_RUBRIC_VERSION).toBe(3);
    // Rows in order, the company and the job title, after the version.
    expect(hash).toBe(sha1(JSON.stringify([LIBRARY_RUBRIC_VERSION, [first, second], job.company, job.jobTitle])));
    // What the first rubric's reviews were stored against (no version), and what the second's were
    // (its version, and each row's tags joined): neither matches any more.
    expect(hash).not.toBe(sha1(JSON.stringify([[first, second], ["", "metric"], job.company, job.jobTitle])));
    expect(hash).not.toBe(sha1(JSON.stringify([1, [first, second], ["", "metric"], job.company, job.jobTitle])));
    expect(hash).not.toBe(sha1(JSON.stringify([2, [first, second], ["", "metric"], job.company, job.jobTitle])));
  });

  it("reads an entry as stored, whatever shape its tags were written in", () => {
    // The worker's handler hashes `cv_libraries.content` unparsed, where a release stored a tag as
    // a bare string rather than a one-item list.
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
    expect(review.rows[0]).toMatchObject({ verified: true, quote: "Rebuilt the onboarding flow", tagged: [] });
    // It carries no marks, so the wording rules stand in for them; it names no tags either.
    expect(review.rows[0]!.marks).toEqual(detectEvidenceMarks("Rebuilt the onboarding flow"));
    expect(review.rows[1]!.marks).toEqual([]);
    expect(review.rows[0]).not.toHaveProperty("specific");
    expect(review.prompts).toEqual(["What changed as a result?"]);
    // Recomputed from the rows: outcome covered, 50 × 2/8 = 12.5, and no row typed to score.
    expect(review).toMatchObject({ entryId: "acme-block", score: 13, rating: "none" });
    expect(review.coverage).toMatchObject({ outcome: 1, metric: 0 });
    expect(review.missing).toEqual(["metric", "responsibility", "problem", "milestone", "style"]);
  });

  it("reads today's shape unchanged, and anything outside the vocabulary as nothing", () => {
    const rows = [{
      row: "Cut handover time by 40%", facets: ["metric", "problem", "vibes"], tagged: ["metric", "vibes"],
      marks: ["metric.movement", "vibes", "metric.figure"], quote: "by 40%", verified: true,
    }];
    const review = normaliseLibraryReview(stored(rows));
    expect(review.rows[0]).toMatchObject({ facets: ["problem", "metric"], tagged: ["metric"], marks: ["metric.figure", "metric.movement"] });
    // Stored marks are read as stored, even an empty list: the wording rules only stand in when absent.
    expect(normaliseLibraryReview(stored([{ ...rows[0], marks: [] }])).rows[0]!.marks).toEqual([]);
    expect(normaliseLibraryReview(stored([{ row: "A row nobody classified" }])).rows[0])
      .toEqual({ row: "A row nobody classified", facets: [], tagged: [], marks: detectEvidenceMarks("A row nobody classified"), quote: null, verified: false });
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

describe("retagLibraryReview", () => {
  it("reads a model review against the tags saved now, keeping its marks and its reading", () => {
    const first = "Rebuilt the Acme onboarding flow from scratch with the design group";
    const second = "Cut onboarding time by 40%";
    const before = library([first, second].join("\n"), { [first]: "milestone" });
    const review = validateLibraryReview(before.entries[0]!, {
      entryId: "acme-block",
      rows: [
        { row: first, facets: ["outcome"], marks: ["outcome.change", "milestone.deliverable", "milestone.role"], quote: null },
        { row: second, facets: ["metric"], marks: ["metric.figure", "metric.movement"], quote: null },
      ],
      prompts: [],
    });
    // Re-tagged: the first row is now an outcome, the second a metric the person chose themselves.
    const after = library([first, second].join("\n"), { [first]: "outcome", [second]: "metric" });
    const retagged = retagLibraryReview(review, after.entries[0]!);
    expect(retagged.rows.map(row => row.tagged)).toEqual([["outcome"], ["metric"]]);
    expect(retagged.rows.map(row => [row.facets, row.marks])).toEqual(review.rows.map(row => [row.facets, row.marks]));
    // Coverage 25 either way; the first row reads 25 as an outcome where it read 50 as a milestone:
    // 25 + 50 × 75/200 = 43.75 → 44, where the review as stored read 50.
    expect(review.score).toBe(50);
    expect(retagged).toMatchObject({ score: 44, rating: "weak" });
    // The same entry as far as its review is concerned.
    expect(libraryEntryInputHash(after.entries[0]!, job)).toBe(libraryEntryInputHash(before.entries[0]!, job));
  });
});
