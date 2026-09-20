import { describe, expect, it } from "vitest";
import { liveAcceptanceVerdict, sourceMatches, summariseLiveAcceptance, type LiveAcceptanceCase, type LiveAcceptanceResult } from "./live-acceptance";

const labelled: LiveAcceptanceCase = { id: "a", company: "A", homepageUrl: "https://a.test", expectedSource: { type: "greenhouse", url: "https://boards.greenhouse.io/acme" }, expectedRoleCount: null, labelStatus: "source_independently_checked", labelNote: "checked" };
const unverified: LiveAcceptanceCase = { ...labelled, id: "b", labelStatus: "unverified" };

function result(id: string, matches: boolean): LiveAcceptanceResult {
  return { id, company: id, startedAt: new Date(0).toISOString(), durationMs: 1, discovery: { outcome: "resolved", confidence: 0.9, sourceMatchesLabel: matches }, extraction: { outcome: "complete", countMatchesLabel: null, sample: [] } };
}

describe("live acceptance reporting", () => {
  it("matches ATS identity rather than cosmetic board URL variants", () => {
    expect(sourceMatches(labelled.expectedSource, { type: "greenhouse", url: "https://job-boards.greenhouse.io/acme/", atsSlug: "acme" })).toBe(true);
  });

  it("matches only explicitly reviewed equivalent listing URLs", () => {
    expect(sourceMatches(
      { type: "html", url: "https://www.mozilla.org/en-US/careers/listings/", equivalentUrls: ["https://www.mozilla.org/en-GB/careers/listings/"] },
      { type: "html", url: "https://www.mozilla.org/en-GB/careers/listings/" },
    )).toBe(true);
    expect(sourceMatches(
      { type: "html", url: "https://www.mozilla.org/en-US/careers/listings/" },
      { type: "html", url: "https://www.mozilla.org/en-GB/careers/listings/" },
    )).toBe(false);
    expect(sourceMatches(
      { type: "html", url: "https://www.mozilla.org/en-US/careers/listings/", equivalentUrls: ["https://www.mozilla.org/en-GB/careers/listings/"] },
      { type: "html", url: "https://www.mozilla.org/en-GB/careers/" },
    )).toBe(false);
  });

  it("excludes unverified labels and missing manual counts from accuracy denominators", () => {
    const metrics = summariseLiveAcceptance([labelled, unverified], [result("a", false), result("b", true)]);
    expect(metrics.sourceLabelled).toBe(1);
    expect(metrics.sourceMismatches).toBe(1);
    expect(metrics.wrongAutomaticAccepts).toBe(1);
    expect(metrics.countLabelled).toBe(0);
    expect(metrics.extractionExactCountAgreement).toBeNull();
    expect(liveAcceptanceVerdict([labelled, unverified], metrics)).toMatchObject({ verdict: "fail" });
  });

  it("reports absent independent labels as blocked rather than passed", () => {
    const metrics = summariseLiveAcceptance([unverified], [result("b", true)]);
    expect(liveAcceptanceVerdict([unverified], metrics)).toMatchObject({ verdict: "blocked" });
  });

  it("fails labelled cases that are all unresolved", () => {
    const unresolved = result("a", false);
    unresolved.discovery = { outcome: "not_found", sourceMatchesLabel: false };
    const metrics = summariseLiveAcceptance([labelled], [unresolved]);
    expect(metrics.discoveryAccuracy).toBe(0);
    expect(liveAcceptanceVerdict([labelled], metrics).verdict).toBe("fail");
  });

  it("fails unequal independently labelled counts", () => {
    const counted = { ...labelled, expectedRoleCount: 2 };
    const observed = result("a", true);
    observed.extraction = { outcome: "complete", observedRoleCount: 1, countMatchesLabel: false, sample: [] };
    const metrics = summariseLiveAcceptance([counted], [observed]);
    expect(liveAcceptanceVerdict([counted], metrics).verdict).toBe("fail");
  });

  it("blocks discovery-only and detects missing selected results", () => {
    const discoveryOnly = result("a", true);
    discoveryOnly.extraction.outcome = "not_run";
    const metrics = summariseLiveAcceptance([labelled, { ...labelled, id: "c" }], [discoveryOnly]);
    const acceptance = liveAcceptanceVerdict([labelled, { ...labelled, id: "c" }], metrics);
    expect(metrics.sourceLabelled).toBe(2);
    expect(metrics.discoveryAccuracy).toBe(0.5);
    expect(acceptance.reasons.join(" ")).toMatch(/no result|did not run extraction/);
    expect(acceptance.verdict).toBe("fail");
  });
});
