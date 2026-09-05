import { describe, expect, it } from "vitest";
import { classifyScan, keyPostings, modeForScanStatus, reconcile, type ExistingJob } from "./reconcile";
import { deriveExternalKey, normalizeUrl } from "./normalize";
import { displayStatus, formatDuration, liveFor } from "./status";
import type { RawPosting } from "./types";

const now = new Date("2026-09-05T09:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function job(over: Partial<ExistingJob> = {}): ExistingJob {
  return {
    id: "job-1",
    externalKey: "id:1",
    status: "open",
    missingScans: 0,
    title: "Operations Manager",
    location: "London, UK",
    normalizedTitle: "operations manager",
    closedAt: null,
    ...over,
  };
}

function posting(over: Partial<RawPosting> = {}): RawPosting {
  return { externalId: "1", title: "Operations Manager", url: "https://x.example/jobs/1", location: "London, UK", ...over };
}

describe("identity", () => {
  it("prefers the ATS id, then the normalised URL, then a title hash", () => {
    expect(deriveExternalKey({ externalId: "42", url: "https://x/1", title: "t" })).toBe("id:42");
    expect(deriveExternalKey({ url: "https://x.example/jobs/1?utm_source=li&gh_src=abc", title: "t" })).toBe("url:https://x.example/jobs/1");
    expect(deriveExternalKey({ url: "", title: "Ops Lead", location: "London" })).toMatch(/^hash:/);
  });
  it("survives tracking parameters and trailing slashes", () => {
    expect(normalizeUrl("https://X.example/Jobs/1/?utm_campaign=x&ref=y#top")).toBe("https://x.example/Jobs/1");
  });
  it("merges duplicate keys within one scan and keeps every location", () => {
    const { keyed, duplicates } = keyPostings([
      posting({ location: "London, UK" }),
      posting({ location: "Manchester, UK" }),
    ]);
    expect(keyed).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(keyed[0]!.locations).toEqual(expect.arrayContaining(["London, UK", "Manchester, UK"]));
  });
});

describe("reconcile", () => {
  it("inserts unseen postings", () => {
    const r = reconcile([], [posting()], { mode: "ok", now });
    expect(r.inserts).toHaveLength(1);
    expect(r.inserts[0]!.externalKey).toBe("id:1");
  });
  it("marks a present job as seen and records field changes", () => {
    const r = reconcile([job()], [posting({ title: "Senior Operations Manager", location: "Bristol, UK" })], { mode: "ok", now });
    expect(r.seen).toEqual(["job-1"]);
    expect(r.updates[0]!.changedFields).toEqual(["title", "location"]);
    expect(r.closed).toEqual([]);
  });
  it("needs two consecutive ok scans to close a role", () => {
    const first = reconcile([job()], [], { mode: "ok", now });
    expect(first.missing).toEqual(["job-1"]);
    expect(first.closed).toEqual([]);
    const second = reconcile([job({ missingScans: 1 })], [], { mode: "ok", now });
    expect(second.closed).toEqual(["job-1"]);
  });
  it("never closes anything on a failed or suspicious scan", () => {
    for (const mode of ["none", "partial"] as const) {
      const r = reconcile([job({ missingScans: 1 })], [], { mode, now });
      expect(r.closed).toEqual([]);
      expect(r.missing).toEqual([]);
    }
  });
  it("reopens a closed job whose key comes back", () => {
    const r = reconcile([job({ status: "closed", closedAt: daysAgo(3) })], [posting()], { mode: "ok", now });
    expect(r.reopened).toEqual(["job-1"]);
  });
  it("links a new posting to a recently closed twin as a repost", () => {
    const closed = job({ id: "old", externalKey: "id:old", status: "closed", closedAt: daysAgo(5) });
    const r = reconcile([closed], [posting({ externalId: "new" })], { mode: "ok", now });
    expect(r.inserts[0]!.repostOfJobId).toBe("old");
  });
  it("does not link a repost outside the window", () => {
    const closed = job({ id: "old", externalKey: "id:old", status: "closed", closedAt: daysAgo(60) });
    const r = reconcile([closed], [posting({ externalId: "new" })], { mode: "ok", now });
    expect(r.inserts[0]!.repostOfJobId).toBeUndefined();
  });
  it("does not allow a saved threshold to weaken the two-scan minimum", () => {
    const result = reconcile([job()], [], { mode: "ok", now, closeAfterMissing: 1 });
    expect(result.closed).toEqual([]);
    expect(result.missing).toEqual(["job-1"]);
  });
  it("honours a custom close threshold", () => {
    const r = reconcile([job({ missingScans: 2 })], [], { mode: "ok", now, closeAfterMissing: 3 });
    expect(r.closed).toEqual(["job-1"]);
  });
});

