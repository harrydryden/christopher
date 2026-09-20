/**
 * What the Library says about its own evidence: the badge, what is missing in plain words, the
 * questions beneath the rows, and the one line at the top.
 *
 * The two rules worth holding are that no number is invented here — a stored review's score is
 * shown exactly as the scorer computed it — and that an entry nobody has reviewed in its current
 * wording falls back to the baseline and says so, rather than reading as unscored or as reviewed.
 */
import { expect, it } from "vitest";
import { evidenceRatingFor, rulesLibraryReview, type LibraryEntryReview } from "@christopher/core/library-review";
import { setRowFacets, type CvLibrary, type EvidenceFacet, type Employment } from "@christopher/core/cv";
import {
  EVIDENCE_RATING_LABELS,
  libraryEvidenceLine,
  missingFacetLine,
  rowsMovedOn,
  untaggedFacets,
  type EvidenceEntryView,
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
  prompts: [], reviewedRows: [], ...over,
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
  expect(evidence.line).toBe(`Evidence: ${EVIDENCE_RATING_LABELS[baseline.rating]} · 1 job is Weak`);
});

it("shows a stored model review as it was computed and stops saying Evaluating", () => {
  const value = library({ acme: ["Led a team", "Cut handovers by 40%"] });
  const review: LibraryEntryReview = {
    entryId: "acme",
    rows: [
      { row: "Led a team", facets: ["responsibility"], specific: false, quantified: false, outcomeLinked: false, quote: "Led a team", verified: true },
      { row: "Cut handovers by 40%", facets: ["metric"], specific: true, quantified: true, outcomeLinked: true, quote: "Cut handovers by 40%", verified: true },
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
  value.entries.push({ id: "interest", kind: "interest", status: "active", heading: "Running", details: "Marathons" });
  const evidence = libraryEvidence(value, new Map());
  // An interests block is not evidence of anything, and only jobs are counted in the line.
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
