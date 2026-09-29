import { describe, expect, it } from "vitest";
import { liveAcceptanceVerdict, resolveLiveAcceptanceConcurrency, runLiveAcceptanceCase, sourceMatches, summariseLiveAcceptance, type LiveAcceptanceCase, type LiveAcceptanceResult } from "./live-acceptance";
import { compareReferencePostings, type ReferencePostingSnapshot } from "./live-acceptance-postings";
import { createLiveAcceptanceAiBudget } from "./live-acceptance-ai";

const labelled: LiveAcceptanceCase = { id: "a", company: "A", homepageUrl: "https://a.test", expectedSource: { type: "greenhouse", url: "https://boards.greenhouse.io/acme" }, expectedRoleCount: null, labelStatus: "source_independently_checked", labelNote: "checked" };
const unverified: LiveAcceptanceCase = { ...labelled, id: "b", labelStatus: "unverified" };

function result(id: string, matches: boolean): LiveAcceptanceResult {
  return { id, company: id, startedAt: new Date(0).toISOString(), durationMs: 1, discovery: { outcome: "resolved", confidence: 0.9, sourceMatchesLabel: matches, browserAttempts: 0, browserRenders: 0, browserUrls: [], browserFailures: [] }, extraction: { outcome: "complete", countMatchesLabel: null, sample: [] } };
}

