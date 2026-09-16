import { describe, expect, it } from "vitest";
import { suggestFromScans, type ScannedTitle } from "./suggest-from-scans";
import type { GateSettings } from "./gate";

const gate: GateSettings = {
  includeKeywords: ["Operations", "Strategy", "Finance"], excludeKeywords: ["Engineer", "HR"],
  seniorityKeywords: ["Director", "VP", "Head of", "Chief"], matchFields: ["title"], locationTerms: ["London", "UK"], includeRemote: true,
};
const t = (title: string, company: string, location = "London, UK"): ScannedTitle => ({ title, company, location });

describe("suggestFromScans", () => {
  const postings: ScannedTitle[] = [
    // Held back only by the seniority list: "Lead" would admit these.
    t("Operations Lead", "Acme"), t("Finance Lead, EMEA", "Acme"), t("Strategy Lead", "Beta"), t("Business Operations Lead", "Gamma"),
    // A senior role missing every include keyword, in several inflections.
    t("Director of Partnerships", "Acme"), t("Head of Partnership Development", "Beta"), t("VP Partnerships", "Gamma"),
    t("Director, Growth", "Beta"), t("Head of Growth Marketing", "Delta"), t("VP Growth", "Acme"),
    // Already admitted: not part of the pool.
    t("Head of Operations", "Acme"),
    // Outside the geography: never counted.
    t("Operations Lead", "Acme", "San Francisco, CA"), t("Director of Partnerships", "Acme", "New York, NY"),
    // Excluded: never counted as a role type.
    t("Director of HR Partnerships", "Acme"),
    // A level word alone is never a role type.
    t("Senior Manager", "Beta"), t("Director, Manager Excellence", "Beta"), t("VP Management", "Beta"),
  ];
  const result = suggestFromScans(postings, gate);

  it("counts only location-passing roles the gate does not admit", () => {
    expect(result.unmatched).toBe(14);
  });
  it("proposes seniority labels that would admit keyword-matching roles, with counts and examples", () => {
    const lead = result.seniority.find((s) => s.term === "Lead");
    expect(lead).toMatchObject({ admits: 4, companies: 3 });
    expect(lead!.examples.map((e) => e.title)).toContain("Operations Lead");
    expect(result.seniority.map((s) => s.term)).not.toContain("Director");
  });
  it("proposes role types the include list misses, as a wildcard when inflections vary", () => {
    const terms = result.roleTypes.map((s) => s.term);
    expect(terms).toContain("partnership*");
    expect(terms).toContain("growth");
    expect(result.roleTypes.find((s) => s.term === "partnership*")!.admits).toBe(3);
  });
  it("never proposes level words, excluded words, or terms an existing wildcard already covers", () => {
    const terms = result.roleTypes.map((s) => s.term);
    for (const bad of ["manager", "management", "manage*", "engineering", "director", "senior"]) expect(terms).not.toContain(bad);
    const widened = suggestFromScans(postings, { ...gate, includeKeywords: [...gate.includeKeywords, "partner*"] });
    expect(widened.roleTypes.map((s) => s.term)).not.toContain("partnership*");
  });
  it("returns nothing when there is nothing to mine", () => {
    expect(suggestFromScans([], gate)).toEqual({ unmatched: 0, seniority: [], roleTypes: [] });
  });
});
