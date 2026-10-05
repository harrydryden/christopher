import { ats, discovery, type DiscoveryAiHooks, type FetchInit, type SourceSpec, type SourceType } from "@col/core";
import { PoliteFetcher, userAgentFor } from "./fetcher";
import type { BrowserRenderer, RenderOptions } from "./browser";
import { observeHtmlListing } from "./live-acceptance-html";
import { compareReferencePostings, canonicalPostingIdentity, type ReferencePostingSnapshot, type PostingComparison } from "./live-acceptance-postings";
import { assessLiveAcceptanceCorpus, type CorpusCoverageEvidence } from "./live-acceptance-corpus";
import { guardedDiscoveryFetchContext } from "./discovery-host-guard";

export interface LiveAcceptanceCase {
  id: string;
  company: string;
  homepageUrl: string;
  expectedSource: { type: SourceType; url: string; equivalentUrls?: string[]; equivalentSources?: Array<{ type: SourceType; url: string }> };
  /** Null means no independent human count exists. It must never be treated as a passing label. */
  expectedRoleCount: number | null;
  labelStatus: "source_independently_checked" | "unverified";
  labelNote: string;
  /** First-party pages used by a reviewer to establish the source label. */
  sourceEvidenceUrls?: string[];
  sourceCheckedAt?: string;
  /** Independently checked evidence for SPEC §9's special golden-set strata. */
  coverage?: Partial<Record<"customHtml" | "jsHeavy" | "multiRegionWorkday" | "landingToExternalBoard" | "botProtected", CorpusCoverageEvidence>>;
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
    method?: string;
    evidence?: string[];
    confidence?: number;
    fetches?: number;
    verifications?: number;
    maxFetches?: number;
    maxDurationMs?: number;
    sourceMatchesLabel: boolean | null;
    error?: string;
    errorCode?: "discovery_error";
    browserAttempts: number;
    browserRenders: number;
    browserUrls: string[];
    browserFailures: Array<{ url: string; code: "robots_denied" | "browser_error"; error: string }>;
  };
  extraction: {
    /** This phase starts from the independently labelled source, not discovery output. */
    basis?: "labelled_source_diagnostic";
    referenceComparison?: PostingComparison;
    browserAttempts?: number;
    browserRenders?: number;
    browserUrls?: string[];
    outcome: "complete" | "partial" | "failed" | "not_run";
    /** Unique canonical posting URLs, distinct from raw adapter rows. */
    observedRoleCount?: number;
    rawObservedRoleCount?: number;
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
  /** Count disagreements proved by an observed result, excluding missing cases. */
  countDisagreements: number;
  /** Null until the denominator has independently checked labels. */
  discoveryAccuracy: number | null;
  /** Exact agreement only. This is not posting-level recall or precision. */
  extractionExactCountAgreement: number | null;
  postingIdentityLabelled: number;
  postingIdentityFailures: number;
  /** Qualified labels only; machine-enumerated API comparisons remain per-case diagnostics. */
  postingIdentityRecall: number | null;
  postingIdentityPrecision: number | null;
}

export type LiveAcceptanceVerdict = "pass" | "fail" | "blocked";

export const DIAGNOSTIC_DISCOVERY_MAX_FETCHES = 16;
export const DIAGNOSTIC_DISCOVERY_MAX_DURATION_MS = 45_000;

export function resolveLiveAcceptanceDiscoveryBudget(raw?: string): { mode: "diagnostic" | "production"; maxFetches: number; maxDurationMs: number } {
  if (raw === undefined || raw === "diagnostic") return {
    mode: "diagnostic", maxFetches: DIAGNOSTIC_DISCOVERY_MAX_FETCHES, maxDurationMs: DIAGNOSTIC_DISCOVERY_MAX_DURATION_MS,
  };
  if (raw === "production") return {
    mode: "production", maxFetches: discovery.DEFAULT_DISCOVERY_MAX_FETCHES,
    maxDurationMs: discovery.DEFAULT_DISCOVERY_MAX_DURATION_MS,
  };
  throw new Error("--discovery-budget must be diagnostic or production");
}

