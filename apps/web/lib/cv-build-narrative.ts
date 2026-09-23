/**
 * What each motion of a CV build says for itself, in one place.
 *
 * The worker writes a `cv_build_steps` row per motion with a `detail` object of figures; this
 * module turns one row into one line of English — present tense while it runs, past tense once it
 * is done, and "could not …" when it failed. Nothing here reads the database or the clock beyond
 * the `now` it is given, so every line is a unit test rather than a screenshot.
 *
 * Rules the lines follow:
 * - Counts are `formatCount` (thousands separators); money is `formatUsdPrecise`, because a single
 *   motion can cost less than a cent and "$0" would be a lie; durations are `formatStepDuration`
 *   ("0.3 s", "52 s", "3 min").
 * - A figure that is missing is left out rather than printed as "0" or "undefined": the worker may
 *   be a release ahead of or behind the interface, and a half-written detail must still read.
 * - An unknown `detail` key is ignored, and an unknown motion falls back to the step's own title.
 */
import type { CvBuildStage, CvBuildStepView } from "@ava/core";
import { formatClock, formatCount, formatPercent, formatStepDuration, formatUsdPrecise, pluralize } from "./format";

/** A subset of the badge tones; the narrative never needs the other two. */
export type NarrativeTone = "green" | "blue" | "gray" | "red";

/**
 * The milestone each motion belongs to, in the words of the strip above the narrative, so a line
 * can be traced to the card it happened under. `preparing` and `publishing` have no card of their
 * own — they are the moments either side of the four.
 */
export const CV_STAGE_LABELS: Record<CvBuildStage, string> = {
  preparing: "Getting ready",
  analysing: "Understand the role",
  writing: "Write your CV",
  fitting: "Optimise",
  assessing: "Check and score",
  publishing: "Save",
};

export interface NarrativeContext {
  /** The deployment's timezone, so the clock times match the rest of the interface. */
  timeZone?: string;
  /** "18-Sep-V3": what the page calls the revision this build published. */
  versionLabel?: string;
}

export interface NarratedStep {
  /** Clock time the motion started, "18:10:25". */
  time: string;
  glyph: "✓" | "…" | "✗" | "–";
  tone: NarrativeTone;
  /** The milestone this line belongs to. */
  stage: string;
  /** The sentence itself. */
  text: string;
  /** Duration and cost, or "running 46 s" while it is open. */
  meta: string;
  /** A second line: the failure message, or what the fitter changed. */
  note: string | null;
  /** Figures worth keeping but not worth the line: tokens, the content budget. Hover text. */
  hint: string | null;
  /** For a screen reader, which the glyph says nothing to. */
  status: CvBuildStepView["status"];
}

