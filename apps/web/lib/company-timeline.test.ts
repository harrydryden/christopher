/**
 * The company setup timeline, state by state. Every line is derived from rows and a `now`, so the
 * whole of it — including the elapsed figures — is testable without a database or a screenshot.
 */
import { expect, it } from "vitest";
import { deadlineFor } from "@ava/core";
import {
  companySetupLine,
  companySetupRunning,
  narrateCompanySetup,
  sourceWords,
  type CompanySetupRows,
  type CompanyTimelineStep,
} from "./company-timeline";

const NOW = new Date("2026-09-19T10:00:00Z");
const secondsAgo = (n: number) => new Date(NOW.getTime() - n * 1000);
const CONTEXT = { nextScan: "next scheduled scan at 06:00 Europe/London" };

const EMPTY: CompanySetupRows = {
  run: null,
  discoveryTask: null,
  source: null,
  scan: null,
  scanTask: null,
  table: { inTable: 0, scoring: 0, scored: 0 },
};

const GREENHOUSE = {
  id: "source-1",
  type: "greenhouse",
  url: "https://boards.greenhouse.io/acme",
  status: "active",
  confidence: 0.9,
  confirmedByUser: false,
  consecutiveFailures: 0,
};

function narrate(rows: Partial<CompanySetupRows>): CompanyTimelineStep[] {
  return narrateCompanySetup({ ...EMPTY, ...rows }, NOW, CONTEXT);
}
const byKey = (steps: CompanyTimelineStep[], key: CompanyTimelineStep["key"]) => steps.find((s) => s.key === key)!;

it("says nothing has happened yet, and what each step usually takes", () => {
  const steps = narrate({});
  expect(steps.map((s) => s.key)).toEqual(["discovery", "source", "scan", "table"]);
  expect(steps.every((s) => s.status === "waiting")).toBe(true);
  expect(byKey(steps, "discovery").text).toBe("Nobody has looked for this company's careers page yet.");
  // The ceiling in each sentence is the worker's own deadline, so the interface cannot promise
  // longer than the task is allowed to run.
  expect(byKey(steps, "discovery").expected).toBe(`usually under a minute · discovery gives up after ${deadlineFor("discover") / 60_000} minutes`);
  expect(byKey(steps, "source").text).toBe("No careers page confirmed yet");
  expect(byKey(steps, "scan").text).toBe("Waiting for a careers page to read");
  expect(byKey(steps, "table").text).toBe("Waiting for a scan to read the board");
  expect(companySetupRunning(steps)).toBe(false);
  expect(companySetupLine(steps)).toBe("Nobody has looked for this company's careers page yet.");
});

it("times discovery from the run while it is open, and from the task before there is one", () => {
  const queued = narrate({ discoveryTask: { state: "queued", startedAt: null } });
  expect(byKey(queued, "discovery")).toMatchObject({ status: "running", text: "Finding the careers page", elapsedMs: null });
  expect(byKey(queued, "discovery").note).toBe("Queued behind the worker's other work.");
  expect(companySetupRunning(queued)).toBe(true);

  const running = narrate({
    run: { status: "running", startedAt: secondsAgo(40), finishedAt: null, candidates: [], chosenSourceId: null, error: null },
  });
  const discovery = byKey(running, "discovery");
  expect(discovery).toMatchObject({ status: "running", tone: "blue", glyph: "…", elapsedMs: 40_000, running: true });
  expect(discovery.startedAt).toEqual(secondsAgo(40));
  // The compact line is the doc's own example: what is happening, with the figure beside it.
  expect(companySetupLine(running)).toBe("Finding the careers page · 40 s");
});

