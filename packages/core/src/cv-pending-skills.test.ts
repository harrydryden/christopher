import { describe, expect, it } from "vitest";
import { CvContentSchema, CvLibrarySchema } from "./cv";
import { cvUserSkillProposals, separateCvModelSkillProposals } from "./cv-pending-skills";

const library = CvLibrarySchema.parse({ name: "Test", contact: "", profile: "", entries: [
  { id: "role", kind: "experience", heading: "Analyst", details: "Used SQL", confirmedResponsibilities: ["Used SQL"] },
  { id: "tools", kind: "skill", heading: "Data", details: "SQL", skillItems: ["SQL"] },
] });

describe("pending CV skills", () => {
  it("keeps only confirmed structured labels printable and collects a stable model opportunity", () => {
    const plan = { summary: "Used SQL", sections: [
      { entryId: "role", bullets: ["Used SQL"] },
      { entryId: "tools", bullets: ["SQL", "Python"], skillItems: ["SQL", "Python"] },
    ], gaps: [] };
    const first = separateCvModelSkillProposals(library, plan);
    const again = separateCvModelSkillProposals(library, plan);
    expect(first.plan.sections.find(section => section.entryId === "tools")?.skillItems).toEqual(["SQL"]);
    expect(first.proposals).toMatchObject([{ label: "Python", category: "Data", origin: "model", status: "pending" }]);
    expect(again.proposals).toEqual(first.proposals);
  });

  it("uses the exact source spelling for a confirmed skill and accepts a long user category", () => {
    const plan = { summary: "Used SQL", sections: [{ entryId: "tools", bullets: ["sql"], skillItems: ["sql"] }], gaps: [] };
    expect(separateCvModelSkillProposals(library, plan).plan.sections[0]?.skillItems).toEqual(["SQL"]);
    const heading = "Enterprise Technology, Data Analytics and Reporting Capabilities";
    const content = CvContentSchema.parse({ name: "Test", contact: "", summary: "Used SQL", gaps: [], sections: [
      { entryId: "manual-skill-1", kind: "skill", heading, bullets: ["Python"], skillItems: ["Python"] },
    ] });
    expect(cvUserSkillProposals(library, content)).toMatchObject([{ category: heading }]);
  });

  it("shows a person's manually entered unknown label without deleting it", () => {
    const content = CvContentSchema.parse({ name: "Test", contact: "", summary: "Used SQL", gaps: [], sections: [
      { entryId: "role", kind: "experience", heading: "Analyst", bullets: ["Used SQL"] },
      { entryId: "manual-skill-1", kind: "skill", heading: "Data", bullets: ["Python"], skillItems: ["Python"] },
    ] });
    expect(cvUserSkillProposals(library, content)).toMatchObject([{ label: "Python", origin: "user" }]);
    expect(content.sections[1]?.skillItems).toEqual(["Python"]);
  });

  it("offers a valid long manually entered skill for confirmation", () => {
    const label = "Designing complex multi-team delivery programmes";
    const content = CvContentSchema.parse({ name: "Test", contact: "", summary: "Used SQL", gaps: [], sections: [
      { entryId: "manual-skill-1", kind: "skill", heading: "Delivery", bullets: [label], skillItems: [label] },
    ] });
    expect(cvUserSkillProposals(library, content)).toMatchObject([{ label, origin: "user" }]);
  });

  it("does not treat an inactive Library label as confirmed evidence", () => {
    const content = CvContentSchema.parse({ name: "Test", contact: "", summary: "Used SQL", gaps: [], sections: [
      { entryId: "manual-skill-1", kind: "skill", heading: "Data", bullets: ["Python"], skillItems: ["Python"] },
    ] });
    const inactive = CvLibrarySchema.parse({ ...library, entries: [...library.entries,
      { id: "old-tools", kind: "skill", status: "inactive", heading: "Data", details: "Python", skillItems: ["Python"] }] });
    expect(cvUserSkillProposals(inactive, content)).toMatchObject([{ label: "Python", origin: "user" }]);
  });
});
