/**
 * The Library editor's row motions, and the one rule that is easy to get wrong: a row's types are
 * keyed by its exact text, so rewording a row has to carry them with it and removing a row has to
 * take them away.
 *
 * A row carries as many of the six types as it serves, so every one of those rules is about a
 * list rather than a single tag: the problem somebody solved and the figure it moved are often one
 * sentence, and it has to stay both across an edit.
 */
import { expect, it } from "vitest";
import { contactLine, rowFacets, type CvLibrary, type Employment } from "@ava/core/cv";
import {
  addJobRow,
  archivedBlocks,
  editableEmployment,
  jobEntry,
  jobRows,
  pendingRowKey,
  removeJob,
  removeJobRow,
  restoreBlock,
  restoreJob,
  setJobRows,
  tagRow,
  withArchivedEmployment,
} from "./cv-library-rows";
import { openStoredLibrary } from "./cv-library-open";

const job: Employment = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };
const globex: Employment = { id: "globex", company: "Globex", jobTitle: "Head of Operations", startDate: "2019-01", endDate: "2022-12", current: false };

const library = (details: string): CvLibrary => ({
  name: "Test Candidate",
  contact: "London",
  profile: "Operations",
  structuredExperience: true,
  employment: [job],
  entries: [{ id: "block", kind: "experience", status: "active", heading: "Operations Director · Acme · Jan 2023 – Present", employmentId: "acme", details, confirmedResponsibilities: ["Led a team"] }],
});

it("carries a row's types across a rewording and drops them with the row", () => {
  const tagged = tagRow(library("Led a team\nCut handovers"), "block", "Led a team", ["responsibility", "outcome"]);
  expect(rowFacets(jobEntry(tagged, "acme")!, "Led a team")).toEqual(["responsibility", "outcome"]);

  const reworded = setJobRows(tagged, job, ["Led a team of nine", "Cut handovers"]);
  const entry = jobEntry(reworded, "acme")!;
  // Every type follows the text: fixing a typo in an outcome leaves it an outcome.
  expect(rowFacets(entry, "Led a team of nine")).toEqual(["responsibility", "outcome"]);
  expect(rowFacets(entry, "Led a team")).toEqual([]);
  // The confirmation does not follow it: that was an assertion about the exact wording.
  expect(entry.confirmedResponsibilities).toEqual([]);

  // Removing the row takes its types with it rather than handing them to the row that moves up.
  const removed = removeJobRow(reworded, job, 0);
  expect(jobEntry(removed, "acme")!.rowFacets).toBeUndefined();
  expect(jobRows(removed, "acme")).toEqual(["Cut handovers"]);
});

it("keeps the other rows' types when one row is edited, in the canonical order", () => {
  let value = library("Led a team\nCut handovers by 40%");
  value = tagRow(value, "block", "Led a team", ["responsibility"]);
  // Ticked in the order the panel was clicked through; stored in the order the six are listed in.
  value = tagRow(value, "block", "Cut handovers by 40%", ["metric", "problem"]);
  const entry = jobEntry(setJobRows(value, job, ["Led a team of nine", "Cut handovers by 40%"]), "acme")!;
  expect(entry.rowFacets).toEqual({
    "Led a team of nine": ["responsibility"],
    "Cut handovers by 40%": ["problem", "metric"],
  });
});

it("writes a job's first evidence block the first time a row is added to it", () => {
  const bare: CvLibrary = { name: "Test", contact: "", profile: "", structuredExperience: true, employment: [job], entries: [] };
  expect(jobRows(bare, "acme")).toEqual([]);
  const added = addJobRow(bare, job);
  expect(added.index).toBe(0);
  const entry = jobEntry(added.library, "acme")!;
  // A job in employment history is evidence of itself: the block is written active, never a draft.
  expect(entry).toMatchObject({ kind: "experience", status: "active", employmentId: "acme", heading: "Operations Director · Acme · Jan 2023 – Present" });
  // A second row lands under the first, which is where the caret goes.
  expect(addJobRow(added.library, job).index).toBe(1);
  // An empty row has no text to key its types to, so the editor holds them against its position.
  expect(pendingRowKey(job.id, added.index)).toBe("acme#0");
});

it("clears a row's types without leaving an empty map behind", () => {
  const tagged = tagRow(library("Led a team"), "block", "Led a team", ["outcome"]);
  expect(tagRow(tagged, "block", "Led a team", []).entries[0]!.rowFacets).toBeUndefined();
});