it("tells candidates nobody has picked apart from nothing found and from a run that stopped", () => {
  const candidates = [
    { type: "greenhouse", url: "https://boards.greenhouse.io/acme", confidence: 0.98 },
    { type: "html", url: "https://acme.example/careers", confidence: 0.4 },
  ];
  const asking = narrate({
    run: { status: "needs_confirmation", startedAt: secondsAgo(60), finishedAt: secondsAgo(20), candidates, chosenSourceId: null, error: null },
  });
  expect(byKey(asking, "discovery")).toMatchObject({ status: "attention", tone: "amber", glyph: "!", elapsedMs: 40_000 });
  expect(byKey(asking, "discovery").text).toBe("Discovery found 2 candidates; pick one below or paste the URL.");
  // The source step names the strongest candidate rather than repeating the ask.
  expect(byKey(asking, "source").text).toBe("Nobody has picked one yet · the strongest is a Greenhouse board (98%)");
  expect(companySetupLine(asking)).toBe("Discovery found 2 candidates; pick one below or paste the URL.");

  const notFound = narrate({
    run: { status: "not_found", startedAt: secondsAgo(90), finishedAt: secondsAgo(30), candidates: [], chosenSourceId: null, error: null },
  });
  expect(byKey(notFound, "discovery").text).toBe("Discovery found no careers page for this company.");
  expect(byKey(notFound, "discovery").note).toBe("Paste its careers or board URL, or run discovery again.");

  const failed = narrate({
    run: { status: "failed", startedAt: secondsAgo(90), finishedAt: secondsAgo(30), candidates: [], chosenSourceId: null, error: "fetch timed out" },
  });
  expect(byKey(failed, "discovery")).toMatchObject({ status: "failed", tone: "red", glyph: "✗", note: "fetch timed out" });

  // Resolved once, but the source it chose is gone: still nothing a scan can read.
  const stale = narrate({
    run: { status: "resolved", startedAt: secondsAgo(90), finishedAt: secondsAgo(30), candidates, chosenSourceId: "source-1", error: null },
  });
  expect(byKey(stale, "discovery")).toMatchObject({ status: "attention", text: "No careers page is in use for this company." });
});

it("names the source in plain words, with the confidence the run recorded for it", () => {
  const candidates = [
    { type: "html", url: "https://acme.example/careers", confidence: 0.4 },
    { type: "greenhouse", url: GREENHOUSE.url, confidence: 0.98 },
  ];
  const steps = narrate({
    run: { status: "resolved", startedAt: secondsAgo(80), finishedAt: secondsAgo(40), candidates, chosenSourceId: GREENHOUSE.id, error: null },
    source: GREENHOUSE,
    scanTask: { state: "running", startedAt: secondsAgo(12) },
  });
  expect(byKey(steps, "discovery")).toMatchObject({ status: "done", text: "Found the careers page", elapsedMs: 40_000 });
  // The candidate is matched by URL, not by position: the run lists the weaker one first.
  expect(byKey(steps, "source").text).toBe("Found a Greenhouse board (98%)");
  expect(byKey(steps, "scan")).toMatchObject({ status: "running", elapsedMs: 12_000 });
  expect(byKey(steps, "scan").expected).toBe(`usually under a minute · a large board can take the ${deadlineFor("scan_company") / 60_000} minutes a scan is allowed`);
  // The doc's second example line, exactly.
  expect(companySetupLine(steps)).toBe("Found a Greenhouse board (98%) · scanning · 12 s");

  // No run behind the source: its own confidence, and the fact a follower stood behind it.
  const confirmed = narrate({ source: { ...GREENHOUSE, confidence: 1, confirmedByUser: true } });
  expect(byKey(confirmed, "source").text).toBe("Found a Greenhouse board (100%), confirmed by a follower");
  expect(sourceWords("html")).toBe("the company's own careers page");
  expect(sourceWords(null)).toBe("a careers page");
  expect(sourceWords("brand_new_ats")).toBe("a brand_new_ats board");

  // A failing source is still the source; it says how many scans in a row it has lost.
  const failing = narrate({ source: { ...GREENHOUSE, status: "failing", consecutiveFailures: 4 } });
  expect(byKey(failing, "source")).toMatchObject({ status: "attention", note: "It has failed its last 4 scans." });
});

