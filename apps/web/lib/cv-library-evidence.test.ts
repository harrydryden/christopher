/**
 * What the Library says about its own evidence: the badge, what is missing in plain words, the
 * questions beneath the rows, and the one line at the top.
 *
 * The two rules worth holding are that no number is invented here — a stored review's score is
 * shown exactly as the scorer computed it — and that an entry nobody has reviewed in its current
 * wording falls back to the baseline and says so, rather than reading as unscored or as reviewed.
 */
import { expect, it } from "vitest";
import { evidenceRatingFor, rulesLibraryReview, type LibraryEntryReview } from "@col/core/library-review";
import { setRowFacets, type CvLibrary, type EvidenceFacet, type Employment } from "@col/core/cv";
import { EVIDENCE_MARK_SPECS } from "@col/core/evidence-rubric";
import {
  EVIDENCE_RATING_LABELS,
  libraryEvidenceLine,
  missingFacetLine,
  rowGuidance,
  rowsMovedOn,
  untaggedFacets,
  type EvidenceEntryView,
  type EvidenceRowView,
} from "./cv-library-evidence";
import { libraryEvidence, type StoredLibraryReview } from "./cv-library-reviews";

const acme: Employment = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };
const globex: Employment = { id: "globex", company: "Globex", jobTitle: "Head of Operations", startDate: "2019-01", endDate: "2022-12", current: false };

function library(rows: Record<string, string[]>, facets: Record<string, Record<string, EvidenceFacet[]>> = {}): CvLibrary {
  const entries = Object.entries(rows).map(([id, lines]) => {
    let entry: CvLibrary["entries"][number] = {
      id, kind: "experience", status: "active", heading: id, employmentId: id, details: lines.join("\n"),
    };
    for (const [row, types] of Object.entries(facets[id] ?? {})) entry = setRowFacets(entry, row, types);
    return entry;
  });
  return {
    name: "Test Candidate", contact: "London", profile: "Operations", structuredExperience: true,
    employment: [acme, globex].filter(job => rows[job.id]), entries,
  };
}

const view = (over: Partial<EvidenceEntryView> = {}): EvidenceEntryView => ({
  entryId: "acme", employmentId: "acme", label: "Operations Director · Acme · Jan 2023 – Present", score: 60, rating: "good",
  source: "model", provisional: false, evaluating: false, missing: [], missingLine: "All six types are covered",
  prompts: [], reviewedRows: [], rows: [], ...over,
});

it("names the two types worth the most and counts the rest, in the words the control uses", () => {
  expect(missingFacetLine([])).toBe("All six types are covered");
  expect(missingFacetLine(["metric"])).toBe("No metrics moved yet");
  expect(missingFacetLine(["outcome", "metric"])).toBe("No outcomes or metrics moved yet");
  expect(missingFacetLine(["outcome", "metric", "milestone"])).toBe("No outcomes or metrics moved yet · 1 other type untagged");
  expect(missingFacetLine(["outcome", "metric", "milestone", "style"])).toBe("No outcomes or metrics moved yet · 2 other types untagged");
});

it("reads the types a job is not tagged with, the heaviest first", () => {
  const value = library({ acme: ["Led a team", "Cut handovers by 40%"] }, { acme: { "Led a team": ["responsibility"], "Cut handovers by 40%": ["metric"] } });
  expect(untaggedFacets(value.entries[0]!)).toEqual(["outcome", "problem", "milestone", "style"]);
});

it("counts a row that carries several types for every one of them", () => {
  // One sentence is often the problem somebody solved and the figure it moved. Neither is missing.
  const value = library({ acme: ["Cut handovers by 40% after the site moved"] },
    { acme: { "Cut handovers by 40% after the site moved": ["problem", "outcome", "metric"] } });
  expect(untaggedFacets(value.entries[0]!)).toEqual(["responsibility", "milestone", "style"]);
  expect(missingFacetLine(untaggedFacets(value.entries[0]!)))
    .toBe("No responsibilities or milestones reached yet · 1 other type untagged");

  const evidence = libraryEvidence(value, new Map());
  const baseline = rulesLibraryReview(value.entries[0]!, value);
  // Three of the six covered by one row, which is what the scorer was given.
  expect(baseline.coverage).toMatchObject({ problem: 1, outcome: 1, metric: 1, responsibility: 0 });
  expect(evidence.entries[0]!.missing).toEqual(["responsibility", "milestone", "style"]);
  expect(evidence.entries[0]!.score).toBe(baseline.score);
});

