import { describe, expect, it } from "vitest";
import { migrateEmploymentHistory, EmploymentSchema, evidenceHeading, materialiseCv, groupCvLibrary, companyForEntry, CvLibrarySchema, type CvLibrary } from "./cv";
const library: CvLibrary = { name: "Test Candidate", contact: "London", profile: "Operations", entries: [
  { id: "recent", kind: "experience", heading: "Director · Acme · 2023-present", details: "Led operations", confirmedResponsibilities: ["Led operations"] },
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
    { id: "project", kind: "experience", company: "Acme", roleId: "recent", heading: "AI project", details: "Led operations\nBuilt an agent", confirmedResponsibilities: ["Led operations", "Built an agent"] },
    { id: "previous", kind: "experience", company: "Acme", heading: "Manager · Acme · 2020–2022", details: "Managed a team", confirmedResponsibilities: ["Managed a team"] },
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


describe("employment history", () => {
  const legacy: CvLibrary = { ...library, entries: [
    { id: "spill", kind: "experience", heading: "VP Operations · Spill · Aug 2025 – Present", details: "Led operations", confirmedResponsibilities: ["Led operations"] },
    { id: "agent", kind: "experience", company: "Spill", roleId: "spill", heading: "AI agents", details: "Built agents", confirmedResponsibilities: ["Built agents"] },
    { id: "sales", kind: "experience", heading: "VP Operations · SalesAPE · Aug 2023 – Jul 2025", details: "Built systems", confirmedResponsibilities: ["Built systems"] },
    { id: "previous", kind: "experience", heading: "Manager · Spill · 2020–2022", details: "Managed a team", confirmedResponsibilities: ["Managed a team"] },
    library.entries[1]!,
  ] };
  it("migrates dates and all linked blocks without changing evidence or old snapshots", () => {
    const snapshot = JSON.stringify(legacy);
    const migrated = CvLibrarySchema.parse(migrateEmploymentHistory(legacy));
    expect(migrated.employment).toHaveLength(3);
    expect(migrated.employment![0]).toMatchObject({ company: "Spill", jobTitle: "VP Operations", startDate: "2025-08", endDate: "", current: true });
    expect(migrated.employment![1]).toMatchObject({ startDate: "2023-08", endDate: "2025-07", current: false });
    expect(migrated.employment![2]).toMatchObject({ startDate: "2020", endDate: "2022" });
    expect(migrated.entries[1]).toMatchObject({ employmentId: "spill", heading: "AI agents", details: "Built agents" });
    expect(migrated.entries.every(entry => !entry.roleId && entry.company === undefined)).toBe(true);
    expect(migrateEmploymentHistory(migrated)).toEqual(migrated);
    expect(JSON.stringify(legacy)).toBe(snapshot);
  });
  it("deduplicates identical jobs but preserves separate tenures", () => {
    const migrated = migrateEmploymentHistory({ ...legacy, entries: [...legacy.entries, { ...legacy.entries[0]!, id: "duplicate" }] });
    expect(migrated.employment).toHaveLength(3);
    expect(migrated.entries.at(-1)!.employmentId).toBe("spill");
  });
  it("validates date ranges, duplicate jobs, broken links and non-experience links", () => {
    const migrated = migrateEmploymentHistory(legacy);
    const job = migrated.employment![0]!;
    for (const patch of [{ startDate: "2025-13" }, { startDate: "2025-06", endDate: "2025-05", current: false }, { endDate: "2025-12" }]) expect(EmploymentSchema.safeParse({ ...job, ...patch }).success).toBe(false);
    expect(CvLibrarySchema.safeParse({ ...migrated, employment: [...migrated.employment!, { ...job, id: "new-id", company: " spill " }] }).success).toBe(false);
    expect(CvLibrarySchema.safeParse({ ...migrated, employment: [] }).success).toBe(false);
    expect(CvLibrarySchema.safeParse({ ...migrated, entries: migrated.entries.map(entry => ({ ...entry, employmentId: "spill" })) }).success).toBe(false);
  });
  it("uses central metadata, groups once per job and keeps jobs after their original block is removed", () => {
    const migrated = migrateEmploymentHistory(legacy);
    migrated.employment![0]!.jobTitle = "Chief Operating Officer";
    migrated.entries = migrated.entries.filter(entry => entry.id !== "spill");
    const grouped = groupCvLibrary(migrated);
    expect(grouped.entries[0]).toMatchObject({ id: "agent", heading: "Chief Operating Officer · Spill · Aug 2025 – Present" });
    expect(evidenceHeading(migrated, migrated.entries[0]!)).toBe(grouped.entries[0]!.heading);
    const cv = materialiseCv(grouped, { summary: "Leader", sections: grouped.entries.map(entry => ({ entryId: entry.id, bullets: ["Supported achievement"] })), gaps: [] });
    expect(cv.sections.filter(section => section.heading.includes("Spill"))).toHaveLength(2);
    expect(() => materialiseCv(migrateEmploymentHistory(legacy), { summary: "Leader", sections: ["spill", "agent"].map(entryId => ({ entryId, bullets: ["Supported"] })), gaps: [] })).toThrow("same employment");
  });
});


describe("structured responsibilities", () => {
  it("groups companies and jobs by most recent employment", async () => {
    const { employmentCompanyGroups } = await import("./cv");
    const job = (id: string, company: string, startDate: string, endDate: string, current = false) => ({ id, company, jobTitle: id, startDate, endDate, current });
    const groups = employmentCompanyGroups([job("old", "Acme", "2010", "2012"), job("other", "Other", "2020", "2023"), job("new", " acme ", "2021", "", true)]);
    expect(groups.map(group => group.jobs.map(item => item.id))).toEqual([["new", "old"], ["other"]]);
  });
  it("consolidates duplicate job blocks and retains qualifications without truncation", async () => {
    const { consolidateExperience, CvLibrarySchema } = await import("./cv");
    const library = { name: "Test", contact: "", profile: "", employment: [{ id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true }], entries: [
      { id: "one", kind: "experience" as const, employmentId: "job", heading: "Director", details: "Led delivery.\nMeasured outcomes." },
      { id: "two", kind: "experience" as const, employmentId: "job", heading: "Requires confirmation", details: "Led delivery.\nProposed governance work." },
    ] };
    const migrated = consolidateExperience(library);
    expect(migrated.entries).toHaveLength(1);
    expect(migrated.entries[0]!.details).toBe("Led delivery.\nMeasured outcomes.\nRequires confirmation:\nProposed governance work.");
    expect(consolidateExperience(migrated)).toEqual(migrated);
    expect(library.entries).toHaveLength(2);
    expect(CvLibrarySchema.safeParse(migrated).success).toBe(true);
    expect(CvLibrarySchema.safeParse({ ...migrated, entries: [...migrated.entries, { ...migrated.entries[0], id: "duplicate" }] }).success).toBe(false);
    const overflow = { ...library, entries: [{ ...library.entries[0]!, details: Array.from({ length: 21 }, (_, i) => `Outcome ${i}`).join("\n") }] };
    expect(consolidateExperience(overflow).entries[0]!.details.split("\n")).toHaveLength(21);
    expect(CvLibrarySchema.safeParse(consolidateExperience(overflow)).success).toBe(false);
    expect(CvLibrarySchema.safeParse(overflow).success).toBe(true);
  });
});


describe("evidence status", () => {
  const entry = (id: string, status?: "draft" | "active" | "inactive") => ({ id, kind: "skill" as const, heading: id, details: `Evidence for ${id}`, status });
  const library = { name: "Test", contact: "", profile: "", entries: [entry("active", "active"), entry("draft", "draft"), entry("archived", "inactive")] };
  it("passes only active evidence to generation and rejects inactive model references", async () => {
    const { groupCvLibrary, materialiseCv } = await import("./cv");
    expect(groupCvLibrary(library).entries.map(e => e.id)).toEqual(["active"]);
    for (const entryId of ["draft", "archived"]) expect(() => materialiseCv(library, { summary: "Test", gaps: [], sections: [{ entryId, bullets: ["Must not appear"] }] })).toThrow();
    expect(() => groupCvLibrary({ ...library, entries: [entry("draft", "draft")] })).toThrow("Activate at least one");
    expect(groupCvLibrary({ ...library, entries: [entry("legacy")] }).entries).toHaveLength(1);
  });
  it("retains removed blocks as inactive and allows explicit reactivation", async () => {
    const { retainArchivedEvidence, groupCvLibrary } = await import("./cv");
    const saved = retainArchivedEvidence(library, { ...library, entries: [entry("active", "active")] });
    expect(saved.entries.map(e => [e.id, e.status])).toEqual([["active", "active"], ["draft", "inactive"], ["archived", "inactive"]]);
    const restored = { ...saved, entries: saved.entries.map(e => ({ ...e, status: "active" as const })) };
    expect(groupCvLibrary(restored).entries).toHaveLength(3);
  });
  it("does not combine inactive evidence into an active job section", async () => {
    const { groupCvLibrary } = await import("./cv");
    const job = { id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true };
    const source = { ...library, employment: [job], entries: library.entries.map(e => ({ ...e, kind: "experience" as const, employmentId: job.id, confirmedResponsibilities: [e.details] })) };
    const result = groupCvLibrary(source);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.details).toBe("Evidence for active");
  });
});

describe("responsibility confirmation", () => {
  const experience: CvLibrary["entries"][number] = { id: "job", kind: "experience", status: "active", heading: "Director · Acme", details: "Led operations\nBuilt tools\nProposed a new programme", confirmedResponsibilities: ["Led operations", "Built tools"] };
  it("passes only explicitly confirmed wording to CV generation and qualification", async () => {
    const { eligibleCvEvidence } = await import("./cv");
    const snapshot = JSON.stringify(experience);
    expect(eligibleCvEvidence(experience)?.details).toBe("Led operations\nBuilt tools");
    const grouped = groupCvLibrary({ ...library, entries: [experience] });
    expect(grouped.entries[0]!.details).not.toContain("Proposed");
    expect(groupCvLibrary(grouped)).toEqual(grouped);
    expect(JSON.stringify(experience)).toBe(snapshot);
    for (const patch of [{ confirmedResponsibilities: undefined }, { confirmedResponsibilities: [] }, { status: "draft" as const }, { status: "inactive" as const }]) {
      expect(eligibleCvEvidence({ ...experience, ...patch })).toBeUndefined();
      expect(() => materialiseCv({ ...library, entries: [{ ...experience, ...patch }] }, { summary: "Leader", sections: [{ entryId: "job", bullets: ["A claim"] }], gaps: [] })).toThrow("unconfirmed");
    }
  });
  it("does not infer confirmation from a legacy active block or stale text", async () => {
    const { consolidateExperience, eligibleCvEvidence } = await import("./cv");
    const legacy = { ...experience, heading: "Director · Acme · 2020–Present", confirmedResponsibilities: undefined };
    const migrated = consolidateExperience({ ...library, entries: [legacy] });
    expect(migrated.entries[0]!.confirmedResponsibilities).toEqual([]);
    expect(eligibleCvEvidence(migrated.entries[0]!)).toBeUndefined();
    expect(() => groupCvLibrary(migrated)).toThrow("confirm the responsibilities");
    expect(eligibleCvEvidence({ ...experience, confirmedResponsibilities: ["A removed statement"] })).toBeUndefined();
  });
  it("clears changed and removed rows without shifting confirmation to their replacements", async () => {
    const { updateResponsibilityRows, eligibleCvEvidence } = await import("./cv");
    const changed = updateResponsibilityRows(experience, ["New operations claim", "Built tools", "Proposed a new programme", "New row"]);
    expect(changed.confirmedResponsibilities).toEqual(["Built tools"]);
    expect(eligibleCvEvidence(changed)?.details).toBe("Built tools");
    const removed = updateResponsibilityRows(changed, ["Proposed a new programme", "New row"]);
    expect(removed.confirmedResponsibilities).toEqual([]);
    expect(eligibleCvEvidence(removed)).toBeUndefined();
    const reordered = updateResponsibilityRows(experience, ["Built tools", "Led operations"]);
    expect(eligibleCvEvidence(reordered)?.details).toBe("Built tools\nLed operations");
  });
});
