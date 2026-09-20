import { ats, discovery, type SourceSpec, type SourceType } from "@christopher/core";
import { PoliteFetcher, userAgentFor } from "./fetcher";
import type { BrowserRenderer } from "./browser";

export interface LiveAcceptanceCase {
  id: string;
  company: string;
  homepageUrl: string;
  expectedSource: { type: SourceType; url: string; equivalentUrls?: string[] };
  /** Null means no independent human count exists. It must never be treated as a passing label. */
  expectedRoleCount: number | null;
  labelStatus: "source_independently_checked" | "unverified";
  labelNote: string;
  /** First-party pages used by a reviewer to establish the source label. */
  sourceEvidenceUrls?: string[];
  sourceCheckedAt?: string;
}

export interface LiveAcceptanceResult {
  id: string;
  company: string;
  startedAt: string;
  durationMs: number;
  discovery: {
    outcome: "resolved" | "needs_confirmation" | "not_found" | "error";
    observedType?: SourceType;
    observedUrl?: string;
    confidence?: number;
    fetches?: number;
    sourceMatchesLabel: boolean | null;
    error?: string;
    errorCode?: "discovery_error";
    browserAttempts: number;
    browserRenders: number;
    browserUrls: string[];
    browserFailures: Array<{ url: string; code: "robots_denied" | "browser_error"; error: string }>;
  };
  extraction: {
    outcome: "complete" | "partial" | "failed" | "not_run";
    observedRoleCount?: number;
    countMatchesLabel: boolean | null;
    sample: Array<{ title: string; location?: string; url: string }>;
    error?: string;
    errorCode?: "source_blocked" | "source_incomplete" | "source_network" | "source_http" | "extraction_error";
  };
}

export interface LiveAcceptanceMetrics {
  total: number;
  sourceLabelled: number;
  sourceMatches: number;
  sourceMismatches: number;
  labelledAutomaticMatchesAt085: number;
  automaticResolvedAt085: number;
  wrongAutomaticAccepts: number;
  extractionComplete: number;
  extractionPartial: number;
  extractionFailed: number;
  countLabelled: number;
  countMatches: number;
  /** Null until the denominator has independently checked labels. */
  discoveryAccuracy: number | null;
  /** Exact agreement only. This is not posting-level recall or precision. */
  extractionExactCountAgreement: number | null;
  postingIdentityRecall: number | null;
  postingIdentityPrecision: number | null;
}

export type LiveAcceptanceVerdict = "pass" | "fail" | "blocked";

function normaliseSourceUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function sourceMatches(expected: LiveAcceptanceCase["expectedSource"], actual?: SourceSpec): boolean {
  if (!actual || actual.type !== expected.type) return false;
  const expectedSpec = ats.specFromAnyUrl(expected.url);
  if (expectedSpec?.atsSlug && actual.atsSlug) {
    return expectedSpec.atsSlug.toLowerCase() === actual.atsSlug.toLowerCase()
      && (expectedSpec.atsSite ?? "").toLowerCase() === (actual.atsSite ?? "").toLowerCase();
  }
  return [expected.url, ...(expected.equivalentUrls ?? [])]
    .some(url => normaliseSourceUrl(url) === normaliseSourceUrl(actual.url));
}

