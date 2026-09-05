import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_SETTINGS, evaluateGate, evaluateLocation, compileTerm, parseTermList, type GateSettings } from "./gate";

const base: GateSettings = { ...DEFAULT_GATE_SETTINGS };

describe("compileTerm", () => {
  it("matches whole words only", () => {
    expect(compileTerm("ops")!.test("Ops Manager")).toBe(true);
    expect(compileTerm("ops")!.test("DevOps Engineer")).toBe(false);
    expect(compileTerm("ops")!.test("develops software")).toBe(false);
  });
  it("supports prefix wildcards", () => {
    expect(compileTerm("operat*")!.test("Operations Manager")).toBe(true);
    expect(compileTerm("operat*")!.test("Operational Lead")).toBe(true);
    expect(compileTerm("operat*")!.test("Cooperative")).toBe(false);
  });
  it("supports quoted phrases with flexible whitespace", () => {
    expect(compileTerm('"chief of staff"')!.test("Chief of  Staff to the CEO")).toBe(true);
    expect(compileTerm('"chief of staff"')!.test("Chief Staff Officer")).toBe(false);
  });
});

describe("keyword gate", () => {
  it("keeps a matching title and records the term", () => {
    const r = evaluateGate({ title: "Operations Manager" }, base);
    expect(r.keywordMatched).toBe(true);
    expect(r.keywordTerms).toEqual(["operations"]);
    expect(r.inTable).toBe(true);
  });
  it("drops a non-matching title", () => {
    expect(evaluateGate({ title: "Software Engineer" }, base).inTable).toBe(false);
  });
  it("applies exclusions over inclusions", () => {
    const settings = { ...base, excludeKeywords: ["intern"] };
    const r = evaluateGate({ title: "Operations Intern" }, settings);
    expect(r.keywordMatched).toBe(true);
    expect(r.excluded).toBe(true);
    expect(r.inTable).toBe(false);
  });
  it("matches the department when that field is enabled", () => {
    const settings = { ...base, matchFields: ["title", "department"] as GateSettings["matchFields"] };
    expect(evaluateGate({ title: "Programme Lead", department: "Operations" }, settings).inTable).toBe(true);
    expect(evaluateGate({ title: "Programme Lead", department: "Operations" }, base).inTable).toBe(false);
  });
  it("never excludes on the description alone", () => {
    const settings = { ...base, matchFields: ["title", "description"] as GateSettings["matchFields"], excludeKeywords: ["intern"] };
    const r = evaluateGate({ title: "Operations Manager", description: "You will mentor our intern cohort." }, settings);
    expect(r.excluded).toBe(false);
    expect(r.inTable).toBe(true);
  });
  it("treats an empty include list as matching everything", () => {
    expect(evaluateGate({ title: "Anything" }, { ...base, includeKeywords: [] }).keywordMatched).toBe(true);
  });
});

describe("location filter", () => {
  const uk: GateSettings = { ...base, locationTerms: ["UK"] };
  const london: GateSettings = { ...base, locationTerms: ["London"] };

  it("passes everything when no location terms are set", () => {
    expect(evaluateGate({ title: "Operations Manager", location: "Tokyo, Japan" }, base).locationOk).toBe(true);
  });
  it("expands a country term to its cities", () => {
    expect(evaluateGate({ title: "Operations Manager", location: "London, UK" }, uk).locationOk).toBe(true);
    expect(evaluateGate({ title: "Operations Manager", location: "Manchester" }, uk).locationOk).toBe(true);
    expect(evaluateGate({ title: "Operations Manager", location: "Edinburgh, Scotland" }, uk).locationOk).toBe(true);
    expect(evaluateGate({ title: "Operations Manager", location: "New York, NY" }, uk).locationOk).toBe(false);
  });
  it("does not expand a city term to its whole country", () => {
    expect(evaluateGate({ title: "Operations Manager", location: "London, UK" }, london).locationOk).toBe(true);
    expect(evaluateGate({ title: "Operations Manager", location: "Manchester, UK" }, london).locationOk).toBe(false);
  });
  it("passes a bare remote role but not one anchored to another region", () => {
    expect(evaluateGate({ title: "Operations Manager", location: "Remote" }, uk).locationOk).toBe(true);
    expect(evaluateGate({ title: "Operations Manager", location: "Remote - UK" }, uk).locationOk).toBe(true);
    expect(evaluateGate({ title: "Operations Manager", location: "Remote - USA" }, uk).locationOk).toBe(false);
  });
  it("honours includeRemote = false", () => {
    const strict = { ...uk, includeRemote: false };
    expect(evaluateGate({ title: "Operations Manager", location: "Remote" }, strict).locationOk).toBe(false);
  });
  it("passes when any of several locations matches", () => {
    const r = evaluateGate({ title: "Operations Manager", location: "New York, NY", locations: ["New York, NY", "London, UK"] }, uk);
    expect(r.locationOk).toBe(true);
  });
  it("treats Europe as a super-region covering the UK", () => {
    expect(evaluateLocation({ title: "x", location: "Remote - Europe" }, { locationTerms: ["UK"], includeRemote: true }).ok).toBe(true);
  });
  it("flags remote roles", () => {
    expect(evaluateGate({ title: "Operations Manager", location: "Remote - UK" }, base).remote).toBe(true);
    expect(evaluateGate({ title: "Operations Manager", location: "London, UK" }, base).remote).toBe(false);
  });
});

describe("parseTermList", () => {
  it("splits on commas and newlines and keeps quoted phrases", () => {
    expect(parseTermList('operations, "chief of staff"\nops; business operations')).toEqual([
      "operations",
      '"chief of staff"',
      "ops",
      "business operations",
    ]);
  });
  it("removes duplicates and blanks", () => {
    expect(parseTermList("ops,, ops\n\n")).toEqual(["ops"]);
  });
});
