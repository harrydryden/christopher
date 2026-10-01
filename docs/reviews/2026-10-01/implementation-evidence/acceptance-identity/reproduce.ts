import { liveAcceptanceVerdict, summariseLiveAcceptance } from "../../../../../apps/worker/src/live-acceptance";
import type { LiveAcceptanceCase, LiveAcceptanceResult } from "../../../../../apps/worker/src/live-acceptance";

// Offline gate fixture. The pre-fix result is retained separately in before-fix-observation.json.
const base: LiveAcceptanceCase = {
  id: "a", company: "A", homepageUrl: "https://a.test",
  expectedSource: { type: "greenhouse", url: "https://boards.greenhouse.io/a" },
  expectedRoleCount: null, labelStatus: "source_independently_checked", labelNote: "fixture",
};
const cases = [base, { ...base, id: "b" }];
function result(id: string): LiveAcceptanceResult {
  return {
    id, company: id, startedAt: new Date(0).toISOString(), durationMs: 1,
    discovery: { outcome: "resolved", confidence: 0.9, sourceMatchesLabel: true,
      browserAttempts: 0, browserRenders: 0, browserUrls: [], browserFailures: [] },
    extraction: { outcome: "complete", countMatchesLabel: null, sample: [],
      referenceComparison: {
        expectedCount: 1, observedCount: 1, matchedCount: 1,
        expectedDuplicateCount: 0, observedDuplicateCount: 0,
        expectedUrls: ["https://a.test/jobs/one"], observedUrls: ["https://a.test/jobs/one"],
        matchedUrls: ["https://a.test/jobs/one"], missingUrls: [], unexpectedUrls: [],
        recall: 1, precision: 1, qualifiesForAcceptance: true, qualificationReasons: [],
      } },
  };
}
function rejection(results: LiveAcceptanceResult[]): string {
  try { summariseLiveAcceptance(cases, results); }
  catch (error) { return (error as Error).message; }
  throw new Error("invalid result identities were accepted");
}

const duplicateResult = rejection([result("a"), result("a")]);
const unknownResult = rejection([result("a"), result("unknown")]);
const missingMetrics = summariseLiveAcceptance(cases, [result("a")]);
const missingResultVerdict = liveAcceptanceVerdict(cases, missingMetrics);
if (duplicateResult !== "Duplicate acceptance result: a"
  || unknownResult !== "Unknown acceptance result: unknown"
  || missingResultVerdict.verdict !== "blocked") throw new Error("acceptance identity gate regression");
console.log(JSON.stringify({ duplicateResult, unknownResult, missingResultVerdict }, null, 2));
