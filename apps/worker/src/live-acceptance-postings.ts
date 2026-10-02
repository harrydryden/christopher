import type { RawPosting } from "@ava/core";

/** A dated, independently captured listing of posting identities for one acceptance case. */
export interface ReferencePostingSnapshot {
  caseId: string;
  sourceUrl: string;
  capturedAt: string;
  evidenceUrl: string;
  rawSha256: string;
  rawPath?: string;
  enumerationMethod: string;
  reviewStatus: "machine_enumerated" | "human_reviewed";
  /** A human review must independently attest the full, unfiltered listing scope. */
  completeScope: boolean;
  /** Optional for historical/machine snapshots; required before a human label can qualify. */
  reviewAttestation?: {
    reviewer: string;
    reviewedAt: string;
    /** What full listing, pages and filters the reviewer actually checked. */
    scopeEvidence: string;
    fullScopeAttested: boolean;
  };
  postingUrls: string[];
}

export interface PostingComparison {
  expectedCount: number;
  observedCount: number;
  matchedCount: number;
  expectedDuplicateCount: number;
  observedDuplicateCount: number;
  expectedUrls: string[];
  observedUrls: string[];
  matchedUrls: string[];
  missingUrls: string[];
  unexpectedUrls: string[];
  /** Micro ratios over unique URL identities. Empty denominator is a vacuous 1. */
  recall: number;
  precision: number;
  /** Eligibility of this comparison as acceptance evidence, separate from meeting any score threshold. */
  qualifiesForAcceptance: boolean;
  qualificationReasons: string[];
}

const DAY_MS = 86_400_000;
const SHA256_RE = /^[a-f\d]{64}$/i;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("posting reference must be an object");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`posting reference ${field} must be non-empty text`);
  return value.trim();
}

function httpUrl(value: unknown, field: string): string {
  const text = requiredText(value, field);
  let parsed: URL;
  try { parsed = new URL(text); }
  catch { throw new Error(`posting reference ${field} must be an absolute HTTP(S) URL`); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
    throw new Error(`posting reference ${field} must be an absolute HTTP(S) URL without credentials`);
  return text;
}

function referenceDate(value: unknown, field: "capturedAt" | "reviewAttestation.reviewedAt"): string {
  const text = requiredText(value, field);
  const parts = ISO_DATE_RE.exec(text);
  if (!parts) throw new Error(`posting reference ${field} must be an ISO 8601 timestamp with timezone`);
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1]!
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
    || !Number.isFinite(Date.parse(text)))
    throw new Error(`posting reference ${field} must be a real ISO 8601 timestamp`);
  return text;
}