const number = (detail: Record<string, unknown>, key: string): number | null => {
  const value = detail[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const text = (detail: Record<string, unknown>, key: string): string | null => {
  const value = detail[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const flag = (detail: Record<string, unknown>, key: string): boolean => detail[key] === true;
const items = (detail: Record<string, unknown>, key: string): unknown[] => {
  const value = detail[key];
  return Array.isArray(value) ? value : [];
};
/** Only the elements that are readable as names; anything else is counted, never printed raw. */
const names = (detail: Record<string, unknown>, key: string): string[] =>
  items(detail, key).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());

const count = (n: number, singular: string, plural?: string): string => `${formatCount(n)} ${pluralize(n, singular, plural)}`;

/** "6 roles, 4 qualifications and 3 skill blocks" from the parts that are actually there. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function lowerFirst(value: string): string {
  return value ? `${value[0]!.toLowerCase()}${value.slice(1)}` : value;
}

/** "(batch 1 of 5)", or nothing when the worker did not say which batch this was. */
function batchSuffix(detail: Record<string, unknown>): string {
  const batch = number(detail, "batch");
  const batches = number(detail, "batches");
  if (batch === null) return "";
  return batches === null ? ` (batch ${formatCount(batch)})` : ` (batch ${formatCount(batch)} of ${formatCount(batches)})`;
}

function assessSubject(detail: Record<string, unknown>): string | null {
  const requirements = number(detail, "requirements");
  const claims = number(detail, "claims");
  const parts = [
    requirements === null ? null : count(requirements, "requirement"),
    claims === null ? null : count(claims, "claim"),
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" and ") : null;
}

/** What a written CV came to: "6 roles, 18 bullets, 1,980 characters". */
function writtenShape(detail: Record<string, unknown>): string | null {
  const parts = [
    number(detail, "roles") === null ? null : count(number(detail, "roles")!, "role"),
    number(detail, "bullets") === null ? null : count(number(detail, "bullets")!, "bullet"),
    number(detail, "characters") === null ? null : count(number(detail, "characters")!, "character"),
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : null;
}

const REUSED_FROM: Record<string, string> = {
  checkpoint: "from the previous attempt",
  parent: "from the parent revision",
  assessment: "from the earlier assessment",
};

/** "Could not …", built from the motion's own title so the two can never drift apart. */
function failedPhrase(step: CvBuildStepView): string {
  switch (step.motion) {
    case "load_inputs":
      return "Could not read your Library and the role";
    case "admit_budget":
      return "Could not reserve this build's share of your AI budget";
    case "rubric":
      return "Could not extract the role's requirements";
    case "write":
      return "Could not write the CV";
    case "check_plan":
      return "Could not check that every role and qualification survived the writing";
    case "measure":
      return "Could not measure the PDF against your page limit";
    case "shorten":
      return "Could not trim the CV to fit your page limit";
    case "rewrite":
      return "Could not rewrite the CV to a smaller budget";
    case "assess_batch":
      return `Could not check requirements and claims against your evidence${batchSuffix(step.detail)}`;
    case "assess_retry":
      return `Could not re-check${batchSuffix(step.detail) || " the batch"}`;
    case "assemble":
      return "Could not score the CV";
    case "publish":
      return "Could not save the CV";
    default:
      return `Could not finish ${lowerFirst(step.title)}`;
  }
}

/** The line a motion the worker skipped leaves behind: what was reused instead of paid for. */
function skippedPhrase(step: CvBuildStepView): string {
  const detail = step.detail;
  switch (step.motion) {
    case "rubric": {
      const from = text(detail, "reused");
      return `Reused the requirements ${(from && REUSED_FROM[from]) ?? "already extracted"}`;
    }
    case "write":
      return "Kept the wording already written";
    case "shorten":
      return "Nothing needed trimming";
    case "measure":
      return "Skipped measuring: the wording has not changed";
    case "assess_retry":
      return "No batch needed re-checking";
    case "improve_content":
      return "No further supported priority evidence needed adding";
    case "gap_quiz":
      return "No extra evidence questions needed";
    default:
      return `Skipped ${lowerFirst(step.title)}`;
  }
}

/** The present-tense line, while the motion is open. */
function runningPhrase(step: CvBuildStepView): string {
  const detail = step.detail;
  switch (step.motion) {
    case "write": {
      const attempt = number(detail, "attempt");
      return attempt !== null && attempt > 1 ? `Writing the CV again (attempt ${formatCount(attempt)})` : "Writing the CV";
    }
    case "rewrite": {
      // The second and third writing attempts are their own motion, each against a smaller budget,
      // so the line says which one is being paid for.
      const attempt = number(detail, "attempt");
      return attempt === null ? step.title : `${step.title} (attempt ${formatCount(attempt)})`;
    }
    case "assess_batch": {
      const subject = assessSubject(detail);
      return subject
        ? `Checking ${subject} against your evidence${batchSuffix(detail)}`
        : `${step.title}${batchSuffix(detail)}`;
    }
    case "assess_retry":
      return `Re-checking${batchSuffix(detail) || " a batch"}, whose evidence was misattributed`;
    default:
      // The motion's own title is already the present tense, and the worker may have set a more
      // specific one for this moment.
      return step.title;
  }
}

/** The past-tense line, with the figures the motion recorded. */
function donePhrase(step: CvBuildStepView, context: NarrativeContext): string {
  const detail = step.detail;
  switch (step.motion) {
    case "plan_evidence": {
      const supported = number(detail, "supported");
      return flag(detail, "reused") ? "Reused the confirmed evidence plan" : `Matched the role to your evidence${supported === null ? "" : `: ${count(supported, "requirement")} ${supported === 1 ? "has" : "have"} supporting evidence`}`;
    }
    case "gap_quiz":
      return flag(detail, "skipped") ? "No further evidence questions needed" : `Prepared ${count(number(detail, "questions") ?? 0, "optional question")} for you before writing`;
    case "improve_content":
      return "Wrote one targeted revision using confirmed evidence already in your Library";
    case "compare_content":
      return flag(detail, "accepted") ? "Kept the stronger revision after checking its evidence and coverage" : "Kept the original CV because the revision did not pass every improvement check";
    case "load_inputs": {
      const version = number(detail, "libraryVersion");
      const shape = [
        number(detail, "roles") === null ? null : count(number(detail, "roles")!, "role"),
        number(detail, "qualifications") === null ? null : count(number(detail, "qualifications")!, "qualification"),
        number(detail, "skillBlocks") === null ? null : count(number(detail, "skillBlocks")!, "skill block"),
      ]
        .filter((part): part is string => part !== null)
        .join(", ");
      const inside = [version === null ? null : `version ${formatCount(version)}`, shape || null].filter((part): part is string => part !== null).join(": ");
      const characters = number(detail, "descriptionCharacters");
      const reused = [
        flag(detail, "reusedRubric") ? "the requirements from the last attempt" : null,
        flag(detail, "reusedContent") ? "the CV already written" : null,
      ].filter((part): part is string => part !== null);
      return [
        `Read your Library${inside ? ` (${inside})` : ""}`,
        characters === null ? "" : ` and the role (${count(characters, "character")})`,
        text(detail, "mode") === "assess" ? ", to fit and assess the wording already saved" : "",
        reused.length ? `, resuming with ${joinList(reused)}` : "",
      ].join("");
    }
    case "admit_budget": {
      const expected = number(detail, "expectedUsd");
      const left = number(detail, "leftUsd");
      const limit = number(detail, "limitUsd");
      const held = number(detail, "heldUsd");
      const inside = [
        left === null ? null : `${formatUsdPrecise(left)} left${limit === null ? "" : ` of ${formatUsdPrecise(limit)}`} this month`,
        held !== null && held > 0 ? `${formatUsdPrecise(held)} held by calls in flight` : null,
      ].filter((part): part is string => part !== null);
      return `Reserved ${expected === null ? "this build's share" : formatUsdPrecise(expected)} of your AI budget${inside.length ? ` (${inside.join(", ")})` : ""}`;
    }
    case "rubric": {
      const requirements = number(detail, "requirements");
      const breakdown = [
        number(detail, "essential") === null ? null : `${formatCount(number(detail, "essential")!)} essential`,
        number(detail, "desirable") === null ? null : `${formatCount(number(detail, "desirable")!)} desirable`,
        number(detail, "responsibilities") === null ? null : `${formatCount(number(detail, "responsibilities")!)} ${pluralize(number(detail, "responsibilities")!, "responsibility", "responsibilities")}`,
      ].filter((part): part is string => part !== null);
      if (requirements === null) return "Extracted the role's requirements";
      return `Extracted ${count(requirements, "requirement")}${breakdown.length ? ` (${breakdown.join(", ")})` : ""}`;
    }
    case "write":
    case "rewrite": {
      const shape = writtenShape(detail);
      const attempt = number(detail, "attempt");
      const opening =
        step.motion === "rewrite"
          ? `Rewrote the CV to a smaller budget${attempt === null ? "" : ` (attempt ${formatCount(attempt)})`}`
          : attempt !== null && attempt > 1
            ? `Wrote the CV again (attempt ${formatCount(attempt)})`
            : "Wrote the CV";
      return shape ? `${opening}: ${shape}` : opening;
    }
    case "check_plan": {
      const omitted = items(detail, "omitted");
      const named = names(detail, "omitted");
      const corrections = number(detail, "skillFormatCorrections") ?? 0;
      const base = omitted.length
        ? `Found ${count(omitted.length, "entry", "entries")} the writer had left out${named.length ? `: ${named.join(", ")}` : ""}`
        : "Checked the writer kept every role and qualification";
      return corrections > 0 ? `${base}; corrected ${count(corrections, "skill label")}` : base;
    }
    case "measure": {
      const pages = number(detail, "pages");
      const maxPages = number(detail, "maxPages");
      if (pages === null) return "Measured the PDF against your page limit";
      return `Measured ${count(pages, "page")}${maxPages === null ? "" : ` against a limit of ${formatCount(maxPages)}`}`;
    }
    case "shorten": {
      const removed = number(detail, "removed");
      const pages = number(detail, "pages");
      return [
        removed === null ? "Trimmed lower-priority wording" : `Trimmed ${count(removed, "piece")} of lower-priority wording`,
        pages === null ? "" : `; the CV now runs to ${count(pages, "page")}`,
      ].join("");
    }
    case "assess_batch": {
      const subject = assessSubject(detail);
      return `Checked ${subject ?? "a batch of requirements and claims"}${batchSuffix(detail)}`;
    }
    case "assess_retry": {
      const corrections = number(detail, "corrections");
      return `Re-checked${batchSuffix(detail) || " the batch"}${corrections === null ? "" : ` and corrected ${count(corrections, "finding")}`}`;
    }
    case "assemble": {
      const demonstrated = number(detail, "demonstrated");
      const partial = number(detail, "partial") ?? 0;
      const missing = number(detail, "missing") ?? 0;
      const unknown = number(detail, "unknown") ?? 0;
      const supported = number(detail, "supported") ?? 0;
      const unsupported = number(detail, "unsupported") ?? 0;
      const uncertain = number(detail, "uncertain") ?? 0;
      if (demonstrated === null) return "Scored the CV";
      const total = demonstrated + partial + missing + unknown;
      const requirements = [
        `${formatCount(demonstrated)} of ${count(total, "requirement")} demonstrated`,
        partial > 0 ? `${formatCount(partial)} partial` : null,
        missing > 0 ? `${formatCount(missing)} missing` : null,
        unknown > 0 ? `${formatCount(unknown)} not judged` : null,
      ].filter((part): part is string => part !== null);
      const claims = [
        unsupported > 0 ? `${count(unsupported, "claim")} unsupported` : null,
        uncertain > 0 ? `${formatCount(uncertain)}${unsupported > 0 ? "" : ` ${pluralize(uncertain, "claim")}`} uncertain` : null,
      ].filter((part): part is string => part !== null);
      const tail = claims.length ? claims.join(" and ") : supported > 0 ? "every claim supported by your evidence" : null;
      return `Scored: ${requirements.join(", ")}${tail ? `; ${tail}` : ""}`;
    }
    case "publish": {
      const revision = number(detail, "revision");
      const label = context.versionLabel ?? (revision === null ? null : `revision ${formatCount(revision)}`);
      return `Saved${label ? ` as version ${label}` : ""}${flag(detail, "archivedPrevious") ? ", archiving the previous revision" : ""}`;
    }
    default:
      return step.title;
  }
}

/** Figures worth keeping off the line itself: tokens, the content budget, the claim tally. */
function hintFor(step: CvBuildStepView): string | null {
  const detail = step.detail;
  const parts: string[] = [];
  const tokens = number(detail, "tokens");
  if (step.motion === "write" || step.motion === "rewrite") {
    const budget = number(detail, "budgetCharacters");
    const scale = number(detail, "budgetScale");
    const maxPages = number(detail, "maxPages");
    if (budget !== null) parts.push(`budget ${count(budget, "character")}${scale !== null && scale > 0 && scale <= 1.5 ? ` at ${formatPercent(scale)} of full length` : ""}`);
    if (maxPages !== null) parts.push(`for ${count(maxPages, "page")}`);
  }
  if (step.motion === "assemble") {
    const supported = number(detail, "supported");
    const pageCount = number(detail, "pageCount");
    if (supported !== null) parts.push(`${count(supported, "claim")} supported`);
    if (pageCount !== null) parts.push(count(pageCount, "page"));
  }
  if (tokens !== null) parts.push(`${count(tokens, "token")}`);
  return parts.length ? parts.join(" · ") : null;
}

const GLYPH = { running: "…", done: "✓", failed: "✗", skipped: "–" } as const;
const TONE: Record<CvBuildStepView["status"], NarrativeTone> = { running: "blue", done: "green", failed: "red", skipped: "gray" };

/**
 * One step, one line. `now` gives a running step its elapsed figure; the page's poll refreshes at
 * least once a minute while anything is open, so the figure keeps moving without a client timer.
 */
export function narrateStep(step: CvBuildStepView, now: Date = new Date(), context: NarrativeContext = {}): NarratedStep {
  const usd = number(step.detail, "usd");
  const elapsedMs = step.status === "running" ? Math.max(0, now.getTime() - step.startedAt.getTime()) : null;
  const meta =
    step.status === "running"
      ? `running ${formatStepDuration(elapsedMs ?? 0)}`
      : [
          // A skipped motion paid for nothing and took no time worth printing.
          step.status === "skipped" || step.ms === null ? null : formatStepDuration(step.ms),
          usd !== null && usd > 0 ? formatUsdPrecise(usd) : null,
        ]
          .filter((part): part is string => part !== null)
          .join(" · ");
  const body =
    step.status === "running"
      ? runningPhrase(step)
      : step.status === "done"
        ? donePhrase(step, context)
        : step.status === "skipped"
          ? skippedPhrase(step)
          : failedPhrase(step);
  const changes = step.motion === "shorten" ? names(step.detail, "changes") : [];
  const note =
    step.status === "failed"
      ? step.failure?.message ?? step.error ?? null
      : changes.length
        ? `${changes.slice(0, 3).join("; ")}${changes.length > 3 ? ` (+${formatCount(changes.length - 3)} more)` : ""}`
        : step.motion === "compare_content" && !flag(step.detail, "accepted")
          ? names(step.detail, "reasons").join(" ") || null
          : null;
  return {
    time: formatClock(step.startedAt, context.timeZone),
    glyph: GLYPH[step.status],
    tone: TONE[step.status],
    stage: CV_STAGE_LABELS[step.stage] ?? step.stage,
    text: body,
    meta,
    note,
    hint: hintFor(step),
    status: step.status,
  };
}

/** "Attempt 2 of 3": the divider before the first step of a later attempt. */
export function attemptLabel(attempt: number, maxAttempts?: number | null): string {
  return maxAttempts ? `Attempt ${formatCount(attempt)} of ${formatCount(maxAttempts)}` : `Attempt ${formatCount(attempt)}`;
}

export interface CvBuildTotals {
  motions: number;
  ms: number;
  usd: number;
  running: boolean;
}

/**
 * What the whole build came to. The elapsed figure is wall clock — first motion opening to last
 * one closing — not the sum of the steps, because the assessment's batches run together and
 * adding them up would bill the reader for time that never passed.
 */
export function cvBuildTotals(steps: CvBuildStepView[], now: Date = new Date()): CvBuildTotals {
  if (!steps.length) return { motions: 0, ms: 0, usd: 0, running: false };
  let first = steps[0]!.startedAt.getTime();
  let last = 0;
  let usd = 0;
  let running = false;
  for (const step of steps) {
    first = Math.min(first, step.startedAt.getTime());
    last = Math.max(last, (step.finishedAt ?? step.startedAt).getTime());
    if (step.status === "running") running = true;
    usd += number(step.detail, "usd") ?? 0;
  }
  if (running) last = Math.max(last, now.getTime());
  return { motions: steps.length, ms: Math.max(0, last - first), usd, running };
}

/** The disclosure's first line: what the build cost and how long it took. */
export function cvBuildTotalsLine(totals: CvBuildTotals): string {
  if (!totals.motions) return "No motions recorded for this build.";
  return `${count(totals.motions, "motion")} in ${formatStepDuration(totals.ms)}${
    totals.usd > 0 ? `, costing ${formatUsdPrecise(totals.usd)}` : ", with no recorded model spend"
  }${totals.running ? " so far" : ""}.`;
}
