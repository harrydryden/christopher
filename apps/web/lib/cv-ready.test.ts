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
      status: "draft",
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

it("agrees with generation about every combination of status and confirmation", () => {
  const cases: [Partial<CvLibrary["entries"][number]>, boolean][] = [
    [{ status: "draft", confirmedResponsibilities: [] }, false],
    [{ status: "draft", confirmedResponsibilities: ["Led a team of nine."] }, false],
    [{ status: "active", confirmedResponsibilities: [] }, false],
    [{ status: "active", confirmedResponsibilities: ["Led a team of nine."] }, true],
    [{ status: "inactive", confirmedResponsibilities: ["Led a team of nine."] }, false],
  ];
  for (const [patch, ready] of cases) {
    const value = withEntry(patch);
    expect(cvLibraryReadiness(value).ready, JSON.stringify(patch)).toBe(ready);
    expect(buildable(value), JSON.stringify(patch)).toBe(ready);
  }
});

it("names the nearest thing that would make the library buildable", () => {
  expect(cvLibraryReadiness(withEntry({ status: "draft", confirmedResponsibilities: [] })).line).toBe(
    "Ready to build: no — activate Acme and confirm its rows",
  );
  expect(
    cvLibraryReadiness(withEntry({ status: "draft", confirmedResponsibilities: ["Led a team of nine."] })).line,
  ).toBe("Ready to build: no — activate Acme");
  expect(cvLibraryReadiness(withEntry({ status: "active", confirmedResponsibilities: [] })).line).toBe(
    "Ready to build: no — confirm Acme’s rows",
  );
  expect(cvLibraryReadiness(withEntry({ status: "active", confirmedResponsibilities: ["Led a team of nine."] })).line).toBe(
    "Ready to build: yes",
  );
  expect(cvLibraryReadiness(library({ entries: [], employment: [] })).line).toMatch(/^Ready to build: no — add a job/);
});

it("counts one job's rows and confirmations the way the editor shows them", () => {
  const value = withEntry({ status: "active", confirmedResponsibilities: ["Led a team of nine."] });
  expect(cvJobReadiness(value, "job")).toMatchObject({
    rows: 2,
    confirmed: 1,
    status: "active",
    eligible: true,
    line: "1 of 2 rows confirmed · active",
  });
  expect(confirmableRows(value, "job")).toEqual([
    "Led a team of nine.",
    "Cut the close from nine days to five.",
  ]);
  // Confirming every row is what the control does, and it makes the job usable.
  const confirmed = withEntry({ status: "active", confirmedResponsibilities: confirmableRows(value, "job") });
  expect(cvJobReadiness(confirmed, "job").line).toBe("2 of 2 rows confirmed · active");
  expect(buildable(confirmed)).toBe(true);
  // A job with no evidence block at all says so rather than counting zero of zero.
  expect(cvJobReadiness(library({ entries: [] }), "job")).toMatchObject({
    rows: 0,
    status: null,
    eligible: false,
    line: "No responsibilities or outcomes yet",
  });
});

it("counts a qualification as evidence in its own right, with no rows to confirm", () => {
  const value = library({
    entries: [
      { id: "edu", kind: "education", status: "active", heading: "MSc Operations", details: "Distinction, 2014." },
    ],
  });
  expect(cvLibraryReadiness(value)).toMatchObject({ ready: true, eligible: 1 });
  expect(buildable(value)).toBe(true);
  expect(cvLibraryReadiness({ ...value, entries: [{ ...value.entries[0]!, status: "draft" }] }).line).toBe(
    "Ready to build: no — activate MSc Operations",
  );
});