it("reports the scan by what it read, and the table by what this account's gate admitted", () => {
  const scan = { status: "ok" as const, startedAt: secondsAgo(300), postingsFound: 2_331, error: null, durationMs: 42_000 };
  const scoring = narrate({ source: GREENHOUSE, scan, table: { inTable: 4, scoring: 4, scored: 0 } });
  expect(byKey(scoring, "scan")).toMatchObject({ status: "done", elapsedMs: 42_000 });
  expect(byKey(scoring, "scan").text).toBe("Scanned 2,331 postings · 4 match your filters");
  expect(byKey(scoring, "table")).toMatchObject({ status: "running", text: "Scoring 4 roles" });
  // The doc's third example line.
  expect(companySetupLine(scoring)).toBe("Scanned 2,331 postings · 4 match your filters · scoring");

  const scored = narrate({ source: GREENHOUSE, scan, table: { inTable: 4, scoring: 0, scored: 4 } });
  expect(byKey(scored, "table").text).toBe("Scored · next scheduled scan at 06:00 Europe/London");
  expect(companySetupLine(scored)).toBe("Scored · next scheduled scan at 06:00 Europe/London");
  expect(companySetupRunning(scored)).toBe(false);

  // One role the worker has not scored — a spent budget, most often — is said rather than hidden.
  const partlyScored = narrate({ source: GREENHOUSE, scan, table: { inTable: 4, scoring: 0, scored: 3 } });
  expect(byKey(partlyScored, "table").text).toBe("4 roles in your table · next scheduled scan at 06:00 Europe/London");
  expect(byKey(partlyScored, "table").note).toBe("1 role not scored yet.");

  // A gate that admitted nothing is not a broken scan, and says what would change it.
  const nothing = narrate({ source: GREENHOUSE, scan: { ...scan, postingsFound: 1 }, table: { inTable: 0, scoring: 0, scored: 0 } });
  expect(byKey(nothing, "scan").text).toBe("Scanned 1 posting · 0 match your filters");
  expect(byKey(nothing, "table").text).toBe("No roles match your filters yet · next scheduled scan at 06:00 Europe/London");
  expect(byKey(nothing, "table").note).toBe("Widen your keywords or locations on Settings to admit more of this board.");
});

it("says what a scan that failed, shrank or read half a listing did", () => {
  const base = { startedAt: secondsAgo(200), postingsFound: 12, error: null, durationMs: 9_000 };
  const failed = narrate({ source: GREENHOUSE, scan: { ...base, status: "failed", error: "403 from the board" }, table: { inTable: 2, scoring: 0, scored: 2 } });
  expect(byKey(failed, "scan")).toMatchObject({ status: "failed", text: "Could not read the board", note: "403 from the board" });
  // A failed scan closes nothing, so the table step waits rather than claiming to be up to date.
  expect(byKey(failed, "table").text).toBe("Waiting for a scan to read the board");
  expect(companySetupLine(failed)).toBe("Could not read the board");

  const partial = narrate({ source: GREENHOUSE, scan: { ...base, status: "partial", error: "pagination stopped early" }, table: { inTable: 2, scoring: 0, scored: 2 } });
  expect(byKey(partial, "scan")).toMatchObject({ status: "attention", note: "pagination stopped early" });
  expect(byKey(partial, "scan").text).toBe("Read 12 postings of an incomplete listing · 2 match your filters");

  const empty = narrate({ source: GREENHOUSE, scan: { ...base, status: "suspect_empty", postingsFound: 0 }, table: { inTable: 2, scoring: 0, scored: 2 } });
  expect(byKey(empty, "scan")).toMatchObject({ status: "attention", text: "The board returned nothing this time" });
  // The roles already in the table survive it, and the step above says so.
  expect(byKey(empty, "table").text).toBe("Scored · next scheduled scan at 06:00 Europe/London");
});

it("keeps a re-discovery in flight from rewriting the steps behind it", () => {
  // A source is working and discovery is running again: the first step is open, the rest stand.
  const steps = narrate({
    run: { status: "running", startedAt: secondsAgo(15), finishedAt: null, candidates: [], chosenSourceId: null, error: null },
    discoveryTask: { state: "running", startedAt: secondsAgo(15) },
    source: GREENHOUSE,
    scan: { status: "ok", startedAt: secondsAgo(600), postingsFound: 30, error: null, durationMs: 5_000 },
    table: { inTable: 3, scoring: 0, scored: 3 },
  });
  expect(byKey(steps, "discovery").status).toBe("running");
  expect(byKey(steps, "source").text).toBe("Found a Greenhouse board (90%)");
  expect(byKey(steps, "table").text).toBe("Scored · next scheduled scan at 06:00 Europe/London");
  expect(companySetupLine(steps)).toBe("Finding the careers page · 15 s");
});