it("sums the Library up in one line and names the jobs holding it back", () => {
  expect(libraryEvidenceLine([], evidenceRatingFor)).toBeNull();
  expect(libraryEvidenceLine([view({ score: 80, rating: "strong" }), view({ score: 60, rating: "good" })], evidenceRatingFor))
    .toBe("Evidence: Good");
  expect(libraryEvidenceLine(
    [view({ score: 90, rating: "strong" }), view({ score: 40, rating: "weak" }), view({ score: 30, rating: "weak" })],
    evidenceRatingFor,
  )).toBe("Evidence: Good · 2 jobs are Weak");
  expect(libraryEvidenceLine([view({ score: 10, rating: "none" }), view({ score: 30, rating: "weak" })], evidenceRatingFor))
    .toBe("Evidence: None · 1 job has no evidence yet · 1 job is Weak");
});

it("falls back to the baseline for an entry nobody has reviewed in this wording, and says so", () => {
  const value = library({ acme: ["Led a team of nine through a move to one site", "Cut handovers by 40%"] },
    { acme: { "Led a team of nine through a move to one site": ["responsibility"], "Cut handovers by 40%": ["metric"] } });
  const evidence = libraryEvidence(value, new Map(), { pending: true, refusal: null });
  const entry = evidence.entries[0]!;
  const baseline = rulesLibraryReview(value.entries[0]!, value);
  expect(entry).toMatchObject({
    entryId: "acme",
    employmentId: "acme",
    label: "Operations Director · Acme · Jan 2023 – Present",
    score: baseline.score,
    rating: baseline.rating,
    source: "rules",
    provisional: true,
    // A pass is queued, so the score on the screen is not the last word yet.
    evaluating: true,
  });
  expect(entry.missingLine).toBe("No outcomes or problems solved yet · 2 other types untagged");
  // Each prompt is one question, and the baseline's questions say which type they are about.
  expect(entry.prompts.map(prompt => prompt.facet)).toEqual(["outcome", "problem", "milestone"]);
  expect(entry.prompts[0]!.question).toBe("What changed as a result?");
  expect(evidence.evaluating).toBe(true);
  // One job, rated as the baseline rates it; a Good job adds no clause after the rating.
  expect(evidence.line).toBe(baseline.rating === "weak" ? `Evidence: Weak · 1 job is Weak` : `Evidence: ${EVIDENCE_RATING_LABELS[baseline.rating]}`);
});

it("shows a stored model review as it was computed and stops saying Evaluating", () => {
  const value = library({ acme: ["Led a team", "Cut handovers by 40%"] });
  const review: LibraryEntryReview = {
    entryId: "acme",
    rows: [
      { row: "Led a team", facets: ["responsibility"], tagged: ["responsibility"], marks: ["responsibility.ownership"], quote: "Led a team", verified: true },
      { row: "Cut handovers by 40%", facets: ["metric"], tagged: ["metric"], marks: ["metric.figure", "metric.measure", "metric.movement", "outcome.change", "outcome.magnitude"], quote: "Cut handovers by 40%", verified: true },
    ],
    coverage: { responsibility: 1, problem: 0, outcome: 0, metric: 1, milestone: 0, style: 0 },
    missing: ["outcome", "problem", "milestone", "style"],
    prompts: ["What did the move to one site achieve?"],
    score: 44,
    rating: "weak",
  };
  const stored = new Map<string, StoredLibraryReview>([["acme", { entryId: "acme", source: "model", review }]]);
  const evidence = libraryEvidence(value, stored, { pending: true, refusal: null });
  expect(evidence.entries[0]).toMatchObject({ score: 44, rating: "weak", source: "model", provisional: false, evaluating: false });
  // A question the model wrote itself is left without a type rather than guessed at.
  expect(evidence.entries[0]!.prompts).toEqual([{ question: "What did the move to one site achieve?", facet: null }]);
  expect(evidence.evaluating).toBe(false);
  expect(evidence.line).toBe("Evidence: Weak · 1 job is Weak");
});