describe("live acceptance reporting", () => {
  it("admits AI calls against a conservative run cap and reports actual usage", async () => {
    const budget = createLiveAcceptanceAiBudget("claude-sonnet-5", 1);
    const release = await budget.reserve("A1", 0.02);
    expect(release).toBeTypeOf("function");
    budget.onUsage({ callSite: "A1", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.003, durationMs: 10, ok: true });
    expect(budget.snapshot()).toMatchObject({ capUsd: 1, spentUsd: 0.003, heldUsd: 0.3, conservativeFactor: 15, refusedReservations: 0, uncertainHeldUsd: 0 });
    await release!();
    expect(budget.snapshot().heldUsd).toBe(0);
    expect(await budget.reserve("A2", 0.07)).toBeNull();
    expect(budget.snapshot().refusedReservations).toBe(1);
  });

  it("retains the conservative hold when a failed provider call has no usage snapshot", async () => {
    const budget = createLiveAcceptanceAiBudget("claude-sonnet-5", 1);
    const release = await budget.reserve("A1", 0.02);
    budget.onUsage({ callSite: "A1", model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 10, ok: false, error: "connection ended" });
    await release!();
    expect(budget.snapshot()).toMatchObject({ spentUsd: 0, heldUsd: 0.3, uncertainHeldUsd: 0.3 });
    expect(await budget.reserve("A2", 0.05)).toBeNull();
  });

  it("defaults browser and AI runs to the serial production shape but preserves explicit stress concurrency", () => {
    expect(resolveLiveAcceptanceConcurrency(undefined, true, false)).toEqual({ value: 1, source: "production_serial_default" });
    expect(resolveLiveAcceptanceConcurrency(undefined, false, true)).toEqual({ value: 1, source: "production_serial_default" });
    expect(resolveLiveAcceptanceConcurrency(undefined, false, false)).toEqual({ value: 3, source: "http_default" });
    expect(resolveLiveAcceptanceConcurrency("3", true, false)).toEqual({ value: 3, source: "explicit" });
    expect(() => resolveLiveAcceptanceConcurrency("4", false, false)).toThrow(/1, 2 or 3/);
  });

  it("rejects unpriced AI models rather than inventing a cost ceiling", () => {
    expect(() => createLiveAcceptanceAiBudget("unknown-model", 1)).toThrow(/No checked pricing/);
  });

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

  it("does not equate filtered or paginated HTML sources with the full listing", () => {
    const expected = { type: "html" as const, url: "https://a.test/jobs" };
    expect(sourceMatches(expected, { type: "html", url: "https://a.test/jobs?location=London" })).toBe(false);
    expect(sourceMatches(expected, { type: "html", url: "https://a.test/jobs?page=2" })).toBe(false);
    expect(sourceMatches(expected, { type: "html", url: "https://a.test/jobs/?utm_source=careers#roles" })).toBe(true);
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
    unresolved.discovery = { outcome: "not_found", sourceMatchesLabel: false, browserAttempts: 0, browserRenders: 0, browserUrls: [], browserFailures: [] };
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

  it("uses and reports the supplied production browser renderer", async () => {
    const fetcher = {
      fetchText: async () => { throw new Error("HTTP 403"); },
      fetchBytes: async () => { throw new Error("unused"); },
    };
    const browser = {
      render: async (url: string) => ({ html: '<html><head><title>A</title></head><body><a href="/careers">Careers</a></body></html>', finalUrl: url, requests: [], status: 200, listingPages: [], incomplete: false }),
    };
    const observed = await runLiveAcceptanceCase({ ...labelled, expectedSource: { type: "html", url: "https://a.test/careers" } }, { discoveryOnly: true, maxFetches: 2, fetcher: fetcher as never, browser: browser as never });
    expect(observed.discovery.browserRenders).toBe(1);
    expect(observed.discovery.browserAttempts).toBe(1);
    expect(observed.discovery.browserUrls).toEqual(["https://a.test/"]);
  });
});


describe("independent posting references", () => {
  const now = new Date("2026-09-29T13:00:00Z");
  const snapshot: ReferencePostingSnapshot = {
    caseId: "a", sourceUrl: "https://a.test/jobs", evidenceUrl: "https://a.test/careers",
    capturedAt: "2026-09-29T12:00:00Z", rawSha256: "a".repeat(64), rawPath: "fixture.raw.json", enumerationMethod: "Independent reviewer enumerated the unfiltered snapshot",
    reviewStatus: "human_reviewed", completeScope: true, postingUrls: ["https://a.test/jobs/one", "https://a.test/jobs/two"],
  };
  it("does not promote machine-enumerated references into qualification metrics", () => {
    const r = result("a", true);
    r.extraction.referenceComparison = compareReferencePostings({ ...snapshot, reviewStatus: "machine_enumerated" }, snapshot.postingUrls.map(url => ({ title: "Engineer", url })), { observation: "complete", now, sourceMatchesLabel: true, rawHashVerified: true });
    expect(r.extraction.referenceComparison.recall).toBe(1);
    const metrics = summariseLiveAcceptance([labelled], [r]);
    expect(metrics.postingIdentityLabelled).toBe(0);
    expect(metrics.postingIdentityRecall).toBeNull();
    expect(liveAcceptanceVerdict([labelled], metrics).verdict).toBe("blocked");
  });
  it("rejects an equal-count extraction with the wrong posting identities", () => {
    const r = result("a", true);
    r.extraction.referenceComparison = compareReferencePostings(snapshot, [{ title: "One", url: snapshot.postingUrls[0]! }, { title: "Wrong", url: "https://a.test/jobs/wrong" }], { observation: "complete", now, sourceMatchesLabel: true, rawHashVerified: true });
    const metrics = summariseLiveAcceptance([labelled], [r]);
    expect(metrics.countMatches).toBe(1);
    expect(metrics.postingIdentityRecall).toBe(0.5);
    expect(metrics.postingIdentityPrecision).toBe(0.5);
    expect(liveAcceptanceVerdict([labelled], metrics).verdict).toBe("fail");
  });
  it("accepts the fully qualified matching corpus without a redundant manual count", () => {
    const r = result("a", true);
    r.extraction.referenceComparison = compareReferencePostings(snapshot, snapshot.postingUrls.map(url => ({ title: "Engineer", url })), { observation: "complete", now, sourceMatchesLabel: true, rawHashVerified: true });
    expect(liveAcceptanceVerdict([labelled], summariseLiveAcceptance([labelled], [r]))).toEqual({ verdict: "pass", reasons: [] });
    expect(liveAcceptanceVerdict([labelled], summariseLiveAcceptance([labelled], [r]), ["a", "b"]).verdict).toBe("blocked");
  });
  it("does not mix extraction browser work into discovery evidence", async () => {
    const fetcher = {
      fetchText: async (url: string) => ({ url, body: '<html><main><div id="app"></div></main></html>', status: 200, headers: {} }),
      fetchBytes: async () => { throw new Error("unused"); },
    };
    const browser = { render: async (url: string) => ({ html: '<main><section class="jobs">There are currently no positions.</section></main>', finalUrl: url, requests: [], status: 200, listingPages: [], incomplete: false }) };
    const r = await runLiveAcceptanceCase({ ...labelled, expectedSource: { type: "html", url: "https://a.test/jobs" } }, { maxFetches: 1, fetcher: fetcher as never, browser: browser as never });
    expect(r.extraction).toMatchObject({ basis: "labelled_source_diagnostic", outcome: "complete", browserAttempts: 1, browserRenders: 1, browserUrls: ["https://a.test/jobs"] });
    expect(r.discovery.browserUrls).toHaveLength(r.discovery.browserAttempts);
    expect(r.discovery.browserUrls).not.toContain("https://a.test/jobs");
  });
});
