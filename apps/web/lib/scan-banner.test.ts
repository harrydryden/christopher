import { describe, expect, it } from "vitest";
import { REVIEW_HREF, scanStripItems, scanStripSignature, type ScanStripFacts } from "./scan-banner";

const now = new Date("2026-09-11T12:00:00Z");
const facts: ScanStripFacts = {
  scanning: false,
  lastScanAt: "2026-09-11T10:00:00.000Z",
  following: 6,
  newRoleMatches: 3,
  newCompanyMatches: 2,
};

describe("scanStripItems", () => {
  it("says four terse facts in order, each linking to what it counts", () => {
    expect(scanStripItems(facts, now).map((item) => [item.text, item.href])).toEqual([
      ["Last scan 2h ago", "/health"],
      ["Following 6 companies", "/companies"],
      ["3 new role matches", REVIEW_HREF],
      ["2 new company matches", "/suggestions"],
    ]);
    expect(REVIEW_HREF).toBe("/?view=auto-matched#roles");
  });

  it("says 'not yet' before any scan has completed", () => {
    expect(scanStripItems({ ...facts, lastScanAt: null }, now)[0]!.text).toBe("Last scan not yet");
  });

  it("uses the singular for one and still says zero", () => {
    const texts = scanStripItems({ ...facts, following: 1, newRoleMatches: 1, newCompanyMatches: 0 }, now).map((item) => item.text);
    expect(texts.slice(1)).toEqual(["Following 1 company", "1 new role match", "0 new company matches"]);
  });
});

describe("scanStripSignature", () => {
  it("changes when any fact does and not otherwise", () => {
    expect(scanStripSignature({ ...facts })).toBe(scanStripSignature(facts));
    for (const change of [{ scanning: true }, { lastScanAt: null }, { following: 7 }, { newRoleMatches: 4 }, { newCompanyMatches: 0 }]) {
      expect(scanStripSignature({ ...facts, ...change })).not.toBe(scanStripSignature(facts));
    }
  });
});
