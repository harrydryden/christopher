import { describe, expect, it } from "vitest";
import type { RawPosting } from "@ava/core";
import {
  canonicalPostingIdentity,
  compareReferencePostings,
  microPostingMetrics,
  validateReferenceSnapshot,
  type ReferencePostingSnapshot,
} from "./live-acceptance-postings";

const now = new Date("2026-09-29T14:00:00.000Z");
const snapshot: ReferencePostingSnapshot = {
  caseId: "board-one",
  sourceUrl: "https://board.example/jobs",
  evidenceUrl: "https://board.example/public-feed",
  capturedAt: "2026-09-29T13:30:00Z",
  rawSha256: "a".repeat(64),
  rawPath: "board-one.raw.json",
  enumerationMethod: "Independent public API enumeration, manually checked against the listing.",
  reviewStatus: "human_reviewed",
  completeScope: true,
  postingUrls: ["https://board.example/jobs/1", "https://board.example/jobs/2"],
};
const posts = (...urls: string[]): RawPosting[] => urls.map(url => ({ title: "A role", url }));
const compare = (reference: ReferencePostingSnapshot, observed: RawPosting[], observation: "complete" | "partial" = "complete") =>
  compareReferencePostings(reference, observed, { observation, now, sourceMatchesLabel: true, rawHashVerified: true });

describe("posting identity canonicalisation", () => {
  it("drops only fragments, utm_* and gh_src, and preserves identifying query parameters", () => {
    expect(canonicalPostingIdentity(" HTTPS://BOARD.Example/jobs/42/?z=2&gh_src=mail&gh_jid=42&utm_campaign=autumn&a=1#apply "))
      .toBe("https://board.example/jobs/42?a=1&gh_jid=42&z=2");
    expect(canonicalPostingIdentity("https://board.example/jobs/42?ref=one&source=two&fbclid=x&jobId=7"))
      .toBe("https://board.example/jobs/42?fbclid=x&jobId=7&ref=one&source=two");
    expect(canonicalPostingIdentity("https://board.example/?utm_SOURCE=mail")).toBe("https://board.example/");
    expect(canonicalPostingIdentity("http://board.example/jobs/42")).not.toBe(canonicalPostingIdentity("https://board.example/jobs/42"));
    expect(canonicalPostingIdentity("https://board.example/Jobs/42")).not.toBe(canonicalPostingIdentity("https://board.example/jobs/42"));
    expect(() => canonicalPostingIdentity("/jobs/42")).toThrow("absolute HTTP(S)");
  });
});

describe("reference posting comparison", () => {
  it("compares exact unique URLs and reports duplicates without inflating recall", () => {
    const reference = { ...snapshot, postingUrls: [...snapshot.postingUrls, "https://board.example/jobs/1/?utm_source=mail"] };
    const result = compare(reference, posts(
      "https://BOARD.example/jobs/1/?gh_src=news#apply",
      "https://board.example/jobs/1",
      "https://board.example/jobs/3?jobId=7",
      "https://board.example/jobs/3?jobId=7&utm_source=x",
    ));
    expect(result).toMatchObject({ expectedCount: 2, observedCount: 2, matchedCount: 1,
      expectedDuplicateCount: 1, observedDuplicateCount: 2, recall: 0.5, precision: 0.5,
      qualifiesForAcceptance: true });
    expect(result.matchedUrls).toEqual(["https://board.example/jobs/1"]);
    expect(result.missingUrls).toEqual(["https://board.example/jobs/2"]);
    expect(result.unexpectedUrls).toEqual(["https://board.example/jobs/3?jobId=7"]);
  });

  it("keeps machine and partial observations diagnostic but ineligible", () => {
    const machine = compare({ ...snapshot, reviewStatus: "machine_enumerated", completeScope: false }, posts(snapshot.postingUrls[0]!));
    expect(machine).toMatchObject({ recall: 0.5, precision: 1, qualifiesForAcceptance: false });
    expect(machine.qualificationReasons).toContain("reference has not been human reviewed");
    expect(machine.qualificationReasons).toContain("complete listing scope has not been independently attested");
    const partial = compare(snapshot, posts(...snapshot.postingUrls), "partial");
    expect(partial).toMatchObject({ recall: 1, precision: 1, qualifiesForAcceptance: false });
    expect(partial.qualificationReasons).toContain("observed listing is partial");
  });

  it("requires verified raw evidence and source binding even for a human attestation", () => {
    const noProof = compareReferencePostings(snapshot, posts(...snapshot.postingUrls), { observation: "complete", now });
    expect(noProof.qualifiesForAcceptance).toBe(false);
    expect(noProof.qualificationReasons).toContain("raw evidence file has not been hash verified");
    expect(noProof.qualificationReasons).toContain("reference source is not bound to the labelled source");
    expect(compare({ ...snapshot, rawPath: undefined }, posts(...snapshot.postingUrls)).qualifiesForAcceptance).toBe(false);
  });

  it("uses the run clock: future and older-than-24-hour captures cannot qualify", () => {
    expect(compare({ ...snapshot, capturedAt: "2026-09-29T14:00:01Z" }, posts(...snapshot.postingUrls)).qualificationReasons)
      .toContain("reference capture is in the future");
    expect(compare({ ...snapshot, capturedAt: "2026-09-28T13:59:59Z" }, posts(...snapshot.postingUrls)).qualificationReasons)
      .toContain("reference capture is older than 24 hours");
    expect(compare({ ...snapshot, capturedAt: "2026-09-28T14:00:00Z" }, posts(...snapshot.postingUrls)).qualifiesForAcceptance).toBe(true);
  });

  it("defines empty sets explicitly and aggregates micro ratios from counts", () => {
    const empty = compare({ ...snapshot, postingUrls: [] }, []);
    expect(empty).toMatchObject({ expectedCount: 0, observedCount: 0, matchedCount: 0, recall: 1, precision: 1 });
    const falsePositive = compare({ ...snapshot, postingUrls: [] }, posts("https://board.example/jobs/3"));
    expect(falsePositive).toMatchObject({ recall: 1, precision: 0, unexpectedUrls: ["https://board.example/jobs/3"] });
    const missed = compare(snapshot, []);
    expect(missed).toMatchObject({ recall: 0, precision: 1, missingUrls: snapshot.postingUrls });
    const oneOfTwo = compare(snapshot, posts(snapshot.postingUrls[0]!));
    expect(microPostingMetrics([oneOfTwo, falsePositive])).toEqual({ expectedCount: 2, observedCount: 2, matchedCount: 1, recall: 0.5, precision: 0.5 });
  });

  it("rejects malformed evidence metadata and posting URLs before comparison", () => {
    const invalid: Array<[string, unknown]> = [
      ["caseId", ""], ["sourceUrl", "file:///tmp/jobs"], ["evidenceUrl", "not a URL"],
      ["capturedAt", "2026-02-30T13:00:00Z"], ["capturedAt", "2026-09-29"],
      ["rawSha256", "abc"], ["enumerationMethod", ""], ["reviewStatus", "independent"],
      ["completeScope", "yes"], ["postingUrls", "https://board.example/jobs/1"],
      ["postingUrls", ["javascript:alert(1)"]], ["rawPath", "../raw.json"],
    ];
    for (const [field, value] of invalid) {
      expect(() => validateReferenceSnapshot({ ...snapshot, [field]: value }), field).toThrow();
    }
    expect(() => compare(snapshot, posts("/jobs/relative"))).toThrow("absolute HTTP(S)");
    expect(validateReferenceSnapshot({ ...snapshot, jobs: [{ id: "audit-only" }] })).toEqual(snapshot);
  });
});
