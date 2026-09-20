/**
 * The Library editor's row motions, and the one rule that is easy to get wrong: a facet tag is
 * keyed by a row's exact text, so rewording a row has to carry its tag with it and removing a row
 * has to take the tag away.
 */
import { expect, it } from "vitest";
import { rowFacet, type CvLibrary, type Employment } from "@christopher/core/cv";
import { addJobRow, jobEntry, jobRows, removeJobRow, setJobRows, tagRow } from "./cv-library-rows";

const job: Employment = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };

const library = (details: string): CvLibrary => ({
  name: "Test Candidate",
  contact: "London",
  profile: "Operations",
  structuredExperience: true,
  employment: [job],
  entries: [{ id: "block", kind: "experience", status: "active", heading: "Operations Director · Acme · Jan 2023 – Present", employmentId: "acme", details, confirmedResponsibilities: ["Led a team"] }],
});

it("carries a row's facet across a rewording and drops it with the row", () => {
  const tagged = tagRow(library("Led a team\nCut handovers"), "block", "Led a team", "responsibility");
  expect(rowFacet(jobEntry(tagged, "acme")!, "Led a team")).toBe("responsibility");

  const reworded = setJobRows(tagged, job, ["Led a team of nine", "Cut handovers"]);
  const entry = jobEntry(reworded, "acme")!;
  // The tag follows the text: fixing a typo in an outcome leaves it an outcome.
  expect(rowFacet(entry, "Led a team of nine")).toBe("responsibility");
  expect(rowFacet(entry, "Led a team")).toBeNull();
  // The confirmation does not follow it: that was an assertion about the exact wording.
  expect(entry.confirmedResponsibilities).toEqual([]);

  // Removing the row takes its tag with it rather than handing it to the row that moves up.
  const removed = removeJobRow(reworded, job, 0);
  expect(jobEntry(removed, "acme")!.rowFacets).toBeUndefined();
});

it("keeps the other rows' tags when one row is edited", () => {
  let value = library("Led a team\nCut handovers by 40%");
  value = tagRow(value, "block", "Led a team", "responsibility");
  value = tagRow(value, "block", "Cut handovers by 40%", "metric");
  const entry = jobEntry(setJobRows(value, job, ["Led a team of nine", "Cut handovers by 40%"]), "acme")!;
  expect(entry.rowFacets).toEqual({ "Led a team of nine": "responsibility", "Cut handovers by 40%": "metric" });
});

it("writes a job's first evidence block the first time a row is added to it", () => {
  const bare: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true, employment: [job], entries: [] };
  expect(jobRows(bare, "acme")).toEqual([]);
  const added = addJobRow(bare, job);
  expect(added.index).toBe(0);
  const entry = jobEntry(added.library, "acme")!;
  expect(entry).toMatchObject({ kind: "experience", status: "draft", employmentId: "acme", heading: "Operations Director · Acme · Jan 2023 – Present" });
  // A second row lands under the first, which is where the caret goes.
  expect(addJobRow(added.library, job).index).toBe(1);
});

it("clears a tag without leaving an empty map behind", () => {
  const tagged = tagRow(library("Led a team"), "block", "Led a team", "outcome");
  expect(tagRow(tagged, "block", "Led a team", null).entries[0]!.rowFacets).toBeUndefined();
});
