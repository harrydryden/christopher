/**
 * What setting one company up looks like while it is happening, in the words of the CV build
 * narrative: one line per step, present tense while a step is open and past tense once it has
 * closed, with the figures the rows actually recorded.
 *
 * Four steps, and each is driven by rows that already exist:
 *
 * 1. **Discovery** — the newest `discovery_runs` row, or the `discover` task queued before it.
 * 2. **The source** — the `career_sources` row a scan reads, and the confidence the run gave it.
 * 3. **The scan** — the newest `scans` row for that source, and the `scan_company` task in flight.
 * 4. **Your table** — this account's `user_jobs` for the company: what its gate admitted, what is
 *    still queued for a score, and when the next shared scan runs.
 *
 * Nothing here reads the database or the clock beyond the `now` it is given, so every line is a
 * unit test rather than a screenshot. Elapsed time comes from the rows; the expected-duration
 * sentences come from the task deadlines in `@ava/core`, so the interface cannot promise
 * something longer than the worker allows.
 */
import { deadlineFor } from "@ava/core";
import { formatCount, formatStepDuration, pluralize } from "./format";

/** The narrative's tones, as the badges name them. */
export type TimelineTone = "green" | "blue" | "gray" | "amber" | "red";

/**
 * `waiting` has not begun, `running` is open, `done` closed, `attention` closed and needs a
 * person, `failed` stopped. Only `attention` and `failed` are ever red or amber.
 */
export type TimelineStatus = "waiting" | "running" | "done" | "attention" | "failed";

export interface TimelineCandidate {
  type: string | null;
  url: string | null;
  confidence: number | null;
}

export interface TimelineTask {
  state: "queued" | "running";
  /** When the worker claimed it; null while it is still waiting for a slot. */
  startedAt: Date | null;
}

/** The rows one company's timeline is derived from, for one account. */
export interface CompanySetupRows {
  /** The newest discovery run, or null when nobody has ever looked. */
  run: {
    status: "running" | "resolved" | "needs_confirmation" | "not_found" | "failed";
    startedAt: Date;
    finishedAt: Date | null;
    candidates: TimelineCandidate[];
    chosenSourceId: string | null;
    error: string | null;
  } | null;
  /** A `discover` task for this company that has not written its run yet. */
  discoveryTask: TimelineTask | null;
  /** The source a scan reads: the oldest `active` one, else a `failing` one. */
  source: {
    id: string;
    type: string;
    url: string;
    status: string;
    confidence: number;
    confirmedByUser: boolean;
    consecutiveFailures: number;
  } | null;
  /** The newest scan of that source. A scan writes its row when it finishes, never before. */
  scan: {
    status: "ok" | "partial" | "suspect_empty" | "failed";
    startedAt: Date;
    postingsFound: number;
    error: string | null;
    durationMs: number | null;
  } | null;
  /** A `scan_company` task for this company, queued or in flight. */
  scanTask: TimelineTask | null;
  /** This account's own view of the company. Every figure here is per account. */
  table: {
    /** Open postings this account's gate admitted and has not archived. */
    inTable: number;
    /** Of those, the ones whose score is still queued (`user_jobs.score_state`). */
    scoring: number;
    /** Of those, the ones that carry a fit score. */
    scored: number;
  };
}

export interface CompanyTimelineStep {
  key: "discovery" | "source" | "scan" | "table";
  /** The milestone this line belongs to, in the words of the strip beside it. */
  label: string;
  /** The sentence itself. */
  text: string;
  tone: TimelineTone;
  glyph: "✓" | "…" | "✗" | "–" | "!";
  status: TimelineStatus;
  /** When the step opened, for a figure that keeps moving while it is open. */
  startedAt: Date | null;
  /** How long it has taken, or null when there is nothing to time. */
  elapsedMs: number | null;
  /** True while the elapsed figure is still growing. */
  running: boolean;
  /** How long this step usually takes, and the longest the worker will let it run. */
  expected: string | null;
  /** A second line: the error a row recorded, or the one thing left to do. */
  note: string | null;
  /** One word for the compact line: "scanning", "scoring". */
  short: string;
}

