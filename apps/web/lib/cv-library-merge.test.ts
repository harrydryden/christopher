/**
 * "Reload and keep my text": what survives a save that was refused because the stored version had
 * moved on, and what is honestly reported as lost.
 */
import { expect, it } from "vitest";
import type { CvLibrary } from "@col/core/cv";
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
const reverseKeys = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;

it("ignores JSON object key order when reapplying employment and evidence edits", () => {
  // The database's jsonb round trip can reorder keys even when no field changed.
  const latest: CvLibrary = {
    ...base,
    employment: base.employment!.map(reverseKeys),
    entries: base.entries.map(reverseKeys),
  };
  const mine: CvLibrary = {
    ...edit(base, "ev-1", "Led four managers and eighteen schedulers."),
    employment: base.employment!.map(job => job.id === "job-1" ? { ...job, company: "Northwind Ltd" } : job),
  };
  const merged = mergeCvLibrary(base, mine, latest, 8);
  expect(merged.valid).toBe(true);
  expect(merged.conflicts).toEqual([]);
  expect(merged.dropped).toEqual([]);
  expect(merged.library.employment?.[0]?.company).toBe("Northwind Ltd");
  expect(merged.library.entries[0]?.details).toBe("Led four managers and eighteen schedulers.");
});

it("takes a genuine saved edit when the local row only has reordered keys", () => {
  const mine: CvLibrary = {
    ...base,
    employment: base.employment!.map(reverseKeys),
    entries: base.entries.map(reverseKeys),
  };
  const latest: CvLibrary = {
    ...edit(base, "ev-1", "Led five managers."),
    employment: base.employment!.map(job => job.id === "job-1" ? { ...job, company: "Northwind Ltd" } : job),
  };
  const merged = mergeCvLibrary(base, mine, latest, 8);
  expect(merged.valid).toBe(true);
  expect(merged.conflicts).toEqual([]);
  expect(merged.kept).toEqual([]);
  expect(merged.library.employment?.[0]?.company).toBe("Northwind Ltd");
  expect(merged.library.entries[0]?.details).toBe("Led five managers.");
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
  expect(merged.note).toContain("Northwind · Head of Operations was not carried automatically");
  expect(merged.note).toContain("your complete original draft remains available to copy or download");
  expect(merged.conflicts).toEqual([{
    key: "entry:ev-1",
    label: "Northwind · Head of Operations",
    mine: mine.entries[0],
    stored: latest.entries[0],
  }]);
  // Choosing local wording is a deliberate second merge against the same saved version.
  const chosen = mergeCvLibrary(base, mine, latest, 9, new Set(["entry:ev-1"]));
  expect(chosen.valid).toBe(true);
  expect(chosen.library.entries[0]?.details).toBe("Led four managers and eighteen schedulers.");
  expect(chosen.conflicts[0]?.mine).toEqual(mine.entries[0]);
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

it("makes a local block removal explicit and checks linked evidence before removing a job", () => {
  const withoutBlock: CvLibrary = { ...base, entries: [base.entries[0]!] };
  const pending = mergeCvLibrary(base, withoutBlock, base, 5);
  expect(pending.library.entries.map(entry => entry.id)).toEqual(["ev-1", "ev-2"]);
  expect(pending.conflicts).toEqual([{
    key: "entry:ev-2", label: "Calder · Service Manager (removed)", mine: null, stored: base.entries[1],
  }]);
  const removed = mergeCvLibrary(base, withoutBlock, base, 5, new Set(["entry:ev-2"]));
  expect(removed.valid).toBe(true);
  expect(removed.library.entries.map(entry => entry.id)).toEqual(["ev-1"]);

  const withoutJob: CvLibrary = { ...base, employment: [base.employment![0]!] };
  const invalid = mergeCvLibrary(base, withoutJob, base, 5, new Set(["employment:job-2"]));
  expect(invalid.valid).toBe(false);
  expect(invalid.library).toEqual(base);
  const bothRemoved = mergeCvLibrary(base, { ...withoutJob, entries: [base.entries[0]!] }, base, 5,
    new Set(["employment:job-2", "entry:ev-2"]));
  expect(bothRemoved.valid).toBe(true);
  expect(bothRemoved.library.employment?.map(job => job.id)).toEqual(["job-1"]);
  expect(bothRemoved.library.entries.map(entry => entry.id)).toEqual(["ev-1"]);
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
  expect(merged.valid).toBe(false);
  expect(merged.note).toContain("complete original draft is available below");
});
