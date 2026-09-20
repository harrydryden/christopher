/**
 * Comparing two saved Library versions.
 *
 * Rows are the unit, and the pairing rule is the one thing worth pinning: a row whose text matches
 * is the same row, and whatever is left over on each side is paired by position, so rewording a
 * bullet reads as one change rather than a removal and an addition that happen to be adjacent.
 */
import { expect, it } from "vitest";
import type { CvLibrary, Employment } from "@christopher/core/cv";
import { diffCvLibraries, diffRows, libraryDiffSummary, requestedDiff } from "./cv-library-diff";

const acme: Employment = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };
const globex: Employment = { id: "globex", company: "Globex", jobTitle: "Head of Operations", startDate: "2019-01", endDate: "2022-12", current: false };

function library(over: Partial<CvLibrary> = {}): CvLibrary {
  return {
    name: "Test Candidate",
    contact: "London",
    profile: "Operations",
    structuredExperience: true,
    employment: [acme],
    entries: [{ id: "acme-block", kind: "experience", status: "active", heading: "Acme", employmentId: "acme", details: "Led a team\nCut handovers" }],
    ...over,
  };
}

it("pairs rows by text first and by position second", () => {
  expect(diffRows(["a", "b"], ["a", "b"])).toEqual({ added: [], removed: [], changed: [] });
  expect(diffRows(["a", "b"], ["a", "b changed"]))
    .toEqual({ added: [], removed: [], changed: [{ before: "b", after: "b changed" }] });
  expect(diffRows(["a"], ["a", "b"])).toEqual({ added: ["b"], removed: [], changed: [] });
  expect(diffRows(["a", "b"], ["a"])).toEqual({ added: [], removed: ["b"], changed: [] });
  // Reordering is not a change: both rows are still there.
  expect(diffRows(["a", "b"], ["b", "a"])).toEqual({ added: [], removed: [], changed: [] });
});

it("reports what changed in a job, named as the newer version names it", () => {
  const before = library();
  const after = library({
    entries: [{ id: "acme-block", kind: "experience", status: "active", heading: "Acme", employmentId: "acme", details: "Led a team of nine\nCut handovers\nShipped the new rota in March" }],
  });
  const diff = diffCvLibraries(before, after, 7, 9);
  expect(diff.from).toBe(7);
  expect(diff.to).toBe(9);
  expect(diff.unchanged).toBe(false);
  expect(diff.blocks).toEqual([{
    entryId: "acme-block",
    label: "Operations Director · Acme · Jan 2023 – Present",
    added: ["Shipped the new rota in March"],
    removed: [],
    changed: [{ before: "Led a team", after: "Led a team of nine" }],
  }]);
  expect(libraryDiffSummary(diff)).toBe("1 row added, 1 row reworded");
});

it("names jobs and blocks that arrived or went", () => {
  const before = library();
  const after = library({
    employment: [acme, globex],
    entries: [
      library().entries[0]!,
      { id: "globex-block", kind: "experience", status: "draft", heading: "Globex", employmentId: "globex", details: "Ran the regional team" },
      { id: "degree", kind: "education", status: "active", heading: "BSc Mathematics", details: "University of Leeds" },
    ],
  });
  const forward = diffCvLibraries(before, after, 1, 2);
  expect(forward.employmentAdded).toEqual(["Head of Operations · Globex · Jan 2019 – Dec 2022"]);
  expect(forward.blocksAdded).toEqual(["Head of Operations · Globex · Jan 2019 – Dec 2022", "BSc Mathematics"]);
  expect(forward.employmentRemoved).toEqual([]);
  expect(libraryDiffSummary(forward)).toBe("2 blocks added, 1 job added");

  // The same two versions the other way round: what arrived is what went.
  const back = diffCvLibraries(after, before, 2, 1);
  expect(back.employmentRemoved).toEqual(["Head of Operations · Globex · Jan 2019 – Dec 2022"]);
  expect(back.blocksRemoved).toEqual(["Head of Operations · Globex · Jan 2019 – Dec 2022", "BSc Mathematics"]);
});

it("says plainly when two versions are the same", () => {
  const diff = diffCvLibraries(library(), library(), 3, 4);
  expect(diff.unchanged).toBe(true);
  expect(libraryDiffSummary(diff)).toBe("No changes between these versions");
});

it("reads a comparison out of the URL, in order, and refuses anything else", () => {
  const available = [1, 2, 7, 9];
  expect(requestedDiff({ diff: "7,9" }, available)).toEqual({ from: 7, to: 9 });
  expect(requestedDiff({ diff: "9,7" }, available)).toEqual({ from: 7, to: 9 });
  expect(requestedDiff({ a: "1", b: "2" }, available)).toEqual({ from: 1, to: 2 });
  expect(requestedDiff({ diff: "7,7" }, available)).toBeNull();
  // A version this account has not saved is not a comparison it can be shown.
  expect(requestedDiff({ diff: "7,8" }, available)).toBeNull();
  expect(requestedDiff({ diff: "seven,nine" }, available)).toBeNull();
  expect(requestedDiff({}, available)).toBeNull();
});
