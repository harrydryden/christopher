import { describe, expect, it } from "vitest";
import { careerMatchTerms, rankCatalogueRoles, type CareerRecommendationProfile, type CatalogueRoleCandidate } from "./catalogue-recommendations";
import type { GateSettings } from "./gate";

const now = new Date("2026-11-11T12:00:00Z");
const profile: CareerRecommendationProfile = { version: 7, hash: "career7", roles: ["Head of Operations"], skills: ["Lean Six Sigma", "Financial Modelling"], industries: ["Software"], terms: [] };
const gate: GateSettings = { includeKeywords: [], excludeKeywords: [], matchFields: ["title"], locationTerms: ["UK"], includeRemote: true };
const candidate = (id: string, patch: Partial<CatalogueRoleCandidate> = {}): CatalogueRoleCandidate => ({ id, companyId: "company", companyName: "Acme", domain: "acme.test", homepageUrl: "https://acme.test", url: "https://acme.test/jobs/1", title: "Operations Lead", description: "Lean Six Sigma", companyText: "Software", location: "London", lastSeenAt: now, status: "open", shared: true, manualOwnerId: null, following: false, ...patch });

describe("private organic catalogue ranking", () => {
  it("finds actual roles without a follow, records reproducible provenance and favours named skills", () => {
    const matches = rankCatalogueRoles(profile, [candidate("title", { description: "" }), candidate("skills", { description: "Lean Six Sigma and Financial Modelling" })], gate, now);
    expect(matches.map(item => item.role.id)).toEqual(["skills", "title"]);
    expect(matches[0]!.match).toMatchObject({ kind: "organic", algorithm: "career-catalogue-v1", profileVersion: 7, profileHash: "career7" });
    expect(matches[0]!.match.reasons).toContainEqual({ kind: "skill", label: "Lean Six Sigma" });
  });
  it("honours location, title, seniority and exclusions above Experience overlap", () => {
    const restricted = { ...gate, includeKeywords: ["operations"], excludeKeywords: ["intern"], seniorityKeywords: ["lead"] };
    expect(rankCatalogueRoles(profile, [candidate("eligible"), candidate("abroad", { location: "New York", remote: true }), candidate("excluded", { title: "Operations Lead Intern" }), candidate("level", { title: "Operations Assistant" }), candidate("title", { title: "Finance Lead" })], restricted, now).map(item => item.role.id)).toEqual(["eligible"]);
  });
  it("excludes stale, closed and private roles even if a caller supplies them", () => {
    expect(rankCatalogueRoles(profile, [candidate("old", { lastSeenAt: new Date("2026-09-01") }), candidate("closed", { status: "closed" }), candidate("private", { shared: false }), candidate("manual", { manualOwnerId: "owner" }), candidate("valid")], gate, now).map(item => item.role.id)).toEqual(["valid"]);
  });
  it("does not claim an industry or generic seniority match establishes role relevance", () => {
    expect(rankCatalogueRoles(profile, [candidate("irrelevant", { title: "Head of Legal", description: "" })], gate, now)).toEqual([]);
    expect(careerMatchTerms({ ...profile, roles: ["Chief Director"], skills: [] })).toEqual([{ label: "Software", kind: "industry" }]);
  });
  it("does not substring-match skills and keeps missing location unresolved under a geographic filter", () => {
    const skillOnly = { ...profile, roles: [], skills: ["SQL"] };
    expect(rankCatalogueRoles(skillOnly, [candidate("substring", { description: "NoSQL" }), candidate("unknown", { description: "SQL", location: null, locationResolution: "pending" }), candidate("valid", { description: "SQL" })], gate, now).map(item => item.role.id)).toEqual(["valid"]);
  });
  it("deduplicates retrieval vocabulary and gives stable tie order independent of candidate order", () => {
    const duplicateProfile = { ...profile, skills: ["Lean Six Sigma", "lean six sigma", "Financial Modelling"] };
    expect(careerMatchTerms(duplicateProfile).filter(term => term.label.toLowerCase() === "lean six sigma")).toHaveLength(1);
    expect(rankCatalogueRoles(profile, [candidate("b"), candidate("a"), candidate("a")], gate, now).map(item => item.role.id)).toEqual(["a", "b"]);
  });
  it("does not use optional promotion fields to change organic ranking", () => {
    const ordinary = candidate("a");
    const promoted = { ...candidate("b"), bid: 100000, campaign: "paid" };
    expect(rankCatalogueRoles(profile, [promoted, ordinary], gate, now).map(item => item.role.id)).toEqual(["a", "b"]);
  });
});
