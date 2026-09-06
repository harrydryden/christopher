import { describe, expect, it } from "vitest";
import { materialiseCv, CvLibrarySchema, type CvLibrary } from "./cv";
const library: CvLibrary = { name: "Test Candidate", contact: "London", profile: "Operations", entries: [
  { id: "recent", kind: "experience", heading: "Director · Acme · 2023-present", details: "Led operations" },
  { id: "older", kind: "education", heading: "BSc · University · 2010", details: "Economics" },
] };
describe("CV evidence grounding", () => {
  it("uses library headings and chronology regardless of model order", () => {
    const cv = materialiseCv(library, { summary: "Operations leader", sections: [{ entryId: "older", bullets: ["Economics"] }, { entryId: "recent", bullets: ["Led operations"] }], gaps: ["No evidence for aviation experience"] });
    expect(cv.sections.map(s => s.heading)).toEqual(library.entries.map(e => e.heading));
    expect(cv.name).toBe(library.name);
  });
  it("rejects invented and duplicated evidence IDs", () => {
    for (const ids of [["invented"], ["recent", "recent"]]) expect(() => materialiseCv(library, { summary: "Summary", sections: ids.map(entryId => ({ entryId, bullets: ["Claim"] })), gaps: [] })).toThrow();
  });
  it("rejects ambiguous library IDs", () => {
    expect(CvLibrarySchema.safeParse({ ...library, entries: [library.entries[0], library.entries[0]] }).success).toBe(false);
  });
});