it("leaves an empty row behind rather than taking the block with the last one", () => {
  // Removing the block is how a job's evidence is archived, and that belongs to removing the job.
  const emptied = removeJobRow(library("Led a team"), job, 0);
  expect(jobEntry(emptied, "acme")).toBeDefined();
  expect(jobRows(emptied, "acme")).toEqual([""]);
  expect(jobEntry(emptied, "acme")!.confirmedResponsibilities).toEqual([]);
});

it("takes a removed job's evidence out of the editor and never shows an archived one again", () => {
  const two: CvLibrary = {
    ...library("Led a team"),
    employment: [job, globex],
    entries: [
      ...library("Led a team").entries,
      { id: "globex-block", kind: "experience", status: "active", heading: "Head of Operations · Globex", employmentId: "globex", details: "Ran the estate", confirmedResponsibilities: [] },
    ],
  };
  const removed = removeJob(two, "globex");
  // Archived where it stands, with the record it points at: what the editor holds is what it
  // posts, so a library whose only job was just removed still has the block the schema asks for.
  expect(removed.employment).toEqual([job, globex]);
  expect(removed.entries.map(entry => [entry.id, entry.status])).toEqual([["block", "active"], ["globex-block", "inactive"]]);

  const stored: CvLibrary = removed;
  expect(editableEmployment(stored)).toEqual([job]);
  // An edit to the jobs on the screen never drops the one that is not on it.
  expect(withArchivedEmployment(stored, [{ ...job, jobTitle: "Director" }]).map(item => item.id)).toEqual(["acme", "globex"]);
});

it("puts a removed job back exactly as it was, and offers it until it is back", () => {
  const tagged = tagRow(library("Led a team\nCut handovers by 40%"), "block", "Cut handovers by 40%", ["problem", "metric"]);
  const removed = removeJob(tagged, "acme");
  expect(editableEmployment(removed)).toEqual([]);
  // A job whose only block is archived is a removed job, and the way back from it is this list:
  // the heading employment history gives it, and how many rows would come back with it.
  expect(archivedBlocks(removed)).toEqual([{
    entryId: "block",
    employmentId: "acme",
    heading: "Operations Director · Acme · Jan 2023 – Present",
    rows: 2,
  }]);

  const restored = restoreJob(removed, "acme");
  // The inverse of the removal, to the letter: nothing else about the library moved either way.
  expect(restored).toEqual(tagged);
  expect(editableEmployment(restored)).toEqual([job]);
  expect(jobRows(restored, "acme")).toEqual(["Led a team", "Cut handovers by 40%"]);
  // The tags and the confirmation the rows carried are the ones that come back with them.
  expect(rowFacets(jobEntry(restored, "acme")!, "Cut handovers by 40%")).toEqual(["problem", "metric"]);
  expect(jobEntry(restored, "acme")!.confirmedResponsibilities).toEqual(["Led a team"]);
  // Nothing is archived any more, and the disclosure that lists it is not rendered at all.
  expect(archivedBlocks(restored)).toEqual([]);
});

it("lists a block an earlier release archived, so nothing stored is out of reach", () => {
  // "Archive block" is gone, but the blocks it archived are still stored, and the education panel
  // does not show them. They are listed beside the removed jobs and restored the same way.
  const withSkill: CvLibrary = { ...library("Led a team"), entries: [
    ...library("Led a team").entries,
    { id: "tools", kind: "skill", status: "inactive", heading: "Tools", details: "SQL and Power BI" },
  ] };
  expect(archivedBlocks(withSkill)).toEqual([{ entryId: "tools", heading: "Tools", rows: null }]);
  expect(restoreBlock(withSkill, "tools").entries.map(entry => entry.status)).toEqual(["active", "active"]);
  expect(archivedBlocks(restoreBlock(withSkill, "tools"))).toEqual([]);
});

it("does not offer a second block for a job that already has one", () => {
  // The schema allows one block per job, so putting this one back would refuse the next save
  // rather than restore anything. It is kept, and it is not offered.
  const doubled: CvLibrary = { ...library("Led a team"), entries: [
    ...library("Led a team").entries,
    { id: "older", kind: "experience", status: "inactive", heading: "Operations Director · Acme", employmentId: "acme", details: "Ran the estate", confirmedResponsibilities: [] },
  ] };
  expect(archivedBlocks(doubled)).toEqual([]);
});