export function summariseLiveAcceptance(cases: LiveAcceptanceCase[], results: LiveAcceptanceResult[]): LiveAcceptanceMetrics {
  const byId = new Map(cases.map(item => [item.id, item]));
  const sourceLabelled = cases.filter(item => item.labelStatus === "source_independently_checked").length;
  let sourceMatchesCount = 0;
  let labelledAutomaticMatchesAt085 = 0;
  let wrongAutomaticAccepts = 0;
  const countLabelled = cases.filter(item => item.expectedRoleCount !== null).length;
  let countMatches = 0;
  for (const result of results) {
    const item = byId.get(result.id);
    if (!item) continue;
    if (item.labelStatus === "source_independently_checked") {
      if (result.discovery.sourceMatchesLabel === true) sourceMatchesCount++;
      if (result.discovery.outcome === "resolved" && (result.discovery.confidence ?? 0) >= 0.85 && result.discovery.sourceMatchesLabel === true) labelledAutomaticMatchesAt085++;
      if (result.discovery.outcome === "resolved" && (result.discovery.confidence ?? 0) >= 0.85 && result.discovery.sourceMatchesLabel === false) wrongAutomaticAccepts++;
    }
    if (item.expectedRoleCount !== null) {
      if (result.extraction.countMatchesLabel === true) countMatches++;
    }
  }
  return {
    total: results.length,
    sourceLabelled,
    sourceMatches: sourceMatchesCount,
    sourceMismatches: sourceLabelled - sourceMatchesCount,
    labelledAutomaticMatchesAt085,
    automaticResolvedAt085: results.filter(r => r.discovery.outcome === "resolved" && (r.discovery.confidence ?? 0) >= 0.85).length,
    wrongAutomaticAccepts,
    extractionComplete: results.filter(r => r.extraction.outcome === "complete").length,
    extractionPartial: results.filter(r => r.extraction.outcome === "partial").length,
    extractionFailed: results.filter(r => r.extraction.outcome === "failed").length,
    countLabelled,
    countMatches,
    discoveryAccuracy: sourceLabelled ? labelledAutomaticMatchesAt085 / sourceLabelled : null,
    extractionExactCountAgreement: countLabelled ? countMatches / countLabelled : null,
    postingIdentityRecall: null,
    postingIdentityPrecision: null,
  };
}

export function liveAcceptanceVerdict(cases: LiveAcceptanceCase[], metrics: LiveAcceptanceMetrics): { verdict: LiveAcceptanceVerdict; reasons: string[] } {
  const reasons: string[] = [];
  if (metrics.wrongAutomaticAccepts > 0) reasons.push(`${metrics.wrongAutomaticAccepts} labelled wrong source(s) automatically accepted at or above 0.85`);
  if (metrics.discoveryAccuracy !== null && metrics.discoveryAccuracy < 0.8) reasons.push(`labelled automatic discovery agreement is ${(metrics.discoveryAccuracy * 100).toFixed(1)}%, below 80%`);
  if (metrics.sourceLabelled < cases.length) reasons.push(`${cases.length - metrics.sourceLabelled} source label(s) remain independently unverified`);
  if (metrics.countLabelled < cases.length) reasons.push(`${cases.length - metrics.countLabelled} case(s) lack an independent posting-identity golden snapshot`);
  if (metrics.countMatches < metrics.countLabelled) reasons.push(`${metrics.countLabelled - metrics.countMatches} labelled extraction count(s) disagree`);
  if (metrics.postingIdentityRecall === null || metrics.postingIdentityPrecision === null) reasons.push("posting-identity recall and precision have not been measured");
  if (metrics.total < cases.length) reasons.push(`${cases.length - metrics.total} selected case(s) have no result`);
  if (metrics.extractionComplete + metrics.extractionPartial + metrics.extractionFailed < metrics.total) reasons.push("one or more selected cases did not run extraction");
  if (metrics.extractionFailed > 0 || metrics.extractionPartial > 0) reasons.push(`${metrics.extractionFailed} extraction failure(s) and ${metrics.extractionPartial} partial extraction(s)`);
  if (metrics.wrongAutomaticAccepts > 0 || (metrics.discoveryAccuracy !== null && metrics.discoveryAccuracy < 0.8) || metrics.countMatches < metrics.countLabelled) return { verdict: "fail", reasons };
  if (reasons.length) return { verdict: "blocked", reasons };
  return { verdict: "pass", reasons: [] };
}

function extractionErrorCode(error: unknown): NonNullable<LiveAcceptanceResult["extraction"]["errorCode"]> {
  if (error instanceof Error && error.name === "IncompleteListingError") return "source_incomplete";
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP (403|429)|blocked|denied/i.test(message)) return "source_blocked";
  if (/HTTP \d{3}/i.test(message)) return "source_http";
  if (/network|timeout|fetch failed|browser rendering unavailable/i.test(message)) return "source_network";
  return "extraction_error";
}