/** Only unambiguous tracking fields are removed; every other query field can identify a role. */
export function canonicalPostingIdentity(input: string): string {
  const text = input.trim();
  let url: URL;
  try { url = new URL(text); }
  catch { throw new Error(`posting identity is not an absolute HTTP(S) URL: ${text}`); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error(`posting identity is not an absolute HTTP(S) URL: ${text}`);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const query = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && key.toLowerCase() !== "gh_src")
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
  url.search = "";
  for (const [key, value] of query) url.searchParams.append(key, value);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/** Reject malformed metadata before a snapshot can be used as a label. Extra audit fields are ignored. */
export function validateReferenceSnapshot(input: unknown): ReferencePostingSnapshot {
  const data = record(input);
  const caseId = requiredText(data.caseId, "caseId");
  if (!/^[a-z\d][a-z\d_-]*$/.test(caseId)) throw new Error("posting reference caseId must be a lowercase case identifier");
  const sourceUrl = httpUrl(data.sourceUrl, "sourceUrl");
  const evidenceUrl = httpUrl(data.evidenceUrl, "evidenceUrl");
  const capturedAt = referenceDate(data.capturedAt, "capturedAt");
  const rawSha256 = requiredText(data.rawSha256, "rawSha256");
  if (!SHA256_RE.test(rawSha256)) throw new Error("posting reference rawSha256 must be 64 hexadecimal characters");
  const enumerationMethod = requiredText(data.enumerationMethod, "enumerationMethod");
  if (enumerationMethod.length > 1000) throw new Error("posting reference enumerationMethod is too long");
  if (data.reviewStatus !== "machine_enumerated" && data.reviewStatus !== "human_reviewed")
    throw new Error("posting reference reviewStatus must be machine_enumerated or human_reviewed");
  if (typeof data.completeScope !== "boolean") throw new Error("posting reference completeScope must be a boolean attestation");
  let reviewAttestation: ReferencePostingSnapshot["reviewAttestation"];
  if (data.reviewAttestation !== undefined) {
    if (!data.reviewAttestation || typeof data.reviewAttestation !== "object" || Array.isArray(data.reviewAttestation))
      throw new Error("posting reference reviewAttestation must be an object");
    const review = data.reviewAttestation as Record<string, unknown>;
    const reviewer = requiredText(review.reviewer, "reviewAttestation.reviewer");
    const reviewedAt = referenceDate(review.reviewedAt, "reviewAttestation.reviewedAt");
    const scopeEvidence = requiredText(review.scopeEvidence, "reviewAttestation.scopeEvidence");
    if (scopeEvidence.length < 20 || scopeEvidence.split(/\s+/).length < 3)
      throw new Error("posting reference reviewAttestation.scopeEvidence must describe the reviewed listing scope in at least 20 characters and three words");
    if (typeof review.fullScopeAttested !== "boolean")
      throw new Error("posting reference reviewAttestation.fullScopeAttested must be a boolean");
    if (review.fullScopeAttested && !data.completeScope)
      throw new Error("posting reference reviewAttestation.fullScopeAttested conflicts with completeScope false");
    if (Date.parse(reviewedAt) < Date.parse(capturedAt))
      throw new Error("posting reference reviewAttestation.reviewedAt must not precede capturedAt");
    reviewAttestation = { reviewer, reviewedAt, scopeEvidence, fullScopeAttested: review.fullScopeAttested };
  }
  if (!Array.isArray(data.postingUrls)) throw new Error("posting reference postingUrls must be an array");
  const postingUrls = data.postingUrls.map((item, index) => {
    const url = httpUrl(item, `postingUrls[${index}]`);
    canonicalPostingIdentity(url);
    return url;
  });
  let rawPath: string | undefined;
  if (data.rawPath !== undefined) {
    rawPath = requiredText(data.rawPath, "rawPath");
    if (rawPath === "." || rawPath === ".." || rawPath.includes("/") || rawPath.includes("\\"))
      throw new Error("posting reference rawPath must be a sibling filename");
  }
  return { caseId, sourceUrl, capturedAt, evidenceUrl, rawSha256: rawSha256.toLowerCase(), ...(rawPath ? { rawPath } : {}),
    enumerationMethod, reviewStatus: data.reviewStatus, completeScope: data.completeScope,
    ...(reviewAttestation ? { reviewAttestation } : {}), postingUrls };
}

/** Exact posting-identity comparison. A partial observation still yields diagnostics, never acceptance evidence. */
export function compareReferencePostings(
  snapshot: ReferencePostingSnapshot,
  observed: RawPosting[],
  options: { observation: "complete" | "partial"; now?: Date; sourceMatchesLabel?: boolean; rawHashVerified?: boolean },
): PostingComparison {
  const label = validateReferenceSnapshot(snapshot);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("comparison clock must be a valid date");
  const expectedRaw = label.postingUrls.map(canonicalPostingIdentity);
  const observedRaw = observed.map(posting => canonicalPostingIdentity(posting.url));
  const expectedUrls = [...new Set(expectedRaw)].sort();
  const observedUrls = [...new Set(observedRaw)].sort();
  const expected = new Set(expectedUrls);
  const actual = new Set(observedUrls);
  const matchedUrls = expectedUrls.filter(url => actual.has(url));
  const missingUrls = expectedUrls.filter(url => !actual.has(url));
  const unexpectedUrls = observedUrls.filter(url => !expected.has(url));
  const age = now.getTime() - Date.parse(label.capturedAt);
  const qualificationReasons: string[] = [];
  if (!label.rawPath || options.rawHashVerified !== true) qualificationReasons.push("raw evidence file has not been hash verified");
  if (options.sourceMatchesLabel !== true) qualificationReasons.push("reference source is not bound to the labelled source");
  if (label.reviewStatus !== "human_reviewed") qualificationReasons.push("reference has not been human reviewed");
  else if (!label.reviewAttestation) qualificationReasons.push("human review attestation is missing");
  if (!label.completeScope) qualificationReasons.push("complete listing scope has not been independently attested");
  if (label.reviewStatus === "human_reviewed" && label.reviewAttestation) {
    if (label.completeScope && !label.reviewAttestation.fullScopeAttested)
      qualificationReasons.push("reviewer did not attest the full listing scope");
    if (Date.parse(label.reviewAttestation.reviewedAt) > now.getTime())
      qualificationReasons.push("human review is after the observation");
  }
  if (age < 0) qualificationReasons.push("reference capture is in the future");
  else if (age > DAY_MS) qualificationReasons.push("reference capture is older than 24 hours");
  if (options.observation !== "complete") qualificationReasons.push("observed listing is partial");
  return {
    expectedCount: expectedUrls.length,
    observedCount: observedUrls.length,
    matchedCount: matchedUrls.length,
    expectedDuplicateCount: expectedRaw.length - expectedUrls.length,
    observedDuplicateCount: observedRaw.length - observedUrls.length,
    expectedUrls, observedUrls, matchedUrls, missingUrls, unexpectedUrls,
    recall: expectedUrls.length === 0 ? 1 : matchedUrls.length / expectedUrls.length,
    precision: observedUrls.length === 0 ? 1 : matchedUrls.length / observedUrls.length,
    qualifiesForAcceptance: qualificationReasons.length === 0,
    qualificationReasons,
  };
}

/** Aggregate by identity counts, never by averaging company percentages. */
export function microPostingMetrics(comparisons: PostingComparison[]): { expectedCount: number; observedCount: number; matchedCount: number; recall: number; precision: number } {
  const expectedCount = comparisons.reduce((total, result) => total + result.expectedCount, 0);
  const observedCount = comparisons.reduce((total, result) => total + result.observedCount, 0);
  const matchedCount = comparisons.reduce((total, result) => total + result.matchedCount, 0);
  return { expectedCount, observedCount, matchedCount, recall: expectedCount === 0 ? 1 : matchedCount / expectedCount,
    precision: observedCount === 0 ? 1 : matchedCount / observedCount };
}
