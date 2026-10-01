import { describe, expect, it } from "vitest";
import { LIVE_ACCEPTANCE_CASES } from "./live-acceptance-manifest";
import { assessLiveAcceptanceCorpus } from "./live-acceptance-corpus";
import { fullyCoveredCorpus } from "./live-acceptance-corpus.fixtures";

const now = new Date("2026-10-01T12:00:00Z");

describe("SPEC §9 golden-set composition", () => {
  it("reports the curated manifest's raw HTML count separately from evidenced custom HTML", () => {
    const report = assessLiveAcceptanceCorpus(LIVE_ACCEPTANCE_CASES, now);
    expect(report).toMatchObject({ qualifies: false, counts: { selectedCases: 31, distinctCompanies: 31,
      primaryHtml: 14, customHtml: 5, jsHeavy: 2, multiRegionWorkday: 2,
      landingToExternalBoard: 1, botProtected: 0 },
      atsTypes: ["ashby", "bamboohr", "eightfold", "greenhouse", "lever", "teamtailor", "workable", "workday"] });
    expect(report.missingReasons).toHaveLength(1);
    expect(report.missingReasons[0]).toMatch(/bot-protected/);
  });

  it("qualifies a complete, independently evidenced synthetic structure without asserting posting quality", () => {
    const report = assessLiveAcceptanceCorpus(fullyCoveredCorpus(), now);
    expect(report).toMatchObject({ qualifies: true, counts: { selectedCases: 25, distinctCompanies: 25,
      primaryHtml: 16, customHtml: 5, jsHeavy: 2, multiRegionWorkday: 2,
      landingToExternalBoard: 1, botProtected: 1 } });
    expect(report.atsTypes).toHaveLength(8);
    expect(report.criterionScope).toMatch(/posting accuracy.*separate evidence/);
  });

  it("does not invent a hard 25-company minimum for SPEC's roughly-25 guidance", () => {
    const report = assessLiveAcceptanceCorpus(fullyCoveredCorpus().slice(0, 15), now);
    expect(report).toMatchObject({ qualifies: true, counts: { selectedCases: 15, distinctCompanies: 15 } });
  });

  it("does not count an alternate ATS type or an unverified source as a primary ATS family", () => {
    const cases = fullyCoveredCorpus();
    cases[0] = { ...cases[0]!, expectedSource: { ...cases[0]!.expectedSource,
      type: "html", equivalentSources: [{ type: "greenhouse", url: "https://company0.example/jobs" }] } };
    const report = assessLiveAcceptanceCorpus(cases, now);
    expect(report.atsTypes).toHaveLength(7);
    expect(report.qualifies).toBe(false);
    const unverified = fullyCoveredCorpus();
    unverified[0] = { ...unverified[0]!, labelStatus: "unverified" };
    expect(assessLiveAcceptanceCorpus(unverified, now).atsTypes).toHaveLength(7);
  });

  it("requires real, non-future, cited special-stratum evidence on the right primary type", () => {
    const cases = fullyCoveredCorpus();
    cases[9] = { ...cases[9]!, coverage: { ...cases[9]!.coverage,
      customHtml: { evidenceUrl: "https://other.example/jobs", checkedAt: "2026-10-32", note: "Substantive but invalid cited date." } } };
    cases[7] = { ...cases[7]!, expectedSource: { ...cases[7]!.expectedSource, type: "html" } };
    cases[10] = { ...cases[10]!, coverage: { ...cases[10]!.coverage,
      jsHeavy: { evidenceUrl: cases[10]!.expectedSource.url, checkedAt: "2026-10-02", note: "Future evidence cannot establish today's review." } } };
    const report = assessLiveAcceptanceCorpus(cases, now);
    expect(report.counts).toMatchObject({ customHtml: 4, jsHeavy: 1, multiRegionWorkday: 1 });
    expect(report.invalidEvidence).toEqual(expect.arrayContaining([
      expect.stringContaining("company9: customHtml"),
      expect.stringContaining("company7: multiRegionWorkday"),
      expect.stringContaining("company10: jsHeavy"),
    ]));
    expect(report.qualifies).toBe(false);
  });

  it("blocks duplicate company names and normalised homepage hosts without inflating counts", () => {
    const cases = fullyCoveredCorpus();
    cases[24] = { ...cases[24]!, company: "  COMPANY   0  ", homepageUrl: "https://www.company0.example/" };
    const report = assessLiveAcceptanceCorpus(cases, now);
    expect(report.counts.distinctCompanies).toBe(24);
    expect(report.invalidEvidence).toEqual(expect.arrayContaining([
      "company24: duplicate company name", "company24: duplicate company homepage host",
    ]));
    expect(report.qualifies).toBe(false);
  });

  it("ignores unknown runtime source types and invalid source-label evidence", () => {
    const cases = fullyCoveredCorpus();
    cases[0] = { ...cases[0]!, expectedSource: { type: "unexpected" as never, url: cases[0]!.expectedSource.url } };
    cases[1] = { ...cases[1]!, sourceCheckedAt: "2026-02-30" };
    const report = assessLiveAcceptanceCorpus(cases, now);
    expect(report.atsTypes).toHaveLength(6);
    expect(report.invalidEvidence.join(" ")).toMatch(/company1: independently checked source/);
    expect(report.qualifies).toBe(false);
  });
});