it("reads a stored model review against the tags saved now, since a re-tag is not re-reviewed", () => {
  // Reviewed when the second row was untagged; the person has since tagged it an outcome. The
  // entry's hash leaves tags out, so this is still its review, rescored against the new tags.
  const value = library({ acme: ["Led a team", "Cut handovers by 40%"] }, { acme: { "Cut handovers by 40%": ["outcome"] } });
  const review: LibraryEntryReview = {
    entryId: "acme",
    rows: [
      { row: "Led a team", facets: ["responsibility"], tagged: [], marks: ["responsibility.ownership"], quote: null, verified: true },
      { row: "Cut handovers by 40%", facets: ["metric"], tagged: [], marks: ["metric.figure", "metric.measure", "metric.movement", "outcome.change"], quote: null, verified: true },
    ],
    coverage: { responsibility: 1, problem: 0, outcome: 0, metric: 1, milestone: 0, style: 0 },
    missing: ["outcome", "problem", "milestone", "style"],
    prompts: [],
    score: 44,
    rating: "weak",
  };
  const stored = new Map<string, StoredLibraryReview>([["acme", { entryId: "acme", source: "model", review }]]);
  const entry = libraryEvidence(value, stored).entries[0]!;
  expect(entry.rows.map(row => [row.tagged, row.reviewFacets])).toEqual([[[], ["responsibility"]], [["outcome"], ["metric"]]]);
  // Coverage is the review's reading (responsibility and metric, 50 × 3/8 = 18.75); the first row
  // untagged reads against it (25), the second against its new tag, one outcome mark (25):
  // 18.75 + 50 × 50/200 = 31.25 → 31, not the 44 stored when it read as a metric.
  expect(entry).toMatchObject({ score: 31, rating: "weak", source: "model", provisional: false });
});

it("carries the worker's own refusal and stops evaluating when the pass is done", () => {
  const value = library({ acme: ["Led a team"] });
  const refusal = "Library evidence review needs about $0.12 of AI budget; your budget of $5 has $0.00 left this month (it resets on the 1st). Raise it on Settings, or ask an administrator.";
  const evidence = libraryEvidence(value, new Map(), { pending: false, refusal });
  expect(evidence.refusal).toBe(refusal);
  expect(evidence.entries[0]!.evaluating).toBe(false);
  expect(evidence.evaluating).toBe(false);
});

it("ignores blocks with nothing in them and a library that has not been written", () => {
  expect(libraryEvidence(null, new Map()).entries).toEqual([]);
  const value = library({ acme: ["Led a team"] });
  value.entries.push(
    { id: "interest", kind: "interest", status: "active", heading: "Running", details: "Marathons" },
    { id: "degree", kind: "education", status: "active", heading: "University of Leeds", details: "MSc Operations Management, 2014" },
    { id: "skills", kind: "skill", status: "active", heading: "Skills", details: "Forecasting\nSQL" },
  );
  const evidence = libraryEvidence(value, new Map());
  // An interests block is not evidence of anything, and the rubric's marks are job-shaped, so an
  // education or skill block is neither scored nor listed: the page lists only jobs.
  expect(evidence.entries.map(entry => entry.entryId)).toEqual(["acme"]);
});

it("scores a block an earlier release stored as a draft, which is what the editor beside it shows", () => {
  // `libraryEvidence` is given `cv_libraries.content` exactly as stored — the reviews are keyed by
  // the hashes of those entries — and every job block the editor wrote before this release was
  // stored as a draft. A draft is active evidence now, so it is scored, counted and asked about.
  const value = library({ acme: ["Led a team", "Cut handovers by 40%"] });
  (value.entries[0] as { status: string }).status = "draft";
  const evidence = libraryEvidence(value, new Map());
  expect(evidence.entries.map(entry => entry.entryId)).toEqual(["acme"]);
  expect(evidence.line).toBe("Evidence: None · 1 job has no evidence yet");
});

