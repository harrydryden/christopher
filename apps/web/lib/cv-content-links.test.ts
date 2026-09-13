import { expect, it } from "vitest";
import type { CvContent } from "@christopher/core/cv";
import { cvContentLinks, cvSectionBlockId } from "./cv-content-links";
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