export function resolveLiveAcceptanceConcurrency(raw: string | undefined, browserEnabled: boolean, aiEnabled: boolean): { value: number; source: "explicit" | "production_serial_default" | "http_default" } {
  if (raw !== undefined) {
    const value = Number.parseInt(raw, 10);
    if (!/^[1-3]$/.test(raw) || !Number.isInteger(value)) throw new Error("--concurrency must be 1, 2 or 3");
    return { value, source: "explicit" };
  }
  return browserEnabled || aiEnabled
    ? { value: 1, source: "production_serial_default" }
    : { value: 3, source: "http_default" };
}

function normaliseSourceUrl(value: string): string {
  // A location/category/page query changes listing scope. Only known tracking fields may vanish.
  return canonicalPostingIdentity(value);
}

/** An explicitly labelled vendor alternative names one complete board, never a role or filter. */
function canonicalBoardUrls(type: SourceType, url: string): string[] {
  const spec = ats.specFromAnyUrl(url);
  if (!spec || spec.type !== type || !spec.atsSlug) return [];
  if (type === "greenhouse") {
    const canonical = new URL(spec.url);
    const legacy = new URL(canonical);
    legacy.hostname = canonical.hostname.replace(/^job-boards\./, "boards.");
    return [canonical.toString(), legacy.toString(), spec.apiUrl!].map(normaliseSourceUrl);
  }
  if (type === "ashby") {
    const api = new URL(spec.apiUrl!);
    api.search = "";
    return [spec.url, api.toString(), spec.apiUrl!].map(normaliseSourceUrl);
  }
  return [normaliseSourceUrl(spec.url)];
}

function matchesTypedAlternative(expected: { type: SourceType; url: string }, actual: SourceSpec): boolean {
  if (actual.type !== expected.type) return false;
  const labelled = ats.specFromAnyUrl(expected.url);
  const observed = ats.specFromAnyUrl(actual.url);
  if (!labelled || !observed || labelled.type !== expected.type || observed.type !== expected.type) {
    return normaliseSourceUrl(expected.url) === normaliseSourceUrl(actual.url);
  }
  if ((labelled.atsSlug ?? "").toLowerCase() !== (observed.atsSlug ?? "").toLowerCase()
    || (labelled.atsSite ?? "").toLowerCase() !== (observed.atsSite ?? "").toLowerCase()
    || (actual.atsSlug && actual.atsSlug.toLowerCase() !== observed.atsSlug?.toLowerCase())
    || (actual.atsSite && actual.atsSite.toLowerCase() !== (observed.atsSite ?? "").toLowerCase())) return false;
  const boardUrls = canonicalBoardUrls(expected.type, expected.url);
  return boardUrls.includes(normaliseSourceUrl(expected.url)) && boardUrls.includes(normaliseSourceUrl(actual.url));
}

export function sourceMatches(expected: LiveAcceptanceCase["expectedSource"], actual?: SourceSpec): boolean {
  if (!actual) return false;
  if (actual.type === expected.type) {
    const expectedSpec = ats.specFromAnyUrl(expected.url);
    if (expectedSpec?.atsSlug && actual.atsSlug
      && expectedSpec.atsSlug.toLowerCase() === actual.atsSlug.toLowerCase()
      && (expectedSpec.atsSite ?? "").toLowerCase() === (actual.atsSite ?? "").toLowerCase()) return true;
    if ([expected.url, ...(expected.equivalentUrls ?? [])]
      .some(url => normaliseSourceUrl(url) === normaliseSourceUrl(actual.url))) return true;
  }
  return (expected.equivalentSources ?? []).some(label => matchesTypedAlternative(label, actual));
}

