/**
 * A refused save has to point at the row the person can see. The paths below are the ones
 * `CvLibrarySchema` actually produces, so the names are read from the value that was posted.
 */
import { expect, it } from "vitest";
import { CvLibrarySchema } from "@christopher/core/cv";
import { cvLibraryIssues } from "./cv-library-issues";

/** The shape the editor posts: unvalidated, because that is when these names are needed. */
const posted = {
  name: "Rowan Mercer",
  contact: "Manchester",
  profile: "Operations leader.",
  structuredExperience: true,
  employment: [
    { id: "job-1", company: "Northwind Health", jobTitle: "Head of Operations", startDate: "2020-01", endDate: "", current: true },
    { id: "job-2", company: "Calder Logistics", jobTitle: "Service Manager", startDate: "not-a-date", endDate: "2019", current: false },
  ],
  entries: [
    { id: "ev-1", kind: "experience", status: "active", employmentId: "job-1", heading: "Head of Operations", details: "Led four managers.", confirmedResponsibilities: ["Led four managers."] },
    { id: "ev-2", kind: "education", status: "active", heading: "", details: "Distinction." },
  ],
};

const refusal = (value: unknown) => {
  const parsed = CvLibrarySchema.safeParse(value);
  expect(parsed.success).toBe(false);
  return cvLibraryIssues(parsed.error!, value);
};

it("names the job and the field a bad date belongs to", () => {
  const message = refusal(posted);
  expect(message).toContain("Calder Logistics · Service Manager (Start date)");
  expect(message).not.toContain("Job 2");
});

it("names an evidence block by its label, or by the job it belongs to when it has none", () => {
  const message = refusal({
    ...posted,
    employment: [posted.employment[0]],
    entries: [{ ...posted.entries[0], heading: "", details: "" }],
  });
  // No label of its own: the employment row it is linked to names it.
  expect(message).toContain("Northwind Health · Head of Operations");
  expect(message).not.toMatch(/Evidence 1 \(/);
});

it("falls back to the position when the posted value says nothing about the row", () => {
  const message = refusal({ ...posted, employment: [], entries: [{ id: "x", kind: "skill", heading: "", details: "" }] });
  expect(message).toContain("Evidence 1");
});

it("repeats a whole-library refusal once, without a field name", () => {
  const duplicated = {
    ...posted,
    employment: [posted.employment[0]],
    entries: [posted.entries[0], { ...posted.entries[0] }],
  };
  const message = refusal(duplicated);
  expect(message).toContain("Library entry IDs must be unique");
  expect(message.match(/Library entry IDs must be unique/g)).toHaveLength(1);
});
