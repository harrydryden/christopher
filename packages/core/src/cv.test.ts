import { describe, expect, it } from "vitest";
import { materialiseCv, groupCvLibrary, companyForEntry, CvLibrarySchema, type CvLibrary } from "./cv";
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

describe("company and role grouping", () => {
  const grouped: CvLibrary = { ...library, entries: [
    { ...library.entries[0]!, company: "Acme" },
    { id: "project", kind: "experience", company: "Acme", roleId: "recent", heading: "AI project", details: "Led operations\nBuilt an agent" },
    { id: "previous", kind: "experience", company: "Acme", heading: "Manager · Acme · 2020–2022", details: "Managed a team" },
    library.entries[1]!,
  ] };
  it("combines linked evidence before generation while keeping other jobs distinct", () => {
    const result = groupCvLibrary(grouped);
    expect(result.entries.map(x => x.id)).toEqual(["recent", "previous", "older"]);
    expect(result.entries[0]!.details).toBe("Led operations\n\nBuilt an agent");
    const cv = materialiseCv(result, { summary: "Leader", sections: result.entries.map(x => ({ entryId: x.id, bullets: ["Supported achievement"] })), gaps: [] });
    expect(cv.sections.map(x => x.heading)).toEqual(result.entries.map(x => x.heading));
    expect(grouped.entries).toHaveLength(4);
  });
  it("rejects cross-company links, missing roles and linked-role chains", () => {
    for (const patch of [{ company: "Other" }, { roleId: "missing" }, { roleId: "project" }]) {
      expect(CvLibrarySchema.safeParse({ ...grouped, entries: grouped.entries.map(x => x.id === "project" ? { ...x, ...patch } : x) }).success).toBe(false);
    }
  });
  it("preserves old libraries and infers only the company from legacy headings", () => {
    expect(companyForEntry(library.entries[0]!)).toBe("Acme");
    expect(groupCvLibrary(library).entries).toEqual(library.entries);
    expect(CvLibrarySchema.parse(grouped).entries[1]!.roleId).toBe("recent");
  });
  it("does not allow the model to emit a linked block as a second job", () => {
    expect(() => materialiseCv(groupCvLibrary(grouped), { summary: "Leader", sections: [{ entryId: "project", bullets: ["Built an agent"] }], gaps: [] })).toThrow();
  });
});