export function summariseLiveAcceptance(cases: LiveAcceptanceCase[], results: LiveAcceptanceResult[]): LiveAcceptanceMetrics {
  const byId = new Map<string, LiveAcceptanceCase>();
  for (const item of cases) {
    if (byId.has(item.id)) throw new Error(`Duplicate selected acceptance case: ${item.id}`);
    byId.set(item.id, item);
  }
  const resultIds = new Set<string>();
  for (const result of results) {
    if (!byId.has(result.id)) throw new Error(`Unknown acceptance result: ${result.id}`);
    if (resultIds.has(result.id)) throw new Error(`Duplicate acceptance result: ${result.id}`);
    resultIds.add(result.id);
  }
  const sourceLabelled = cases.filter(item => item.labelStatus === "source_independently_checked").length;
  let sourceMatchesCount = 0;
  let labelledAutomaticMatchesAt085 = 0;
  let wrongAutomaticAccepts = 0;
  let countLabelled = cases.filter(item => item.expectedRoleCount !== null).length;
  let countMatches = 0;
  let countDisagreements = 0;
  for (const result of results) {
    const item = byId.get(result.id)!;
    if (item.labelStatus === "source_independently_checked") {
      if (result.discovery.sourceMatchesLabel === true) sourceMatchesCount++;
      if (result.discovery.outcome === "resolved" && (result.discovery.confidence ?? 0) >= 0.85 && result.discovery.sourceMatchesLabel === true) labelledAutomaticMatchesAt085++;
      if (result.discovery.outcome === "resolved" && (result.discovery.confidence ?? 0) >= 0.85 && result.discovery.sourceMatchesLabel === false) wrongAutomaticAccepts++;
    }
    if (item.expectedRoleCount !== null) {
      if (result.extraction.countMatchesLabel === true) countMatches++;
      if (result.extraction.countMatchesLabel === false) countDisagreements++;
    }
  }
  const qualified = results.filter(r => r.extraction.referenceComparison?.qualifiesForAcceptance === true);
  for (const r of qualified) {
    if (byId.get(r.id)?.expectedRoleCount === null) {
      countLabelled++;
      const c = r.extraction.referenceComparison!;
      if (r.extraction.outcome === "complete" && c.expectedCount === c.observedCount) countMatches++;
      if (r.extraction.outcome === "complete" && c.expectedCount !== c.observedCount) countDisagreements++;
    }
  }
  const compared = qualified.map(r => r.extraction.referenceComparison!);
  const expectedPostings = compared.reduce((n, c) => n + c.expectedCount, 0);
  const observedPostings = compared.reduce((n, c) => n + c.observedCount, 0);
  const matchedPostings = compared.reduce((n, c) => n + c.matchedCount, 0);
  const postingIdentityFailures = qualified.filter(r => {
    const c = r.extraction.referenceComparison!;
    const html = byId.get(r.id)?.expectedSource.type === "html";
    return c.recall < (html ? 0.90 : 0.98) || c.precision < 0.98;
  }).length;
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
    countDisagreements,
    discoveryAccuracy: sourceLabelled ? labelledAutomaticMatchesAt085 / sourceLabelled : null,
    extractionExactCountAgreement: countLabelled ? countMatches / countLabelled : null,
    postingIdentityLabelled: qualified.length,
    postingIdentityFailures,
    postingIdentityRecall: !qualified.length ? null : expectedPostings ? matchedPostings / expectedPostings : 1,
    postingIdentityPrecision: !qualified.length ? null : observedPostings ? matchedPostings / observedPostings : 1,
  };
}