export interface TimelineContext {
  /** "next scheduled scan at 06:00 Europe/London", from `nextScanSentence`. */
  nextScan: string;
}

/** "5 minutes" from a deadline in milliseconds. */
function minutes(ms: number): string {
  const n = Math.max(1, Math.round(ms / 60_000));
  return `${n} ${pluralize(n, "minute")}`;
}

/**
 * The expected-duration sentences. The ceiling in each is the task's own deadline from
 * `@ava/core` — the point at which the worker abandons the work — and the usual figure is
 * the smaller one: discovery reads a homepage and two or three link hops, and a scan reads one
 * listing, so both normally finish inside a minute and only a large board needs the rest.
 */
const EXPECTED = {
  discovery: `usually under a minute · discovery gives up after ${minutes(deadlineFor("discover"))}`,
  scan: `usually under a minute · a large board can take the ${minutes(deadlineFor("scan_company"))} a scan is allowed`,
  // Scoring is one model call per role, queued behind everything else the worker is doing, so the
  // figure that matters is the queue rather than the call.
  table: `usually a minute or two · each role is scored on its own`,
};

/** What a source type is in plain words. The board's own name where it has one. */
const SOURCE_WORDS: Readonly<Record<string, string>> = {
  greenhouse: "a Greenhouse board",
  lever: "a Lever board",
  ashby: "an Ashby board",
  workable: "a Workable board",
  smartrecruiters: "a SmartRecruiters board",
  recruitee: "a Recruitee board",
  personio: "a Personio board",
  bamboohr: "a BambooHR board",
  workday: "a Workday site",
  pinpoint: "a Pinpoint board",
  breezy: "a Breezy board",
  teamtailor: "a Teamtailor board",
  icims: "an iCIMS site",
  jobvite: "a Jobvite board",
  jazzhr: "a JazzHR board",
  rippling: "a Rippling board",
  successfactors: "a SuccessFactors site",
  eightfold: "an Eightfold site",
  jsonld: "a structured feed on the company's own careers page",
  rss: "an RSS feed of the company's roles",
  html: "the company's own careers page",
};

export function sourceWords(type: string | null | undefined): string {
  if (!type) return "a careers page";
  return SOURCE_WORDS[type] ?? `a ${type} board`;
}

/** "(98%)", or nothing when no confidence was recorded. */
function confidenceSuffix(confidence: number | null | undefined): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence <= 0) return "";
  return ` (${Math.round(Math.min(1, confidence) * 100)}%)`;
}

const count = (n: number, singular: string, plural?: string): string => `${formatCount(n)} ${pluralize(n, singular, plural)}`;

const GLYPH: Record<TimelineStatus, CompanyTimelineStep["glyph"]> = {
  waiting: "–",
  running: "…",
  done: "✓",
  attention: "!",
  failed: "✗",
};
const TONE: Record<TimelineStatus, TimelineTone> = {
  waiting: "gray",
  running: "blue",
  done: "green",
  attention: "amber",
  failed: "red",
};

function step(
  key: CompanyTimelineStep["key"],
  label: string,
  short: string,
  status: TimelineStatus,
  text: string,
  extra: Partial<Pick<CompanyTimelineStep, "startedAt" | "elapsedMs" | "expected" | "note" | "tone">> = {},
): CompanyTimelineStep {
  return {
    key,
    label,
    short,
    status,
    text,
    tone: extra.tone ?? TONE[status],
    glyph: GLYPH[status],
    startedAt: extra.startedAt ?? null,
    elapsedMs: extra.elapsedMs ?? null,
    running: status === "running",
    expected: extra.expected ?? null,
    note: extra.note ?? null,
  };
}

/** Milliseconds between two instants, never negative and never null when both are known. */
function between(from: Date | null | undefined, to: Date | null | undefined): number | null {
  if (!from || !to) return null;
  return Math.max(0, to.getTime() - from.getTime());
}

