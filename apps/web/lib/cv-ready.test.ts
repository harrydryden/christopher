/**
 * "Ready to build" has to mean what generation means by it, or the Library will say yes and the
 * build will refuse. These cases are the ones `groupCvLibrary` and `eligibleCvEvidence` decide.
 */
import { expect, it } from "vitest";
import { groupCvLibrary, type CvLibrary } from "@christopher/core/cv";
import { cvJobReadiness, cvLibraryReadiness, confirmableRows } from "./cv-ready";

const library = (overrides: Partial<CvLibrary> = {}): CvLibrary => ({
  name: "Rowan",
  contact: "Manchester",
  profile: "Operations leader.",
  structuredExperience: true,
  employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }],
  entries: [
    {
      id: "one",
      kind: "experience",
      status: "active",
      employmentId: "job",
      heading: "Director",
      details: "Led a team of nine.\nCut the close from nine days to five.",
      confirmedResponsibilities: [],
    },
  ],
  ...overrides,
});

const withEntry = (patch: Partial<CvLibrary["entries"][number]>) => {
  const base = library();
  return { ...base, entries: [{ ...base.entries[0]!, ...patch }] };
};

const buildable = (value: CvLibrary) => {
  try {
    groupCvLibrary(value);
    return true;
  } catch {
    return false;
  }
};

it("agrees with generation about confirmation and about evidence that has been archived", () => {
  const cases: [Partial<CvLibrary["entries"][number]>, boolean][] = [
    [{ confirmedResponsibilities: [] }, false],
    [{ confirmedResponsibilities: ["Led a team of nine."] }, true],
    [{ status: "active", confirmedResponsibilities: [] }, false],
    [{ status: "active", confirmedResponsibilities: ["Led a team of nine."] }, true],
    // Removed from employment history: kept for earlier versions, never built from again.
    [{ status: "inactive", confirmedResponsibilities: ["Led a team of nine."] }, false],
  ];
  for (const [patch, ready] of cases) {
    const value = withEntry(patch);
    expect(cvLibraryReadiness(value).ready, JSON.stringify(patch)).toBe(ready);
    expect(buildable(value), JSON.stringify(patch)).toBe(ready);
  }
});

it("names the nearest thing that would make the library buildable, and never says activate", () => {
  expect(cvLibraryReadiness(withEntry({ confirmedResponsibilities: [] })).line).toBe(
    "Ready to build: no — confirm Acme’s rows",
  );
  expect(cvLibraryReadiness(withEntry({ confirmedResponsibilities: ["Led a team of nine."] })).line).toBe(
    "Ready to build: yes",
  );
  // Nothing written at all: where to start, in the order the Library asks for it.
  expect(cvLibraryReadiness(library({ entries: [], employment: [] })).line).toBe(
    "Ready to build: no — add a job, write one responsibility or outcome and confirm it",
  );
  // Archived evidence is not on the screen, so it is not what the sentence points at either.
  expect(cvLibraryReadiness(withEntry({ status: "inactive", confirmedResponsibilities: ["Led a team of nine."] })).line).toBe(
    "Ready to build: no — add a job, write one responsibility or outcome and confirm it",
  );
});

it("counts one job's rows and confirmations the way the editor shows them", () => {
  const value = withEntry({ confirmedResponsibilities: ["Led a team of nine."] });
  expect(cvJobReadiness(value, "job")).toMatchObject({
    rows: 2,
    confirmed: 1,
    status: "active",
    eligible: true,
    // The status is not in the sentence: what is left to do about a job is always the confirming.
    line: "1 of 2 rows confirmed",
  });
  expect(confirmableRows(value, "job")).toEqual([
    "Led a team of nine.",
    "Cut the close from nine days to five.",
  ]);
  // Confirming every row is what the control does, and it makes the job usable.
  const confirmed = withEntry({ confirmedResponsibilities: confirmableRows(value, "job") });
  expect(cvJobReadiness(confirmed, "job").line).toBe("2 of 2 rows confirmed");
  expect(buildable(confirmed)).toBe(true);
  // One row reads as one row.
  expect(cvJobReadiness(withEntry({ details: "Led a team of nine." }), "job").line).toBe("0 of 1 row confirmed");
  // A job with no evidence block at all says so rather than counting zero of zero.
  expect(cvJobReadiness(library({ entries: [] }), "job")).toMatchObject({
    rows: 0,
    status: null,
    eligible: false,
    line: "No responsibilities or outcomes yet",
  });
  // And so does one whose rows have all been removed but whose block is still there.
  expect(cvJobReadiness(withEntry({ details: " " }), "job").line).toBe("No responsibilities or outcomes yet");
});

it("does not count a block that has just been added and not written yet", () => {
  // The Add button puts an empty block on the screen. It is not evidence, it cannot be stored,
  // and the Library says what to do next rather than that a CV could be built.
  const value = library({
    entries: [{ id: "new", kind: "skill", status: "active", heading: "", details: "" }],
    employment: [],
  });
  expect(cvLibraryReadiness(value)).toMatchObject({ ready: false, eligible: 0 });
  expect(cvLibraryReadiness(value).line).toBe(
    "Ready to build: no — add a job, write one responsibility or outcome and confirm it",
  );
});

it("counts a qualification as evidence in its own right, with no rows to confirm", () => {
  const value = library({
    entries: [
      { id: "edu", kind: "education", status: "active", heading: "MSc Operations", details: "Distinction, 2014." },
    ],
  });
  expect(cvLibraryReadiness(value)).toMatchObject({ ready: true, eligible: 1 });
  expect(buildable(value)).toBe(true);
  // Archived, it is not evidence and not what the Library asks about.
  expect(cvLibraryReadiness({ ...value, entries: [{ ...value.entries[0]!, status: "inactive" }] }).line).toBe(
    "Ready to build: no — add a job, write one responsibility or outcome and confirm it",
  );
});