export function liveAcceptanceVerdict(cases: LiveAcceptanceCase[], metrics: LiveAcceptanceMetrics, requiredCaseIds: string[]): { verdict: LiveAcceptanceVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const corpusCoverage = assessLiveAcceptanceCorpus(cases);
  reasons.push(...corpusCoverage.missingReasons);
  const missingSelectedResults = metrics.total < cases.length;
  const selectedIds = new Set(cases.map(item => item.id));
  if (!Array.isArray(requiredCaseIds) || !requiredCaseIds.length)
    reasons.push("required golden-set case IDs were not supplied; subset diagnostics cannot qualify the full corpus");
  else {
    const requiredIds = new Set(requiredCaseIds);
    if (requiredIds.size !== requiredCaseIds.length) reasons.push("required golden-set case IDs contain duplicates");
    const missingCases = requiredCaseIds.filter(id => !selectedIds.has(id));
    if (missingCases.length) reasons.push(`${missingCases.length} required corpus case(s) were not selected; subset diagnostics cannot qualify the full corpus`);
  }
  if (metrics.wrongAutomaticAccepts > 0) reasons.push(`${metrics.wrongAutomaticAccepts} labelled wrong source(s) automatically accepted at or above 0.85`);
  if (!missingSelectedResults && metrics.discoveryAccuracy !== null && metrics.discoveryAccuracy < 0.8) reasons.push(`labelled automatic discovery agreement is ${(metrics.discoveryAccuracy * 100).toFixed(1)}%, below 80%`);
  if (metrics.sourceLabelled < cases.length) reasons.push(`${cases.length - metrics.sourceLabelled} source label(s) remain independently unverified`);
  if (metrics.countLabelled < cases.length) reasons.push(`${cases.length - metrics.countLabelled} case(s) lack an independent role-count label`);
  if (metrics.countDisagreements > 0) reasons.push(`${metrics.countDisagreements} observed labelled extraction count(s) disagree`);
  else if (!missingSelectedResults && metrics.countMatches < metrics.countLabelled) reasons.push(`${metrics.countLabelled - metrics.countMatches} labelled extraction count(s) disagree`);
  if (metrics.postingIdentityLabelled < cases.length) reasons.push(`${cases.length - metrics.postingIdentityLabelled} case(s) lack a qualifying independent posting-identity snapshot`);
  if (metrics.postingIdentityFailures) reasons.push(`${metrics.postingIdentityFailures} case(s) fail the posting recall/precision threshold`);
  if (metrics.postingIdentityRecall === null || metrics.postingIdentityPrecision === null) reasons.push("posting-identity recall and precision have not been measured");
  if (missingSelectedResults) reasons.push(`${cases.length - metrics.total} selected case(s) have no result`);
  if (metrics.extractionComplete + metrics.extractionPartial + metrics.extractionFailed < metrics.total) reasons.push("one or more selected cases did not run extraction");
  if (metrics.extractionFailed > 0 || metrics.extractionPartial > 0) reasons.push(`${metrics.extractionFailed} extraction failure(s) and ${metrics.extractionPartial} partial extraction(s)`);
  if (metrics.postingIdentityFailures > 0 || metrics.wrongAutomaticAccepts > 0 || metrics.countDisagreements > 0
    || (!missingSelectedResults && ((metrics.discoveryAccuracy !== null && metrics.discoveryAccuracy < 0.8)
      || metrics.countMatches < metrics.countLabelled))) return { verdict: "fail", reasons };
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

export async function runLiveAcceptanceCase(item: LiveAcceptanceCase, options: { discoveryOnly?: boolean; maxFetches?: number; maxDurationMs?: number; fetcher?: PoliteFetcher; browser?: BrowserRenderer; ai?: DiscoveryAiHooks; reference?: ReferencePostingSnapshot; referenceRawHashVerified?: boolean } = {}): Promise<LiveAcceptanceResult> {
  if (options.reference && options.reference.caseId !== item.id) throw new Error("Posting reference belongs to a different case");
  const started = Date.now();
  const referenceSourceMatches = options.reference ? sourceMatches(item.expectedSource,
    ats.specFromAnyUrl(options.reference.sourceUrl) ?? { type: item.expectedSource.type, url: options.reference.sourceUrl }) : false;
  const referenceProof = { sourceMatchesLabel: referenceSourceMatches, rawHashVerified: options.referenceRawHashVerified === true };
  const uniqueCount = (rows: Array<{ url: string }>) => new Set(rows.map(row => canonicalPostingIdentity(row.url))).size;
  const fetcher = options.fetcher ?? new PoliteFetcher({
    userAgent: userAgentFor(process.env.CONTACT_EMAIL ?? "col-live-acceptance@example.invalid"),
    respectRobots: () => true,
  });
  let browserRenders = 0;
  let browserAttempts = 0;
  const browserUrls: string[] = [];
  const browserFailures: LiveAcceptanceResult["discovery"]["browserFailures"] = [];
  const fetchContext = {
    fetchText: (url: string, init?: Parameters<typeof fetcher.fetchText>[1]) => fetcher.fetchText(url, init),
    fetchBytes: (url: string, init?: Parameters<typeof fetcher.fetchBytes>[1]) => fetcher.fetchBytes(url, init),
    render: options.browser ? async (url: string, opts?: RenderOptions) => {
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
    verifySpec: (spec: SourceSpec, allowHost?: FetchInit["allowHost"], onChallenge?: (error: unknown, requestedUrl: string) => void) => ats.getAdapter(spec.type).verify(spec, guardedDiscoveryFetchContext(fetchContext, allowHost, onChallenge)),
    extractFromHtml: ats.extractPostingsFromHtml,
    ai: options.ai,
    maxFetches: options.maxFetches ?? DIAGNOSTIC_DISCOVERY_MAX_FETCHES,
    maxDurationMs: options.maxDurationMs ?? DIAGNOSTIC_DISCOVERY_MAX_DURATION_MS,
  };
  const result: LiveAcceptanceResult = {
    id: item.id,
    company: item.company,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    discovery: { outcome: "error", sourceMatchesLabel: null, maxFetches: discoveryContext.maxFetches,
      maxDurationMs: discoveryContext.maxDurationMs, browserAttempts: 0, browserRenders: 0, browserUrls: [], browserFailures: [] },
    extraction: { outcome: options.discoveryOnly ? "not_run" : "failed", countMatchesLabel: null, sample: [] },
  };
  try {
    const observed = await discovery.discoverCareersSources(item.homepageUrl, discoveryContext);
    result.discovery = {
      outcome: observed.outcome,
      observedType: observed.best?.spec.type,
      observedUrl: observed.best?.spec.url,
      method: observed.best?.method,
      evidence: observed.best?.evidence,
      confidence: observed.best?.confidence,
      fetches: observed.fetches,
      verifications: observed.verifications,
      maxFetches: discoveryContext.maxFetches,
      maxDurationMs: discoveryContext.maxDurationMs,
      sourceMatchesLabel: item.labelStatus === "source_independently_checked" ? sourceMatches(item.expectedSource, observed.best?.spec) : null,
      browserAttempts,
      browserRenders,
      browserUrls: [...browserUrls],
      browserFailures: [...browserFailures],
    };
  } catch (error) {
    result.discovery = { outcome: "error", sourceMatchesLabel: null, error: (error as Error).message, errorCode: "discovery_error",
      maxFetches: discoveryContext.maxFetches, maxDurationMs: discoveryContext.maxDurationMs,
      browserAttempts, browserRenders, browserUrls: [...browserUrls], browserFailures: [...browserFailures] };
  }
  if (!options.discoveryOnly) {
    try {
      const spec = ats.specFromAnyUrl(item.expectedSource.url) ?? { type: item.expectedSource.type, url: item.expectedSource.url };
      const postings = spec.type === "html" ? await observeHtmlListing(spec, fetchContext) : await ats.getAdapter(spec.type).fetchPostings(spec, fetchContext);
      result.extraction = {
        ...(options.reference ? { referenceComparison: compareReferencePostings(options.reference, postings, { observation: "complete", now: new Date(started), ...referenceProof }) } : {}),
        basis: "labelled_source_diagnostic",
        outcome: "complete",
        observedRoleCount: uniqueCount(postings),
        rawObservedRoleCount: postings.length,
        countMatchesLabel: item.expectedRoleCount === null ? null : uniqueCount(postings) === item.expectedRoleCount,
        sample: postings.slice(0, 3).map(({ title, location, url }) => ({ title, location, url })),
      };
    } catch (error) {
      const partial = error instanceof Error && error.name === "IncompleteListingError";
      const postings = partial && "postings" in (error as object) ? (error as Error & { postings: Array<{ title: string; location?: string; url: string }> }).postings : [];
      result.extraction = {
        ...(options.reference ? { referenceComparison: compareReferencePostings(options.reference, postings, { observation: "partial", now: new Date(started), ...referenceProof }) } : {}),
        basis: "labelled_source_diagnostic",
        outcome: partial ? "partial" : "failed",
        observedRoleCount: partial ? uniqueCount(postings) : undefined,
        rawObservedRoleCount: partial ? postings.length : undefined,
        countMatchesLabel: null,
        sample: postings.slice(0, 3).map(({ title, location, url }) => ({ title, location, url })),
        error: (error as Error).message,
        errorCode: extractionErrorCode(error),
      };
    }
  }
  if (!options.discoveryOnly) {
    result.extraction.browserAttempts = browserAttempts - result.discovery.browserAttempts;
    result.extraction.browserRenders = browserRenders - result.discovery.browserRenders;
    result.extraction.browserUrls = browserUrls.slice(result.discovery.browserUrls.length);
  }
  result.durationMs = Date.now() - started;
  return result;
}