it("does not score or count the evidence of a job that was removed", () => {
  // Archived with its job: kept for earlier versions and for the CVs already built from it, and
  // never shown, scored, or counted against the Library again.
  const value = library({ acme: ["Led a team"], globex: ["Ran the estate"] });
  value.entries[1]!.status = "inactive";
  const evidence = libraryEvidence(value, new Map());
  expect(evidence.entries.map(entry => entry.entryId)).toEqual(["acme"]);
  expect(evidence.line).toBe("Evidence: None · 1 job has no evidence yet");
});

it("knows when the rows on screen are no longer the rows that were scored", () => {
  const value = library({ acme: ["Led a team", "Cut handovers"] });
  expect(rowsMovedOn(value.entries[0]!, ["Led a team", "Cut handovers"])).toBe(false);
  expect(rowsMovedOn(value.entries[0]!, ["Led a team"])).toBe(true);
  expect(rowsMovedOn(value.entries[0]!, ["Led a team of nine", "Cut handovers"])).toBe(true);
});

it("carries each reviewed row's inputs, not a number, so the browser scores it against the tags on screen", () => {
  const value = library({ acme: ["Led a team", "Cut handover time from 3 days to 4 hours across the UK network"] },
    { acme: { "Cut handover time from 3 days to 4 hours across the UK network": ["outcome"] } });
  const rows = libraryEvidence(value, new Map()).entries[0]!.rows;
  expect(rows.map(row => [row.row, row.tagged, row.reviewFacets, row.verified])).toEqual([
    ["Led a team", [], [], true],
    ["Cut handover time from 3 days to 4 hours across the UK network", ["outcome"], ["outcome"], true],
  ]);
});

const FULL_REVIEW = "From the full review.";
const OWN_WORDING = "From your own wording; Re-score for the full review.";
const view1 = (over: Partial<EvidenceRowView> = {}): EvidenceRowView => ({
  row: "Responsible for operations", tagged: ["responsibility"], marks: [], reviewFacets: ["responsibility"], verified: true, ...over,
});

it("asks for a type before it scores a row, and says what the full review read it as", () => {
  const rules = rowGuidance({ text: "Responsible for operations", facets: [], view: undefined, source: "rules", evaluating: false });
  expect(rules).toEqual({
    score: null,
    heading: "Select type",
    missing: [],
    footer: "Choose one or more types in the Type column; the row is scored against what each type needs.",
    suggested: [],
  });
  // The model classified the row, but the person has not tagged it: still no score, and the
  // model's reading is offered as a hint, never applied.
  const model = rowGuidance({
    text: "Responsible for operations", facets: [], view: view1({ tagged: [], reviewFacets: ["responsibility", "metric"] }), source: "model", evaluating: false,
  });
  expect(model.score).toBeNull();
  expect(model.heading).toBe("Select type");
  expect(model.footer).toBe("Choose one or more types in the Type column; the row is scored against what each type needs. The full review reads this row as Responsibilities and Metrics moved.");
  expect(model.suggested).toEqual(["responsibility", "metric"]);
});

it("offers the review's types only for an untyped row the review read as something", () => {
  const read = view1({ tagged: [], reviewFacets: ["outcome"] });
  expect(rowGuidance({ text: "Responsible for operations", facets: [], view: read, source: "model", evaluating: false }).suggested).toEqual(["outcome"]);
  // Once the person has a type on the row, nothing is suggested, whatever the review read.
  expect(rowGuidance({ text: "Responsible for operations", facets: ["metric"], view: read, source: "model", evaluating: false }).suggested).toEqual([]);
  // The review read it as nothing, or there is no review of this row.
  expect(rowGuidance({ text: "Responsible for operations", facets: [], view: view1({ tagged: [], reviewFacets: [] }), source: "model", evaluating: false }).suggested).toEqual([]);
  expect(rowGuidance({ text: "Responsible for operations", facets: [], view: undefined, source: "model", evaluating: false }).suggested).toEqual([]);
  // A copy, so adopting it cannot mutate the view.
  const suggested = rowGuidance({ text: "Responsible for operations", facets: [], view: read, source: "model", evaluating: false }).suggested;
  expect(suggested).not.toBe(read.reviewFacets);
});