describe("classifyScan", () => {
  it("fails when the fetch failed", () => {
    expect(classifyScan({ fetchOk: false, postingsFound: 0, previousOkCount: 10 })).toBe("failed");
  });
  it("flags a suspicious empty result", () => {
    expect(classifyScan({ fetchOk: true, postingsFound: 0, previousOkCount: 12 })).toBe("suspect_empty");
    expect(classifyScan({ fetchOk: true, postingsFound: 0, previousOkCount: null })).toBe("ok");
    expect(classifyScan({ fetchOk: true, postingsFound: 0, previousOkCount: 2 })).toBe("ok");
  });
  it("flags a big drop or heavy validation losses as partial", () => {
    expect(classifyScan({ fetchOk: true, postingsFound: 2, previousOkCount: 20 })).toBe("partial");
    expect(classifyScan({ fetchOk: true, postingsFound: 8, previousOkCount: 10, droppedByValidation: 5 })).toBe("partial");
    expect(classifyScan({ fetchOk: true, postingsFound: 10, previousOkCount: 10 })).toBe("ok");
  });
  it("maps statuses to reconciliation modes", () => {
    expect(modeForScanStatus("ok")).toBe("ok");
    expect(modeForScanStatus("partial")).toBe("partial");
    expect(modeForScanStatus("suspect_empty")).toBe("none");
    expect(modeForScanStatus("failed")).toBe("none");
  });
});

describe("status and live-for", () => {
  it("calls a role New for seven days from the posted date", () => {
    expect(displayStatus({ status: "open", postedAt: daysAgo(3), firstSeenAt: daysAgo(1), closedAt: null }, now)).toBe("new");
    expect(displayStatus({ status: "open", postedAt: daysAgo(9), firstSeenAt: daysAgo(1), closedAt: null }, now)).toBe("active");
  });
  it("falls back to first-seen and says so", () => {
    const r = liveFor({ status: "open", postedAt: null, firstSeenAt: daysAgo(10), closedAt: null }, now);
    expect(r).toEqual({ days: 10, basis: "first_seen" });
  });
  it("ignores a posted date that is later than first-seen by more than a day", () => {
    const r = liveFor({ status: "open", postedAt: daysAgo(-5), firstSeenAt: daysAgo(10), closedAt: null }, now);
    expect(r.basis).toBe("first_seen");
  });
  it("freezes the duration once a role closes", () => {
    const r = liveFor({ status: "closed", postedAt: daysAgo(30), firstSeenAt: daysAgo(30), closedAt: daysAgo(10) }, now);
    expect(r.days).toBe(20);
    expect(displayStatus({ status: "closed", postedAt: daysAgo(1), firstSeenAt: daysAgo(1), closedAt: daysAgo(0) }, now)).toBe("closed");
  });
  it("formats durations for the table", () => {
    expect(formatDuration(0)).toBe("today");
    expect(formatDuration(6)).toBe("6d");
    expect(formatDuration(21)).toBe("3w");
    expect(formatDuration(90)).toBe("3mo");
    expect(formatDuration(400)).toBe("1.1y");
  });
});
