/**
 * "Reload and keep my text": what survives a save that was refused because the stored version had
 * moved on, and what is honestly reported as lost.
 */
import { expect, it } from "vitest";
import type { CvLibrary } from "@ava/core/cv";
import { mergeCvLibrary } from "./cv-library-merge";

const base: CvLibrary = {
  name: "Rowan Mercer",
  contact: "Manchester",
  profile: "Operations leader.",
  structuredExperience: true,
  employment: [
    { id: "job-1", company: "Northwind", jobTitle: "Head of Operations", startDate: "2020", endDate: "", current: true },
    { id: "job-2", company: "Calder", jobTitle: "Service Manager", startDate: "2016", endDate: "2019", current: false },
  ],
  entries: [
    { id: "ev-1", kind: "experience", status: "active", employmentId: "job-1", heading: "Head of Operations", details: "Led four managers.", confirmedResponsibilities: ["Led four managers."] },
    { id: "ev-2", kind: "experience", status: "active", employmentId: "job-2", heading: "Service Manager", details: "Ran a service desk of nine.", confirmedResponsibilities: ["Ran a service desk of nine."] },
  ],
};

const edit = (library: CvLibrary, id: string, details: string): CvLibrary => ({
  ...library,
  entries: library.entries.map(entry => (entry.id === id ? { ...entry, details, confirmedResponsibilities: [details] } : entry)),
});

it("keeps every edit the stored version did not touch, and says so", () => {
  const mine = { ...edit(base, "ev-1", "Led four managers and a scheduling team of eighteen."), profile: "Operations leader in regulated healthcare." };
  const latest = edit(base, "ev-2", "Ran a service desk of nine across two distribution centres.");

  const merged = mergeCvLibrary(base, mine, latest, 7);
  expect(merged.library.entries.find(entry => entry.id === "ev-1")!.details).toBe(
    "Led four managers and a scheduling team of eighteen.",
  );
  // The other save's block is untouched by the merge.
  expect(merged.library.entries.find(entry => entry.id === "ev-2")!.details).toBe(
    "Ran a service desk of nine across two distribution centres.",
  );
  expect(merged.library.profile).toBe("Operations leader in regulated healthcare.");
  expect(merged.kept).toEqual(["Bio", "Northwind · Head of Operations"]);
  expect(merged.dropped).toEqual([]);
  expect(merged.note).toContain("Reloaded version 7");
  expect(merged.note).toContain("Check it, then save again.");
});

it("keeps the stored wording when both changed the same block, and names it", () => {
  const mine = edit(base, "ev-1", "Led four managers and eighteen schedulers.");
  const latest = edit(base, "ev-1", "Led four operations managers.");

  const merged = mergeCvLibrary(base, mine, latest, 9);
  expect(merged.library.entries.find(entry => entry.id === "ev-1")!.details).toBe("Led four operations managers.");
  expect(merged.kept).toEqual([]);
  expect(merged.dropped).toEqual(["Northwind · Head of Operations"]);
  expect(merged.note).toContain("Northwind · Head of Operations was changed in the saved version");
  expect(merged.note).toContain("your version is in the download");
});

it("carries additions across and never re-applies a deletion", () => {
  const mine: CvLibrary = {
    ...base,
    entries: [
      ...base.entries,
      { id: "ev-3", kind: "skill", status: "active", heading: "Tools", details: "SQL and Power BI." },
    ],
  };
  // The other save removed one block and added one of its own.
  const latest: CvLibrary = {
    ...base,
    entries: [
      base.entries[0]!,
      { id: "ev-4", kind: "education", status: "active", heading: "MSc Operations", details: "Distinction." },
    ],
  };

  const merged = mergeCvLibrary(base, mine, latest, 4);
  const ids = merged.library.entries.map(entry => entry.id);
  expect(ids).toEqual(["ev-1", "ev-4", "ev-3"]);
  expect(merged.kept).toEqual(["Tools"]);
});

it("falls back to the stored library when the merge would not be a valid one", () => {
  // An addition that points at a job the stored version no longer has: the schema refuses it, so
  // nothing of it is applied and the note says the text has to come back from the download.
  const mine: CvLibrary = {
    ...base,
    entries: [
      ...base.entries,
      { id: "ev-5", kind: "experience", status: "active", employmentId: "job-9", heading: "Ghost", details: "Nothing." },
    ],
  };
  const merged = mergeCvLibrary(base, mine, base, 3);
  expect(merged.library).toEqual(base);
  expect(merged.kept).toEqual([]);
  expect(merged.note).toContain("could not be merged");
});