function discoveryStep(rows: CompanySetupRows, now: Date): CompanyTimelineStep {
  const { run, discoveryTask, source } = rows;
  const label = "Careers page";
  const short = "looking for the careers page";
  const running = run?.status === "running" || !!discoveryTask;
  if (running) {
    // A task that has not been claimed has no elapsed figure of its own, and a run that is open
    // is timed from the row rather than from the task that opened it.
    const startedAt = run?.status === "running" ? run.startedAt : discoveryTask?.startedAt ?? null;
    return step("discovery", label, short, "running", "Finding the careers page", {
      startedAt,
      elapsedMs: between(startedAt, now),
      expected: EXPECTED.discovery,
      note: !startedAt ? "Queued behind the worker's other work." : null,
    });
  }
  if (source) {
    return step("discovery", label, short, "done", "Found the careers page", {
      startedAt: run?.startedAt ?? null,
      elapsedMs: between(run?.startedAt, run?.finishedAt),
    });
  }
  if (!run) {
    return step("discovery", label, short, "waiting", "Nobody has looked for this company's careers page yet.", {
      expected: EXPECTED.discovery,
    });
  }
  const elapsed = between(run.startedAt, run.finishedAt);
  if (run.status === "needs_confirmation" && run.candidates.length > 0) {
    return step(
      "discovery",
      label,
      short,
      "attention",
      `Discovery found ${count(run.candidates.length, "candidate")}; pick one below or paste the URL.`,
      { startedAt: run.startedAt, elapsedMs: elapsed },
    );
  }
  if (run.status === "not_found") {
    return step("discovery", label, short, "attention", "Discovery found no careers page for this company.", {
      startedAt: run.startedAt,
      elapsedMs: elapsed,
      note: "Paste its careers or board URL, or run discovery again.",
    });
  }
  if (run.status === "failed") {
    return step("discovery", label, short, "failed", "Discovery stopped before it found anything.", {
      startedAt: run.startedAt,
      elapsedMs: elapsed,
      note: run.error ?? "Run discovery again, or paste the URL.",
    });
  }
  // Resolved, or asking with nothing to pick, and yet no source a scan can read: the one it chose
  // has since been disabled or removed.
  return step("discovery", label, short, "attention", "No careers page is in use for this company.", {
    startedAt: run.startedAt,
    elapsedMs: elapsed,
    note: "Paste its careers or board URL, or run discovery again.",
  });
}

function sourceStep(rows: CompanySetupRows): CompanyTimelineStep {
  const { run, source } = rows;
  const label = "Source";
  const short = "reading the board";
  if (source) {
    // The run's own figure for the source it chose — matched by URL, because a run records
    // candidates rather than source ids — else what the source itself recorded.
    const candidate = run?.chosenSourceId === source.id ? run.candidates.find((c) => c.url === source.url) : undefined;
    const chosen = candidate?.confidence ?? source.confidence;
    const confirmed = source.confirmedByUser ? ", confirmed by a follower" : "";
    return step(
      "source",
      label,
      short,
      source.status === "failing" ? "attention" : "done",
      `Found ${sourceWords(source.type)}${confidenceSuffix(chosen)}${confirmed}`,
      {
        note:
          source.status === "failing"
            ? `It has failed its last ${count(source.consecutiveFailures, "scan")}.`
            : null,
      },
    );
  }
  if (run?.status === "needs_confirmation" && run.candidates.length > 0) {
    const best = run.candidates[0];
    return step("source", label, short, "waiting", `Nobody has picked one yet · the strongest is ${sourceWords(best?.type)}${confidenceSuffix(best?.confidence)}`);
  }
  return step("source", label, short, "waiting", "No careers page confirmed yet");
}

