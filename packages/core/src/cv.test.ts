import { describe, expect, it } from "vitest";
import { contactLine, splitLegacyContact, migrateEmploymentHistory, EmploymentSchema, evidenceHeading, materialiseCv, groupCvLibrary, companyForEntry, CvLibrarySchema, EVIDENCE_FACETS, consolidateExperience, eligibleCvEvidence, normaliseCvLibrary, rowFacets, setRowFacets, updateResponsibilityRows, type CvLibrary, type Employment } from "./cv";
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
  const entry = (id: string, status?: "active" | "inactive") => ({ id, kind: "skill" as const, heading: id, details: `Evidence for ${id}`, status });
  /** `stored` is what a release that still let someone mark a block Draft wrote. */
  const stored = { id: "stored-draft", kind: "skill" as const, heading: "stored-draft", details: "Evidence for stored-draft", status: "draft" };
  const library = { name: "Test", contact: "", profile: "", entries: [entry("active", "active"), entry("legacy"), entry("archived", "inactive")] };
  it("reads a stored draft as active, and refuses the word for anything new", async () => {
    const { CvLibrarySchema, consolidateExperience, isActiveEvidence } = await import("./cv");
    const parsed = CvLibrarySchema.parse({ ...library, entries: [stored] });
    expect(parsed.entries[0]!.status).toBe("active");
    expect(isActiveEvidence(parsed.entries[0]!)).toBe(true);
    // The upgrade does not depend on the parse: the editor consolidates what it was handed.
    expect(consolidateExperience({ ...library, entries: [stored] } as never).entries[0]!.status).toBe("active");
    expect(CvLibrarySchema.safeParse({ ...library, entries: [{ ...stored, status: "pending" }] }).success).toBe(false);
  });
  it("reads a stored draft as evidence for a reader that cannot parse first", async () => {
    // Three readers are handed `cv_libraries.content` or a draft's snapshot exactly as stored —
    // the Library's evidence display, the gap quiz's destinations and the answer it writes —
    // because the reviews and the snapshot are keyed to those entries. Asked of raw JSON,
    // `isActiveEvidence` reads the word an earlier release wrote as "not active" and drops a
    // block the editor beside it is showing; archived is the only status that stands one aside.
    const { isActiveEvidence, isActiveStoredEvidence } = await import("./cv");
    expect(isActiveEvidence(stored as never)).toBe(false);
    expect(isActiveStoredEvidence(stored as never)).toBe(true);
    for (const item of [entry("active", "active"), entry("legacy")]) expect(isActiveStoredEvidence(item)).toBe(true);
    expect(isActiveStoredEvidence(entry("archived", "inactive"))).toBe(false);
  });
  it("passes only active evidence to generation and rejects inactive model references", async () => {
    const { groupCvLibrary, materialiseCv } = await import("./cv");
    expect(groupCvLibrary(library).entries.map(e => e.id)).toEqual(["active", "legacy"]);
    expect(() => materialiseCv(library, { summary: "Test", gaps: [], sections: [{ entryId: "archived", bullets: ["Must not appear"] }] })).toThrow();
    expect(() => groupCvLibrary({ ...library, entries: [entry("archived", "inactive")] })).toThrow("Confirm at least one responsibility or outcome");
    expect(groupCvLibrary({ ...library, entries: [entry("legacy")] }).entries).toHaveLength(1);
  });
  it("retains removed blocks as inactive and allows explicit reactivation", async () => {
    const { retainArchivedEvidence, groupCvLibrary } = await import("./cv");
    const saved = retainArchivedEvidence(library, { ...library, entries: [entry("active", "active")] });
    expect(saved.entries.map(e => [e.id, e.status])).toEqual([["active", "active"], ["legacy", "inactive"], ["archived", "inactive"]]);
    const restored = { ...saved, entries: saved.entries.map(e => ({ ...e, status: "active" as const })) };
    expect(groupCvLibrary(restored).entries).toHaveLength(3);
  });
  it("does not combine inactive evidence into an active job section", async () => {
    const { groupCvLibrary } = await import("./cv");
    const job = { id: "job", company: "Acme", jobTitle: "Director", startDate: "2020", endDate: "", current: true };
    const source = { ...library, employment: [job], entries: library.entries.map(e => ({ ...e, kind: "experience" as const, employmentId: job.id, confirmedResponsibilities: [e.details] })) };
    const result = groupCvLibrary(source);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.details).toBe("Evidence for active\n\nEvidence for legacy");
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
    for (const patch of [{ confirmedResponsibilities: undefined }, { confirmedResponsibilities: [] }, { status: "inactive" as const }]) {
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
    expect(() => groupCvLibrary(migrated)).toThrow("Confirm at least one responsibility or outcome");
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

describe("employment industry descriptions", () => {
  const job = { id: "job", company: "Acme", industryDescriptions: "Workplace mental health, SaaS, AI", jobTitle: "Director", startDate: "2020", endDate: "", current: true };
  const source: CvLibrary = { ...library, employment: [job], entries: [{ ...library.entries[0]!, employmentId: job.id }] };
  it("parses comma-separated descriptions and shares edits across the same company", async () => {
    const { industryDescriptions, updateEmploymentIndustries } = await import("./cv");
    expect(industryDescriptions(" SaaS, Healthcare, saas, , AI ")).toEqual(["SaaS", "Healthcare", "AI"]);
    const employment = [job, { ...job, id: "older", company: " acme " }, { ...job, id: "other", company: "Other" }];
    const updated = updateEmploymentIndustries(employment, "job", "Healthcare, AI");
    expect(updated.map(item => item.industryDescriptions)).toEqual(["Healthcare, AI", "Healthcare, AI", job.industryDescriptions]);
    expect(updated.map(item => [item.jobTitle, item.startDate, item.endDate])).toEqual(employment.map(item => [item.jobTitle, item.startDate, item.endDate]));
    expect(employment[0]!.industryDescriptions).toBe(job.industryDescriptions);
    expect(EmploymentSchema.safeParse({ ...job, industryDescriptions: Array.from({ length: 11 }, (_, i) => `Industry ${i}`).join(",") }).success).toBe(false);
  });
  it("grounds selected descriptions in employment history and preserves legacy CVs", () => {
    const plan = { summary: "Leader", sections: [{ entryId: "recent", industryDescriptions: ["saas", "AI"], bullets: ["Led operations"] }], gaps: [] };
    const grouped = groupCvLibrary(source);
    expect(grouped.employment![0]!.industryDescriptions).toBe(job.industryDescriptions);
    const content = materialiseCv(grouped, plan);
    expect(content.sections[0]!.industryDescriptions).toEqual(["SaaS", "AI"]);
    expect(content.sections[0]!.heading).toBe("Director · Acme · 2020 – Present");
    expect(() => materialiseCv(grouped, { ...plan, sections: [{ ...plan.sections[0]!, industryDescriptions: ["Robotics"] }] })).toThrow("not in employment history");
    expect(materialiseCv(library, { summary: "Leader", sections: [{ entryId: "recent", bullets: ["Led operations"] }], gaps: [] }).sections[0]!.industryDescriptions).toBeUndefined();
  });
});

it("validates website links and carries them from the library into CV content", () => {
  const websiteUrl = "https://example.com/portfolio";
  const source = CvLibrarySchema.parse({ ...library, websiteUrl });
  expect(materialiseCv(source, { summary: "Leader", sections: [{ entryId: "recent", bullets: ["Led operations"] }], gaps: [] }).websiteUrl).toBe(websiteUrl);
  for (const unsafe of ["javascript:alert(1)", "data:text/html,test", "https://user:password@example.com", "not a URL"]) {
    expect(CvLibrarySchema.safeParse({ ...library, websiteUrl: unsafe }).success).toBe(false);
  }
});

it("keeps a subsidiary label that heads confirmed wording and drops one that heads none", async () => {
  const { eligibleCvEvidence } = await import("./cv");
  const entry: CvLibrary["entries"][number] = { id: "job", kind: "experience", status: "active", heading: "Director · Acme Group", details: "Led core platform\nAcme Labs Ltd:\nRan the research lab\nAcme Ventures:\nProposed a fund", confirmedResponsibilities: ["Led core platform", "Ran the research lab"] };
  const eligible = eligibleCvEvidence(entry)!;
  expect(eligible.details).toBe("Led core platform\nAcme Labs Ltd:\nRan the research lab");
  expect(eligible.confirmedResponsibilities).toEqual(["Led core platform", "Ran the research lab"]);
  expect(eligibleCvEvidence({ ...entry, confirmedResponsibilities: [] })).toBeUndefined();
});


/**
 * A row's types: what a stored library holds, what is written back, and what survives an edit.
 *
 * The six ids and their order are fixed; what changed is that a row carries as many of them as it
 * serves, because one sentence is often the problem somebody solved and the figure it moved. Every
 * library stored before that carries a single id as a bare string, so the first case here is the
 * one that matters most: it must still parse, and read as a list of one.
 */
describe("row types", () => {
  const job: Employment = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };
  const led = "Led the warehouse team through a move to a new site";
  const cut = "Cut handover time by 40%, which ended the weekend backlog";
  const faceted = (rowFacets: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    name: "Test Candidate", contact: "London", profile: "Operations", structuredExperience: true, employment: [job],
    entries: [{ id: "acme-block", kind: "experience", status: "active", heading: "Operations Director · Acme",
      details: [led, cut].join("\n"), employmentId: "acme", rowFacets, ...over }],
  });
  const parsed = (rowFacets: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    CvLibrarySchema.parse(faceted(rowFacets, over)).entries[0]!;

  it("reads the single type a stored library holds as a list of one", () => {
    const entry = parsed({ [led]: "responsibility", [cut]: "metric" });
    expect(entry.rowFacets).toEqual({ [led]: ["responsibility"], [cut]: ["metric"] });
    expect(rowFacets(entry, cut)).toEqual(["metric"]);
    expect(rowFacets(entry, "A row nobody wrote")).toEqual([]);
    // Also without the parse: a stored library reaches a reader unparsed in more than one place.
    const stored = faceted({ [cut]: "metric" }) as unknown as CvLibrary;
    expect(rowFacets(stored.entries[0]!, cut)).toEqual(["metric"]);
  });

  it("writes them unique and in the canonical order, whatever order they were chosen in", () => {
    expect(parsed({ [cut]: ["metric", "problem", "metric"] }).rowFacets).toEqual({ [cut]: ["problem", "metric"] });
    expect(parsed({ [cut]: [...EVIDENCE_FACETS].reverse() }).rowFacets).toEqual({ [cut]: [...EVIDENCE_FACETS] });
    // A tag the Library could not show is a bug, not bookkeeping: it is refused, not dropped.
    expect(CvLibrarySchema.safeParse(faceted({ [cut]: ["vibes"] })).success).toBe(false);
    expect(CvLibrarySchema.safeParse(faceted({ [cut]: "vibes" })).success).toBe(false);
    // No types is no tag, written by removing the row's key rather than storing an empty list.
    expect(CvLibrarySchema.safeParse(faceted({ [cut]: [] })).success).toBe(false);
  });

  it("tags and untags a row through setRowFacets", () => {
    const entry = parsed({ [cut]: ["metric", "problem"] });
    const tagged = setRowFacets(entry, led, ["style", "responsibility", "style"]);
    expect(tagged.rowFacets).toEqual({ [cut]: ["problem", "metric"], [led]: ["responsibility", "style"] });
    expect(setRowFacets(tagged, led, []).rowFacets).toEqual({ [cut]: ["problem", "metric"] });
    expect(setRowFacets(setRowFacets(tagged, led, []), cut, []).rowFacets).toBeUndefined();
    expect(CvLibrarySchema.safeParse({ ...faceted({}), entries: [tagged] }).success).toBe(true);
  });

  it("carries every type of a row across an edit, and takes them away with the row", () => {
    const entry = parsed({ [led]: "responsibility", [cut]: ["problem", "metric"] });
    const reworded = `${led} in Leeds`;
    const edited = updateResponsibilityRows(entry, [reworded, cut]);
    expect(edited.rowFacets).toEqual({ [reworded]: ["responsibility"], [cut]: ["problem", "metric"] });
    // Rows are matched by text first and by position second, so a reworded row keeps its types.
    expect(updateResponsibilityRows(edited, ["Ran the same move, rewritten", cut]).rowFacets)
      .toEqual({ "Ran the same move, rewritten": ["responsibility"], [cut]: ["problem", "metric"] });
    const removed = updateResponsibilityRows(edited, [reworded]);
    expect(removed.rowFacets).toEqual({ [reworded]: ["responsibility"] });
    expect(updateResponsibilityRows(removed, []).rowFacets).toBeUndefined();
  });

  it("unions the types when two blocks for one job are consolidated", () => {
    const library = {
      name: "Test Candidate", contact: "London", profile: "Operations", employment: [job],
      entries: [
        { id: "first", kind: "experience" as const, heading: "Operations Director", details: [led, cut].join("\n"), employmentId: "acme", rowFacets: { [cut]: "problem" } },
        { id: "second", kind: "experience" as const, heading: "Same job, second block", details: cut, employmentId: "acme", rowFacets: { [cut]: ["metric"], [led]: ["responsibility"] } },
      ],
    };
    const consolidated = consolidateExperience(library as unknown as CvLibrary);
    expect(consolidated.entries).toHaveLength(1);
    expect(consolidated.entries[0]!.rowFacets).toEqual({ [led]: ["responsibility"], [cut]: ["problem", "metric"] });
    expect(consolidated.entries[0]!.status).toBe("active");
    expect(consolidated.facetedRows).toBe(true);
    // A stale key goes with its row, so a tag cannot outlive the wording it was about.
    expect(consolidateExperience({ ...consolidated, entries: [{ ...consolidated.entries[0]!, details: cut }] }).entries[0]!.rowFacets).toEqual({ [cut]: ["problem", "metric"] });
  });

  it("gives generation the tags of the rows it is given, and no others", () => {
    const entry = parsed({ [led]: "responsibility", [cut]: ["metric"] }, { confirmedResponsibilities: [cut] });
    const eligible = eligibleCvEvidence(entry)!;
    expect(eligible.details).toBe(cut);
    expect(eligible.rowFacets).toEqual({ [cut]: ["metric"] });
  });

  it("upgrades a stored library on read, through one entry point", () => {
    const legacy = {
      name: "Test Candidate", contact: "London", profile: "Operations", employment: [job],
      entries: [{ id: "acme-block", kind: "experience", status: "draft", heading: "Operations Director", details: [led, cut].join("\n"), employmentId: "acme", rowFacets: { [cut]: "metric" } }],
    };
    const upgraded = normaliseCvLibrary(legacy);
    expect(upgraded.entries[0]).toMatchObject({ status: "active", rowFacets: { [cut]: ["metric"] } });
    expect(upgraded.structuredExperience).toBe(true);
    expect(upgraded.facetedRows).toBe(true);
    expect(normaliseCvLibrary(upgraded)).toEqual(upgraded);
  });
});

describe("contact details", () => {
  const plan = { summary: "Operations leader", sections: [{ entryId: "recent", bullets: ["Led operations"] }], gaps: [] };

  it("prints email · phone · location, then the free-text line, on one CV line", () => {
    const withFields: CvLibrary = { ...library, email: "rowan@example.test", phone: "+44 7700 900123", location: "Manchester, UK", contact: "Portfolio on request" };
    expect(contactLine(withFields)).toBe("rowan@example.test · +44 7700 900123 · Manchester, UK · Portfolio on request");
    expect(materialiseCv(withFields, plan).contact).toBe("rowan@example.test · +44 7700 900123 · Manchester, UK · Portfolio on request");
    // Blank parts are skipped, and a library from before the fields prints what it always did.
    expect(contactLine({ ...library, email: "", phone: " ", location: "Leeds", contact: "" })).toBe("Leeds");
    expect(materialiseCv(library, plan).contact).toBe("London");
  });

  it("parses a library saved before the fields existed, and refuses an address that is not one", () => {
    expect(CvLibrarySchema.parse(library)).not.toHaveProperty("email");
    expect(CvLibrarySchema.safeParse({ ...library, email: "rowan@example.test", phone: "+44 7700 900123", location: "Leeds" }).success).toBe(true);
    expect(CvLibrarySchema.safeParse({ ...library, email: "" }).success).toBe(true);
    expect(CvLibrarySchema.safeParse({ ...library, email: "rowan at example" }).success).toBe(false);
    expect(CvLibrarySchema.safeParse({ ...library, location: "Leeds\nUK" }).success).toBe(false);
    // The printed line has the CV's own limit, whichever fields make it up.
    expect(CvLibrarySchema.safeParse({ ...library, contact: "x".repeat(480), location: "Manchester, United Kingdom" }).success).toBe(false);
  });

  it("moves an unambiguous address and number out of an old free-text line and keeps the rest", () => {
    const opened = splitLegacyContact({ ...library, contact: "Manchester, UK · rowan.mercer@example.test · +44 7700 900123" });
    expect(opened).toMatchObject({ email: "rowan.mercer@example.test", phone: "+44 7700 900123", contact: "Manchester, UK" });
    expect(opened.location).toBeUndefined();
    // Nothing is lost: every part of the old line is in exactly one field.
    expect(contactLine(opened).split(" · ").sort()).toEqual(["+44 7700 900123", "Manchester, UK", "rowan.mercer@example.test"]);
    // Run twice, it does nothing more.
    expect(splitLegacyContact(opened)).toBe(opened);
  });

  it("leaves a tightly punctuated line alone when rejoining it would break the cap", () => {
    // Rejoining with " · " adds two characters per separator; a line near the limit would open
    // over it and the next unrelated save would be refused. Such a line stays as it was.
    // 103 parts joined by ";" is 493 characters; joined by " · " it would be 697.
    const tight = { ...library, contact: ["a@b.test", "0161 496 0000", ...Array.from({ length: 100 }, () => "x"), "y".repeat(270)].join(";") };
    expect(contactLine(tight).length).toBe(493);
    expect(splitLegacyContact(tight)).toBe(tight);
  });

  it("guesses nothing: a lone phrase, two addresses or a library already upgraded stay as they are", () => {
    const city = { ...library, contact: "London" };
    expect(splitLegacyContact(city)).toBe(city);
    const two = { ...library, contact: "a@example.test | b@example.test" };
    expect(splitLegacyContact(two)).toBe(two);
    const upgraded = { ...library, email: "", contact: "c@example.test" };
    expect(splitLegacyContact(upgraded)).toBe(upgraded);
    const inline = { ...library, contact: "Email me at a@example.test" };
    expect(splitLegacyContact(inline)).toBe(inline);
  });
});