export async function runLiveAcceptanceCase(item: LiveAcceptanceCase, options: { discoveryOnly?: boolean; maxFetches?: number; fetcher?: PoliteFetcher; browser?: BrowserRenderer } = {}): Promise<LiveAcceptanceResult> {
  const started = Date.now();
  const fetcher = options.fetcher ?? new PoliteFetcher({
    userAgent: userAgentFor(process.env.CONTACT_EMAIL ?? "christopher-live-acceptance@example.invalid"),
    respectRobots: () => true,
  });
  let browserRenders = 0;
  let browserAttempts = 0;
  const browserUrls: string[] = [];
  const browserFailures: LiveAcceptanceResult["discovery"]["browserFailures"] = [];
  const fetchContext = {
    fetchText: (url: string, init?: Parameters<typeof fetcher.fetchText>[1]) => fetcher.fetchText(url, init),
    fetchBytes: (url: string, init?: Parameters<typeof fetcher.fetchBytes>[1]) => fetcher.fetchBytes(url, init),
    render: options.browser ? async (url: string, opts?: { scrollAndExpand?: boolean }) => {
      browserAttempts++;
      browserUrls.push(url);
      try {
        const rendered = await options.browser!.render(url, opts);
        browserRenders++;
        return rendered;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        browserFailures.push({ url, code: /robots\.txt disallows/i.test(message) ? "robots_denied" : "browser_error", error: message });
        throw error;
      }
    } : undefined,
    now: () => new Date(),
  };
  const discoveryContext = {
    ...fetchContext,
    resolveSpec: ats.specFromAnyUrl,
    findSpecsInText: ats.findAtsSpecsInText,
    verifySpec: (spec: SourceSpec) => ats.getAdapter(spec.type).verify(spec, fetchContext),
    extractFromHtml: ats.extractPostingsFromHtml,
    maxFetches: options.maxFetches ?? 16,
    maxDurationMs: 45_000,
  };
  const result: LiveAcceptanceResult = {
    id: item.id,
    company: item.company,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    discovery: { outcome: "error", sourceMatchesLabel: null, browserAttempts: 0, browserRenders: 0, browserUrls: [], browserFailures: [] },
    extraction: { outcome: options.discoveryOnly ? "not_run" : "failed", countMatchesLabel: null, sample: [] },
  };
  try {
    const observed = await discovery.discoverCareersSources(item.homepageUrl, discoveryContext);
    result.discovery = {
      outcome: observed.outcome,
      observedType: observed.best?.spec.type,
      observedUrl: observed.best?.spec.url,
      confidence: observed.best?.confidence,
      fetches: observed.fetches,
      sourceMatchesLabel: item.labelStatus === "source_independently_checked" ? sourceMatches(item.expectedSource, observed.best?.spec) : null,
      browserAttempts,
      browserRenders,
      browserUrls,
      browserFailures,
    };
  } catch (error) {
    result.discovery = { outcome: "error", sourceMatchesLabel: null, error: (error as Error).message, errorCode: "discovery_error", browserAttempts, browserRenders, browserUrls, browserFailures };
  }
  if (!options.discoveryOnly) {
    try {
      const spec = ats.specFromAnyUrl(item.expectedSource.url) ?? { type: item.expectedSource.type, url: item.expectedSource.url };
      const postings = await ats.getAdapter(spec.type).fetchPostings(spec, fetchContext);
      result.extraction = {
        outcome: "complete",
        observedRoleCount: postings.length,
        countMatchesLabel: item.expectedRoleCount === null ? null : postings.length === item.expectedRoleCount,
        sample: postings.slice(0, 3).map(({ title, location, url }) => ({ title, location, url })),
      };
    } catch (error) {
      const partial = error instanceof Error && error.name === "IncompleteListingError";
      const postings = partial && "postings" in (error as object) ? (error as Error & { postings: Array<{ title: string; location?: string; url: string }> }).postings : [];
      result.extraction = {
        outcome: partial ? "partial" : "failed",
        observedRoleCount: partial ? postings.length : undefined,
        countMatchesLabel: null,
        sample: postings.slice(0, 3).map(({ title, location, url }) => ({ title, location, url })),
        error: (error as Error).message,
        errorCode: extractionErrorCode(error),
      };
    }
  }
  result.durationMs = Date.now() - started;
  return result;
}
