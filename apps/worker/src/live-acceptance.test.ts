import { describe, expect, it } from "vitest";
import { liveAcceptanceVerdict, resolveLiveAcceptanceConcurrency, resolveLiveAcceptanceDiscoveryBudget, runLiveAcceptanceCase, sourceMatches, summariseLiveAcceptance, type LiveAcceptanceCase, type LiveAcceptanceResult } from "./live-acceptance";
import { LIVE_ACCEPTANCE_CASES } from "./live-acceptance-manifest";
import { discovery } from "@col/core";
import { compareReferencePostings, type ReferencePostingSnapshot } from "./live-acceptance-postings";
import { createLiveAcceptanceAiBudget } from "./live-acceptance-ai";
import { fullyCoveredCorpus } from "./live-acceptance-corpus.fixtures";

const labelled: LiveAcceptanceCase = { id: "a", company: "A", homepageUrl: "https://a.test", expectedSource: { type: "greenhouse", url: "https://boards.greenhouse.io/acme" }, expectedRoleCount: null, labelStatus: "source_independently_checked", labelNote: "checked" };
const unverified: LiveAcceptanceCase = { ...labelled, id: "b", labelStatus: "unverified" };

function verdictFor(cases: LiveAcceptanceCase[], metrics: ReturnType<typeof summariseLiveAcceptance>, requiredCaseIds = cases.map(item => item.id)) {
  return liveAcceptanceVerdict(cases, metrics, requiredCaseIds);
}

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

  it("labels the legacy diagnostic crawl budget and offers the actual production defaults explicitly", () => {
    expect(resolveLiveAcceptanceDiscoveryBudget()).toEqual({ mode: "diagnostic", maxFetches: 16, maxDurationMs: 45_000 });
    expect(resolveLiveAcceptanceDiscoveryBudget("diagnostic")).toEqual(resolveLiveAcceptanceDiscoveryBudget());
    expect(resolveLiveAcceptanceDiscoveryBudget("production")).toEqual({ mode: "production",
      maxFetches: discovery.DEFAULT_DISCOVERY_MAX_FETCHES,
      maxDurationMs: discovery.DEFAULT_DISCOVERY_MAX_DURATION_MS });
    expect(() => resolveLiveAcceptanceDiscoveryBudget("unbounded")).toThrow(/diagnostic or production/);
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

  it("accepts only the reviewed Cloudflare full Greenhouse board as a typed alternative", () => {
    const expected = LIVE_ACCEPTANCE_CASES.find(item => item.id === "cloudflare")!.expectedSource;
    expect(sourceMatches(expected, { type: "html", url: "https://www.cloudflare.com/careers/jobs/" })).toBe(true);
    expect(sourceMatches(expected, { type: "greenhouse", url: "https://job-boards.greenhouse.io/cloudflare", atsSlug: "cloudflare" })).toBe(true);
    expect(sourceMatches(expected, { type: "greenhouse", url: "https://boards.greenhouse.io/cloudflare" })).toBe(true);
    expect(sourceMatches(expected, { type: "greenhouse", url: "https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs" })).toBe(true);
    expect(sourceMatches(expected, { type: "html", url: "https://job-boards.greenhouse.io/cloudflare" })).toBe(false);
    expect(sourceMatches(expected, { type: "greenhouse", url: "https://job-boards.greenhouse.io/other" })).toBe(false);
    expect(sourceMatches(expected, { type: "greenhouse", url: "https://boards.greenhouse.io/cloudflare/jobs/123" })).toBe(false);
    expect(sourceMatches(expected, { type: "greenhouse", url: "https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs?department=Sales" })).toBe(false);
    expect(sourceMatches(expected, { type: "greenhouse", url: "https://job-boards.greenhouse.io/cloudflare", atsSlug: "other" })).toBe(false);
  });

  it("accepts only the reviewed Zapier full Ashby board as a typed alternative", () => {
    const expected = LIVE_ACCEPTANCE_CASES.find(item => item.id === "zapier")!.expectedSource;
    expect(sourceMatches(expected, { type: "html", url: "https://zapier.com/jobs" })).toBe(true);
    expect(sourceMatches(expected, { type: "ashby", url: "https://jobs.ashbyhq.com/zapier", atsSlug: "zapier" })).toBe(true);
    expect(sourceMatches(expected, { type: "ashby", url: "https://api.ashbyhq.com/posting-api/job-board/zapier" })).toBe(true);
    expect(sourceMatches(expected, { type: "greenhouse", url: "https://jobs.ashbyhq.com/zapier" })).toBe(false);
    expect(sourceMatches(expected, { type: "ashby", url: "https://jobs.ashbyhq.com/another-company" })).toBe(false);
    expect(sourceMatches(expected, { type: "ashby", url: "https://jobs.ashbyhq.com/zapier/04838dc8-0efa-4fe5-b705-c99f6b3f17c6" })).toBe(false);
    expect(sourceMatches(expected, { type: "ashby", url: "https://api.ashbyhq.com/posting-api/job-board/zapier?location=Europe" })).toBe(false);
  });

  it("excludes unverified labels and missing manual counts from accuracy denominators", () => {
    const metrics = summariseLiveAcceptance([labelled, unverified], [result("a", false), result("b", true)]);
    expect(metrics.sourceLabelled).toBe(1);
    expect(metrics.sourceMismatches).toBe(1);
    expect(metrics.wrongAutomaticAccepts).toBe(1);
    expect(metrics.countLabelled).toBe(0);
    expect(metrics.extractionExactCountAgreement).toBeNull();
    expect(verdictFor([labelled, unverified], metrics)).toMatchObject({ verdict: "fail" });
  });

  it("reports absent independent labels as blocked rather than passed", () => {
    const metrics = summariseLiveAcceptance([unverified], [result("b", true)]);
    expect(verdictFor([unverified], metrics)).toMatchObject({ verdict: "blocked" });
  });

  it("fails labelled cases that are all unresolved", () => {
    const unresolved = result("a", false);
    unresolved.discovery = { outcome: "not_found", sourceMatchesLabel: false, browserAttempts: 0, browserRenders: 0, browserUrls: [], browserFailures: [] };
    const metrics = summariseLiveAcceptance([labelled], [unresolved]);
    expect(metrics.discoveryAccuracy).toBe(0);
    expect(verdictFor([labelled], metrics).verdict).toBe("fail");
  });

  it("fails unequal independently labelled counts", () => {
    const counted = { ...labelled, expectedRoleCount: 2 };
    const observed = result("a", true);
    observed.extraction = { outcome: "complete", observedRoleCount: 1, countMatchesLabel: false, sample: [] };
    const metrics = summariseLiveAcceptance([counted], [observed]);
    expect(verdictFor([counted], metrics).verdict).toBe("fail");
  });

  it("blocks discovery-only and detects missing selected results", () => {
    const discoveryOnly = result("a", true);
    discoveryOnly.extraction.outcome = "not_run";
    const metrics = summariseLiveAcceptance([labelled, { ...labelled, id: "c" }], [discoveryOnly]);
    const acceptance = verdictFor([labelled, { ...labelled, id: "c" }], metrics);
    expect(metrics.sourceLabelled).toBe(2);
    expect(metrics.discoveryAccuracy).toBe(0.5);
    expect(acceptance.reasons.join(" ")).toMatch(/no result|did not run extraction/);
    expect(acceptance.verdict).toBe("blocked");
  });

  it("rejects duplicate selected case IDs before scoring", () => {
    expect(() => summariseLiveAcceptance([labelled, { ...labelled }], [result("a", true)]))
      .toThrow(/Duplicate selected acceptance case: a/);
  });

  it("rejects duplicate results that previously let A qualify while B was absent", () => {
    const a = result("a", true);
    a.extraction.referenceComparison = {
      expectedCount: 1, observedCount: 1, matchedCount: 1,
      expectedDuplicateCount: 0, observedDuplicateCount: 0,
      expectedUrls: ["https://a.test/jobs/one"], observedUrls: ["https://a.test/jobs/one"],
      matchedUrls: ["https://a.test/jobs/one"], missingUrls: [], unexpectedUrls: [],
      recall: 1, precision: 1, qualifiesForAcceptance: true, qualificationReasons: [],
    };
    expect(() => summariseLiveAcceptance([labelled, { ...labelled, id: "b" }], [a, { ...a }]))
      .toThrow(/Duplicate acceptance result: a/);
  });

  it("rejects unknown qualified results instead of adding them to posting metrics", () => {
    const unknown = result("unknown", true);
    unknown.extraction.referenceComparison = {
      expectedCount: 1, observedCount: 1, matchedCount: 1,
      expectedDuplicateCount: 0, observedDuplicateCount: 0,
      expectedUrls: ["https://a.test/jobs/one"], observedUrls: ["https://a.test/jobs/one"],
      matchedUrls: ["https://a.test/jobs/one"], missingUrls: [], unexpectedUrls: [],
      recall: 1, precision: 1, qualifiesForAcceptance: true, qualificationReasons: [],
    };
    expect(() => summariseLiveAcceptance([labelled], [result("a", true), unknown]))
      .toThrow(/Unknown acceptance result: unknown/);
  });

  it("keeps missing results as blocked diagnostics and accepts reordered valid results", () => {
    const cases = [labelled, { ...labelled, id: "b" }];
    const a = result("a", true);
    const b = result("b", true);
    const missing = summariseLiveAcceptance(cases, [a]);
    expect(missing.total).toBe(1);
    expect(verdictFor(cases, missing)).toMatchObject({ verdict: "blocked" });
    expect(verdictFor(cases, missing).reasons.join(" ")).toMatch(/1 selected case.*no result/);
    expect(summariseLiveAcceptance(cases, [b, a])).toEqual(summariseLiveAcceptance(cases, [a, b]));
  });

  it("fails a known wrong automatic source even when another selected case is missing", () => {
    const cases = [labelled, { ...labelled, id: "b" }];
    const wrong = result("a", false);
    const metrics = summariseLiveAcceptance(cases, [wrong]);
    expect(verdictFor(cases, metrics)).toMatchObject({ verdict: "fail" });
    expect(verdictFor(cases, metrics).reasons.join(" ")).toMatch(/wrong source.*automatically accepted/);
  });

  it("fails an observed manual-count disagreement while another selected case is missing", () => {
    const cases = [{ ...labelled, expectedRoleCount: 2 }, { ...labelled, id: "b", expectedRoleCount: 2 }];
    const mismatched = result("a", true);
    mismatched.extraction = { outcome: "complete", observedRoleCount: 1, countMatchesLabel: false, sample: [] };
    const metrics = summariseLiveAcceptance(cases, [mismatched]);
    expect(metrics.countDisagreements).toBe(1);
    expect(verdictFor(cases, metrics)).toMatchObject({ verdict: "fail" });
    expect(verdictFor(cases, metrics).reasons.join(" ")).toMatch(/observed labelled extraction count.*disagree/);
    const matching = result("a", true);
    matching.extraction = { outcome: "complete", observedRoleCount: 2, countMatchesLabel: true, sample: [] };
    const incomplete = summariseLiveAcceptance(cases, [matching]);
    expect(incomplete.countDisagreements).toBe(0);
    expect(verdictFor(cases, incomplete)).toMatchObject({ verdict: "blocked" });
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

  it("preserves the chosen source's method, evidence and effective per-case crawl limits", async () => {
    const home = "https://www.acme.example/";
    const jobs = "https://www.acme.example/jobs";
    const fetcher = { fetchText: async (url: string) => ({ url, status: 200, headers: {},
      body: url === home
        ? '<html><head><title>Acme Robotics</title></head><body><a href="/jobs">Jobs</a></body></html>'
        : url === jobs
          ? '<main><h1>Current job openings</h1><div class="jobs"><p>Sorry, we don\'t have any job openings right now.</p></div></main>'
          : "not found" }),
    fetchBytes: async () => { throw new Error("unused"); } };
    const observed = await runLiveAcceptanceCase({ ...labelled, homepageUrl: home,
      expectedSource: { type: "html", url: jobs } },
    { discoveryOnly: true, maxFetches: 40, maxDurationMs: 120_000, fetcher: fetcher as never });
    expect(observed.discovery).toMatchObject({ outcome: "resolved", observedType: "html", observedUrl: jobs,
      method: "listing_empty", maxFetches: 40, maxDurationMs: 120_000 });
    expect(observed.discovery.evidence).toContain(`explicit no-openings state on ${jobs}`);
  });
});


describe("independent posting references", () => {
  const now = new Date("2026-09-29T13:00:00Z");
  const snapshot: ReferencePostingSnapshot = {
    caseId: "a", sourceUrl: "https://a.test/jobs", evidenceUrl: "https://a.test/careers",
    capturedAt: "2026-09-29T12:00:00Z", rawSha256: "a".repeat(64), rawPath: "fixture.raw.json", enumerationMethod: "Independent reviewer enumerated the unfiltered snapshot",
    reviewStatus: "human_reviewed", completeScope: true,
    reviewAttestation: { reviewer: "Fixture reviewer", reviewedAt: "2026-09-29T12:30:00Z",
      scopeEvidence: "Synthetic unit fixture: checked the complete unfiltered two-role listing.", fullScopeAttested: true },
    postingUrls: ["https://a.test/jobs/one", "https://a.test/jobs/two"],
  };
  it("does not promote machine-enumerated references into qualification metrics", () => {
    const r = result("a", true);
    r.extraction.referenceComparison = compareReferencePostings({ ...snapshot, reviewStatus: "machine_enumerated" }, snapshot.postingUrls.map(url => ({ title: "Engineer", url })), { observation: "complete", now, sourceMatchesLabel: true, rawHashVerified: true });
    expect(r.extraction.referenceComparison.recall).toBe(1);
    const metrics = summariseLiveAcceptance([labelled], [r]);
    expect(metrics.postingIdentityLabelled).toBe(0);
    expect(metrics.postingIdentityRecall).toBeNull();
    expect(verdictFor([labelled], metrics).verdict).toBe("blocked");
  });
  it("rejects an equal-count extraction with the wrong posting identities", () => {
    const r = result("a", true);
    r.extraction.referenceComparison = compareReferencePostings(snapshot, [{ title: "One", url: snapshot.postingUrls[0]! }, { title: "Wrong", url: "https://a.test/jobs/wrong" }], { observation: "complete", now, sourceMatchesLabel: true, rawHashVerified: true });
    const metrics = summariseLiveAcceptance([labelled], [r]);
    expect(metrics.countMatches).toBe(1);
    expect(metrics.postingIdentityRecall).toBe(0.5);
    expect(metrics.postingIdentityPrecision).toBe(0.5);
    expect(verdictFor([labelled], metrics).verdict).toBe("fail");
  });
  it("accepts a fully qualified synthetic corpus without a redundant manual count", () => {
    const cases = fullyCoveredCorpus();
    const results = cases.map(item => {
      const r = result(item.id, true);
      const url = `${item.expectedSource.url}/one`;
      r.extraction.referenceComparison = compareReferencePostings(
        { ...snapshot, caseId: item.id, sourceUrl: item.expectedSource.url, postingUrls: [url] },
        [{ title: "Engineer", url }], { observation: "complete", now, sourceMatchesLabel: true, rawHashVerified: true },
      );
      return r;
    });
    const metrics = summariseLiveAcceptance(cases, results);
    expect(verdictFor(cases, metrics)).toEqual({ verdict: "pass", reasons: [] });
    expect(verdictFor(cases, metrics, [...cases.map(item => item.id), "extra"]).verdict).toBe("blocked");
    const untypedCaller = liveAcceptanceVerdict as (cases: LiveAcceptanceCase[], metrics: ReturnType<typeof summariseLiveAcceptance>) => ReturnType<typeof liveAcceptanceVerdict>;
    expect(untypedCaller(cases, metrics)).toMatchObject({ verdict: "blocked",
      reasons: [expect.stringMatching(/required golden-set case IDs were not supplied/)] });
  });
  it("blocks a fully qualified posting comparison when its selected corpus lacks SPEC §9 breadth", () => {
    const r = result("a", true);
    r.extraction.referenceComparison = compareReferencePostings(snapshot,
      snapshot.postingUrls.map(url => ({ title: "Engineer", url })),
      { observation: "complete", now, sourceMatchesLabel: true, rawHashVerified: true });
    const metrics = summariseLiveAcceptance([labelled], [r]);
    expect(metrics.postingIdentityLabelled).toBe(1);
    const verdict = verdictFor([labelled], metrics);
    expect(verdict.verdict).toBe("blocked");
    expect(verdict.reasons.join(" ")).toMatch(/primary ATS types/);
  });
  it("keeps exact-count failure when an otherwise precise qualified reference has one extra role", () => {
    const urls = Array.from({ length: 100 }, (_, index) => `https://a.test/jobs/${index}`);
    const reference = { ...snapshot, postingUrls: urls };
    const observed = [...urls, "https://a.test/jobs/extra"].map(url => ({ title: "Engineer", url }));
    const r = result("a", true);
    r.extraction.referenceComparison = compareReferencePostings(reference, observed, {
      observation: "complete", now, sourceMatchesLabel: true, rawHashVerified: true,
    });
    const metrics = summariseLiveAcceptance([labelled, { ...labelled, id: "b" }], [r]);
    expect(metrics.postingIdentityFailures).toBe(0);
    expect(metrics.postingIdentityPrecision).toBeGreaterThan(0.98);
    expect(metrics.countDisagreements).toBe(1);
    expect(verdictFor([labelled, { ...labelled, id: "b" }], metrics)).toMatchObject({ verdict: "fail" });
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