it("scores a typed row from its own wording and lists only what is missing, as lines to act on", () => {
  const guidance = rowGuidance({ text: "Responsible for operations", facets: ["responsibility"], view: undefined, source: "rules", evaluating: false });
  expect(guidance.score).toBe(25);
  expect(guidance.heading).toBe("25/100 · Scored as Responsibilities");
  expect(guidance.missing).toEqual([{
    facet: "responsibility",
    label: "Responsibilities",
    asks: [
      EVIDENCE_MARK_SPECS["responsibility.scope"].ask,
      EVIDENCE_MARK_SPECS["responsibility.audience"].ask,
      EVIDENCE_MARK_SPECS["responsibility.scale"].ask,
    ],
  }]);
  // What the row already has is not listed.
  expect(JSON.stringify(guidance)).not.toContain(EVIDENCE_MARK_SPECS["responsibility.ownership"].ask);
  expect(guidance.footer).toBe(OWN_WORDING);
  expect(rowGuidance({ text: "Responsible for operations", facets: ["responsibility"], view: undefined, source: "rules", evaluating: true }).footer)
    .toBe("From your own wording while the full review runs.");
});

it("uses the full review's marks while the row on screen is the row it read", () => {
  const view = view1({ marks: ["responsibility.scope", "responsibility.audience", "responsibility.ownership"] });
  const guidance = rowGuidance({ text: "Responsible for operations", facets: ["responsibility"], view, source: "model", evaluating: false });
  expect(guidance.score).toBe(75);
  expect(guidance.missing).toEqual([{ facet: "responsibility", label: "Responsibilities", asks: [EVIDENCE_MARK_SPECS["responsibility.scale"].ask] }]);
  expect(guidance.footer).toBe(FULL_REVIEW);
  // Re-tagged on screen: the same marks, scored against the new type, without a new review.
  const retagged = rowGuidance({ text: "Responsible for operations", facets: ["metric"], view, source: "model", evaluating: false });
  expect(retagged.score).toBe(0);
  expect(retagged.heading).toBe("0/100 · Scored as Metrics moved");
});

it("reads the wording live once the row has moved on from what was reviewed", () => {
  const view = view1({ marks: ["responsibility.scope", "responsibility.audience", "responsibility.ownership", "responsibility.scale"] });
  const moved = rowGuidance({ text: "Responsible for ops", facets: ["responsibility"], view, source: "model", evaluating: false });
  // The review's four marks no longer describe this wording; the baseline's one does.
  expect(moved.score).toBe(25);
  expect(moved.footer).toBe(OWN_WORDING);
});

it("groups what is missing by type when a row carries several, and averages the scores", () => {
  const text = "Cut month-end close from 10 to 6 days by rebuilding consolidation in Anaplan";
  const guidance = rowGuidance({ text, facets: ["metric", "outcome"], view: undefined, source: "rules", evaluating: false });
  // Outcomes 75 (no beneficiary), Metrics moved 100: the mean.
  expect(guidance.score).toBe(88);
  expect(guidance.heading).toBe("88/100 · Scored as Outcomes and Metrics moved");
  expect(guidance.missing).toEqual([{ facet: "outcome", label: "Outcomes", asks: [EVIDENCE_MARK_SPECS["outcome.beneficiary"].ask] }]);

  const thin = rowGuidance({ text: "Responsible for operations", facets: ["responsibility", "metric"], view: undefined, source: "rules", evaluating: false });
  expect(thin.missing.map(group => [group.label, group.asks.length])).toEqual([["Responsibilities", 3], ["Metrics moved", 3]]);
});

it("says nothing is missing when a row earns every mark its types need", () => {
  const text = "Cut month-end close from 10 to 6 days by rebuilding consolidation in Anaplan";
  const guidance = rowGuidance({ text, facets: ["metric"], view: undefined, source: "rules", evaluating: false });
  expect(guidance).toEqual({
    score: 100,
    heading: "100/100 · Scored as Metrics moved",
    missing: [],
    footer: `Nothing missing for Metrics moved. ${OWN_WORDING}`,
    suggested: [],
  });
});