it("removes a job nobody wrote a row for outright, with the empty block the editor made", () => {
  // Nothing to archive and no record to keep it against: an "Add job" the person thought better
  // of leaves nothing behind, and the empty block cannot be stored anyway.
  const bare: CvLibrary = { ...library("Led a team"), employment: [job, globex], entries: [
    ...library("Led a team").entries,
    { id: "globex-block", kind: "experience", status: "active", heading: "Head of Operations · Globex", employmentId: "globex", details: "", confirmedResponsibilities: [] },
  ] };
  const removed = removeJob(bare, "globex");
  expect(removed.employment).toEqual([job]);
  expect(removed.entries.map(entry => entry.id)).toEqual(["block"]);
  expect(removeJob(bare, "acme").entries.map(entry => entry.status)).toEqual(["inactive", "active"]);
});

it("keeps a library saveable when its only job is removed", () => {
  // The schema asks for at least one block. Removing the last job archives its own, so the save
  // that stores the archive is a save the person can actually make.
  const removed = removeJob(library("Led a team"), "acme");
  expect(removed.entries).toHaveLength(1);
  expect(removed.entries[0]!.status).toBe("inactive");
  expect(editableEmployment(removed)).toEqual([]);
});

it("opens a library stored by an earlier release in today's shape", () => {
  const stored = {
    name: "Test Candidate",
    contact: "London",
    profile: "Operations",
    structuredExperience: true,
    employment: [job],
    entries: [{
      id: "block", kind: "experience", status: "draft", heading: "Operations Director · Acme", employmentId: "acme",
      details: "Led a team\nCut handovers by 40%", confirmedResponsibilities: ["Led a team"],
      // One type per row, as a bare string: what every library stored before this release carries.
      rowFacets: { "Led a team": "responsibility", "Cut handovers by 40%": "metric" },
    }],
  };
  const opened = openStoredLibrary(stored);
  const entry = jobEntry(opened, "acme")!;
  expect(entry.rowFacets).toEqual({ "Led a team": ["responsibility"], "Cut handovers by 40%": ["metric"] });
  // A block stored as a draft is evidence of a job the person still lists, and is shown.
  expect(entry.status).toBe("active");
  expect(editableEmployment(opened)).toEqual([job]);
  // A second type lands on top of the one that was stored, without disturbing the other row.
  const tagged = tagRow(opened, "block", "Cut handovers by 40%", ["problem", "metric"]);
  expect(rowFacets(jobEntry(tagged, "acme")!, "Cut handovers by 40%")).toEqual(["problem", "metric"]);
  expect(rowFacets(jobEntry(tagged, "acme")!, "Led a team")).toEqual(["responsibility"]);
});

it("opens a library the schema would refuse rather than failing in front of the person", () => {
  // The Library is the page that exists to fix a library like this one; a name it cannot parse
  // must not be the reason it cannot be opened.
  const opened = openStoredLibrary({ ...library("Led a team"), name: "" });
  expect(opened.name).toBe("");
  expect(jobRows(opened, "acme")).toEqual(["Led a team"]);
});

it("opens a library whose contact details were one line with each detail in its own field, losing nothing", () => {
  // The shape every library had before email, phone and location were fields: one free-text line.
  const stored = { ...library("Led a team"), contact: "Manchester, UK · rowan.mercer@example.test · +44 7700 900123" };
  const opened = openStoredLibrary(stored);
  expect(opened).toMatchObject({ email: "rowan.mercer@example.test", phone: "+44 7700 900123", contact: "Manchester, UK" });
  // A place cannot be told from any other phrase, so it stays in the other line for the person to move.
  expect(opened.location).toBeUndefined();
  expect(contactLine(opened).split(" · ").sort()).toEqual(stored.contact.split(" · ").sort());
  // Opening what was opened changes nothing, so the editor's baseline and its value agree.
  expect(openStoredLibrary(opened)).toEqual(opened);
  // A line with nothing to move is left exactly as it was stored.
  expect(openStoredLibrary(library("Led a team")).contact).toBe("London");
  // So is a library the schema refuses, which still opens with its details upgraded.
  expect(openStoredLibrary({ ...stored, name: "" })).toMatchObject({ email: "rowan.mercer@example.test", contact: "Manchester, UK" });
});