function scanStep(rows: CompanySetupRows, now: Date): CompanyTimelineStep {
  const { source, scan, scanTask, table } = rows;
  const label = "Scan";
  const short = "scanning";
  if (scanTask) {
    return step("scan", label, short, "running", "Scanning the board", {
      startedAt: scanTask.startedAt,
      elapsedMs: between(scanTask.startedAt, now),
      expected: EXPECTED.scan,
      note: !scanTask.startedAt ? "Queued behind the worker's other work." : null,
    });
  }
  if (!source) return step("scan", label, short, "waiting", "Waiting for a careers page to read");
  if (!scan) {
    return step("scan", label, short, "waiting", "Not scanned yet", { expected: EXPECTED.scan });
  }
  // "4 match your filters", "1 matches your filters": the figure is the subject of the verb.
  const matched = `${formatCount(table.inTable)} ${pluralize(table.inTable, "matches", "match")} your filters`;
  const timing = { startedAt: scan.startedAt, elapsedMs: scan.durationMs };
  if (scan.status === "failed") {
    return step("scan", label, short, "failed", "Could not read the board", {
      ...timing,
      note: scan.error ?? "The last scan failed.",
    });
  }
  if (scan.status === "suspect_empty") {
    return step("scan", label, short, "attention", "The board returned nothing this time", {
      ...timing,
      note: "The roles already in your table are kept until a scan reads the board again.",
    });
  }
  if (scan.status === "partial") {
    return step("scan", label, short, "attention", `Read ${count(scan.postingsFound, "posting")} of an incomplete listing · ${matched}`, {
      ...timing,
      note: scan.error ?? "The whole listing could not be read, so nothing was closed from it.",
    });
  }
  return step("scan", label, short, "done", `Scanned ${count(scan.postingsFound, "posting")} · ${matched}`, timing);
}

function tableStep(rows: CompanySetupRows, context: TimelineContext): CompanyTimelineStep {
  const { scan, table } = rows;
  const label = "Your table";
  const short = "scoring";
  if (!scan || scan.status === "failed") {
    return step("table", label, short, "waiting", "Waiting for a scan to read the board");
  }
  if (table.scoring > 0) {
    return step("table", label, short, "running", `Scoring ${count(table.scoring, "role")}`, { expected: EXPECTED.table });
  }
  if (table.inTable === 0) {
    return step("table", label, short, "done", `No roles match your filters yet · ${context.nextScan}`, {
      tone: "gray",
      note: "Widen your keywords or locations on Settings to admit more of this board.",
    });
  }
  if (table.scored >= table.inTable) {
    return step("table", label, short, "done", `Scored · ${context.nextScan}`);
  }
  return step("table", label, short, "done", `${count(table.inTable, "role")} in your table · ${context.nextScan}`, {
    tone: "gray",
    note: `${count(table.inTable - table.scored, "role")} not scored yet.`,
  });
}

/** The four steps, in order, for one company and one account. */
export function narrateCompanySetup(rows: CompanySetupRows, now: Date = new Date(), context: TimelineContext): CompanyTimelineStep[] {
  return [discoveryStep(rows, now), sourceStep(rows), scanStep(rows, now), tableStep(rows, context)];
}

/**
 * The one line the timeline collapses to once the company is set up: what last finished, and what
 * is happening now — "Found a Greenhouse board (98%) · scanning".
 */
export function companySetupLine(steps: CompanyTimelineStep[]): string {
  const running = [...steps].reverse().find((s) => s.status === "running");
  if (running) {
    const before = steps.slice(0, steps.indexOf(running)).reverse().find((s) => s.status === "done");
    const elapsed = running.elapsedMs === null ? "" : ` · ${formatStepDuration(running.elapsedMs)}`;
    return before ? `${before.text} · ${running.short}${elapsed}` : `${running.text}${elapsed}`;
  }
  const needing = steps.find((s) => s.status === "attention" || s.status === "failed");
  if (needing) return needing.text;
  const last = [...steps].reverse().find((s) => s.status === "done");
  return last?.text ?? steps[0]!.text;
}

/** Is anything still moving? The page polls, and the elapsed figures tick, only while it is. */
export function companySetupRunning(steps: CompanyTimelineStep[]): boolean {
  return steps.some((s) => s.running);
}
