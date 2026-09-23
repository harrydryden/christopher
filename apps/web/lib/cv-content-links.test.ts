import { expect, it } from "vitest";
import type { CvContent } from "@ava/core/cv";
import { cvContentLinks, cvLibraryJobFor, cvSectionBlockId, cvSectionEntryId } from "./cv-content-links";
const content: CvContent = {
  name: "Candidate",
  contact: "",
  summary: "Profile",
  gaps: [],
  sections: [
    {
      entryId: "job",
      kind: "experience",
      heading: "Director · Example",
      bullets: ["Led a team"],
    },
    {
      entryId: "job:skills / β",
      kind: "skill",
      heading: "Skills",
      bullets: ["SQL"],
    },
    {
      entryId: "education",
      kind: "education",
      heading: "University",
      bullets: ["Degree"],
    },
  ],
};
it("links cited prose, headings and library evidence to the actual editable blocks, once each", () => {
  expect(
    cvContentLinks(content, [
      "profile",
      "source:profile",
      "section:job:0",
      "section:job:heading",
      "entry:job",
      "section:education:0",
      "entry:job:skills / β",
    ]),
  ).toEqual([
    { id: "cv-content-profile", label: "Profile" },
    { id: cvSectionBlockId("job"), label: "Director · Example" },
    { id: cvSectionBlockId("education"), label: "University" },
    { id: cvSectionBlockId("job:skills / β"), label: "Skills" },
  ]);
});
it("handles section IDs containing colons without linking to a different block", () => {
  expect(cvContentLinks(content, ["section:job:skills / β:0"])).toEqual([
    { id: cvSectionBlockId("job:skills / β"), label: "Skills" },
  ]);
});
it("does not invent targets for absent source blocks", () => {
  expect(
    cvContentLinks(content, ["entry:omitted", "section:unknown:0"]),
  ).toEqual([]);
  expect(cvContentLinks(null, ["profile"])).toEqual([]);
});

it("reads the entry a block belongs to back out of its id, and nothing else", () => {
  for (const entryId of ["job", "job:skills / β", "emp/one?two"]) {
    expect(cvSectionEntryId(cvSectionBlockId(entryId))).toBe(entryId);
  }
  expect(cvSectionEntryId("cv-content-profile")).toBeNull();
  expect(cvSectionEntryId("cv-panel-content")).toBeNull();
  expect(cvSectionEntryId("cv-content-section-")).toBeNull();
  // A hand-edited fragment that is not valid encoding answers nothing rather than throwing.
  expect(cvSectionEntryId("cv-content-section-%E0%A4%A")).toBeNull();
});

it("names one Library job when the links agree on one, and none when they do not", () => {
  const entries = [
    { id: "job", kind: "experience" as const, employmentId: "emp-1", heading: "Director", details: "Led a team" },
    { id: "second", kind: "experience" as const, employmentId: "emp-1", heading: "Manager", details: "Ran a team" },
    { id: "other", kind: "experience" as const, employmentId: "emp-2", heading: "Analyst", details: "Modelled" },
    { id: "education", kind: "education" as const, heading: "University", details: "Degree" },
  ];
  const link = (entryId: string) => ({ id: cvSectionBlockId(entryId), label: entryId });

  expect(cvLibraryJobFor([link("job")], { entries })).toBe("emp-1");
  // Two blocks of the same job are still that job.
  expect(cvLibraryJobFor([link("job"), link("second")], { entries })).toBe("emp-1");
  // Two jobs, or none, send the reader to the Library's own list rather than to the wrong one.
  expect(cvLibraryJobFor([link("job"), link("other")], { entries })).toBeNull();
  expect(cvLibraryJobFor([link("education")], { entries })).toBeNull();
  expect(cvLibraryJobFor([{ id: "cv-content-profile", label: "Profile" }], { entries })).toBeNull();
  expect(cvLibraryJobFor([link("job")], null)).toBeNull();
  expect(cvLibraryJobFor([], { entries })).toBeNull();
});
