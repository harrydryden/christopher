/**
 * What each motion of a CV build says for itself, in one place.
 *
 * The worker writes a `cv_build_steps` row per motion with a `detail` object of figures; this
 * module turns one row into one line of English — present tense while it runs, past tense once it
 * is done, and "could not …" when it failed — and a build's rows into the narrative the page shows:
 * attempts divided, parallel assessment batches gathered under one milestone row, a motion the
 * build stopped in the middle of called interrupted rather than left "running" for ever.
 *
 * Pure and client-safe: nothing here reads the database or the clock beyond the `now` it is given,
 * and nothing imports a value from the core package, so the CV page renders the same lines in the
 * browser from its progress feed as the tests assert here.
 *
 * Rules the lines follow:
 * - Counts are `formatCount` (thousands separators); money is `formatUsdPrecise`, because a single
 *   motion can cost less than a cent and "$0" would be a lie; durations are `formatStepDuration`
 *   ("0.3 s", "52 s", "3 min").
 * - A figure that is missing is left out rather than printed as "0" or "undefined": the worker may
 *   be a release ahead of or behind the interface, and a half-written detail must still read.
 * - An unknown `detail` key is ignored, and an unknown motion falls back to the step's own title.
 */
import type { CvJournalStep } from "./cv-build-journal";
import { formatClock, formatCount, formatPercent, formatStepDuration, formatUsdPrecise, pluralize } from "./format";

/** A subset of the badge tones; the narrative never needs the other two. */
export type NarrativeTone = "green" | "blue" | "gray" | "red";

/**
 * The milestone each motion belongs to, in the words of the strip above the narrative, so a line
 * can be traced to the card it happened under. `preparing` and `publishing` have no card of their
 * own — they are the moments either side of the four.
 */
export const CV_STAGE_LABELS: Record<string, string> = {
  preparing: "Getting ready",
  analysing: "Understand the role",
  writing: "Write your CV",
  fitting: "Optimise",
  assessing: "Check and score",
  publishing: "Save",
};

/** The four milestones the strip shows, in the order a build reaches them. */
export const CV_MILESTONES = ["analysing", "writing", "fitting", "assessing"] as const;
export type CvMilestone = (typeof CV_MILESTONES)[number];

export interface NarrativeContext {
  /** The deployment's timezone, so the clock times match the rest of the interface. */
  timeZone?: string;
  /** "18-Sep-V3": what the page calls the revision this build published. */
  versionLabel?: string;
  /**
   * Nothing is working on this build any more — it stopped or failed — so a motion still marked
   * running was interrupted, and says so, rather than counting up for ever.
   */
  interrupted?: boolean;
  /** When a build that stopped last moved, for "Interrupted after 46 min". */
  stoppedAt?: Date | null;
  /** The page's own reading of the queue's allowance, for an attempt that did not record one. */
  maxAttemptsFallback?: number | null;
  /**
   * Set by the assessment's row for the batches inside it: whether one of them actually failed. A
   * batch the worker closed as cancelled was stopped either because a sibling failed or because the
   * build itself was cut off, and only this says which.
   */
  batchFailed?: boolean;
}

export type NarratedStatus = CvJournalStep["status"] | "interrupted";

export interface NarratedStep {
  key: string;
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
  status: NarratedStatus;
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

/** Which pass of the assessment a batch belongs to: the draft's, or the improvement's revision. */
export function assessPass(step: Pick<CvJournalStep, "detail">): "draft" | "revision" {
  return text(step.detail, "pass") === "revision" ? "revision" : "draft";
}

/**
 * A batch's place in its assessment: `index`/`of` as the worker writes them now, `batch`/`batches`
 * as a worker a release behind wrote them.
 */
export function batchPosition(detail: Record<string, unknown>): { index: number | null; of: number | null } {
  return { index: number(detail, "index") ?? number(detail, "batch"), of: number(detail, "of") ?? number(detail, "batches") };
}

/** "(batch 1 of 5)", or nothing when the worker did not say which batch this was. */
function batchSuffix(detail: Record<string, unknown>): string {
  const { index, of } = batchPosition(detail);
  if (index === null) return "";
  return of === null ? ` (batch ${formatCount(index)})` : ` (batch ${formatCount(index)} of ${formatCount(of)})`;
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

/**
 * What each budget stage is called in the reservation's line: the stages the worker admits
 * (`CV_BUILD_STAGE_NAMES` in the core package — rubric, plan, write, audit, improve, reaudit).
 * An unknown stage reads as its name with the underscores taken out.
 */
const BUDGET_STAGES: Record<string, string> = {
  rubric: "extracting the requirements",
  plan: "matching your evidence",
  write: "writing",
  audit: "checking",
  improve: "the improvement pass",
  reaudit: "checking the revision",
};

function budgetStage(value: string): string {
  return BUDGET_STAGES[value] ?? value.replace(/[_-]+/g, " ");
}

/**
 * The motions that belong to the optional improvement pass. The CV they improve on is already
 * published when they run, so a failure among them is not the build failing: it reads as the
 * original being kept, in grey, never red over a CV that is ready.
 */
const OPTIONAL_MOTIONS = new Set(["improve_content", "compare_content", "adopt_revision"]);

/** The adopted revision's name: the worker's label, the page's, or its revision number. */
function revisionName(detail: Record<string, unknown>): string | null {
  const label = text(detail, "label");
  if (label) return label;
  const revision = detail.revision;
  if (typeof revision === "string" && revision.trim()) return revision.trim();
  if (typeof revision === "number" && Number.isFinite(revision)) return `revision ${formatCount(revision)}`;
  return null;
}

/** "Could not …", built from the motion's own title so the two can never drift apart. */
function failedPhrase(step: CvJournalStep): string {
  switch (step.motion) {
    case "load_inputs":
      return "Could not read your Library and the role";
    case "admit_budget":
      return "Could not reserve this build's share of your AI budget";
    case "rubric":
      return "Could not extract the role's requirements";
    case "plan_evidence":
      return "Could not match the role to your evidence";
    case "gap_quiz":
      return "Could not prepare the optional evidence questions";
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
      return `Could not ${assessPass(step) === "revision" ? "check the revision" : "check requirements and claims"} against your evidence${batchSuffix(step.detail)}`;
    case "assess_retry":
      return `Could not re-check${batchSuffix(step.detail) || " the batch"}`;
    case "assemble":
      return "Could not score the CV";
    case "publish":
      return "Could not save the CV";
    case "improve_content":
    case "compare_content":
      return "Tried one targeted revision; kept the original";
    case "adopt_revision":
      return "Kept the original: the revision could not be adopted";
    default:
      return `Could not finish ${lowerFirst(step.title)}`;
  }
}

/** The line a motion the worker skipped leaves behind: what was reused instead of paid for. */
function skippedPhrase(step: CvJournalStep, context: NarrativeContext = {}): string {
  const detail = step.detail;
  // `cancelled` is what the worker writes on a motion it closed because the build was cut off (or,
  // for an assessment batch, because a sibling failed): it reads as that, never as the motion
  // having had nothing to do.
  const cancelled = flag(detail, "cancelled");
  switch (step.motion) {
    case "rubric": {
      const from = text(detail, "reused");
      return `Reused the requirements ${(from && REUSED_FROM[from]) ?? "already extracted"}`;
    }
    case "plan_evidence":
      return "Reused the confirmed evidence plan from the previous attempt";
    case "write": {
      const attempt = number(detail, "attempt");
      return attempt === null ? "Kept the wording already written" : `Kept the wording already written in attempt ${formatCount(attempt)}`;
    }
    case "shorten":
      return "Nothing needed trimming";
    case "measure":
      return "Skipped measuring: the wording has not changed";
    case "assess_batch": {
      if (cancelled) {
        const { index, of } = batchPosition(detail);
        const which = index === null ? "a batch" : `batch ${formatCount(index)}${of === null ? "" : ` of ${formatCount(of)}`}`;
        return `Stopped checking ${which}: ${context.batchFailed ? "another batch failed" : "the build was interrupted"}`;
      }
      return "Skipped checking requirements and claims against your evidence";
    }
    case "assess_retry":
      return "No batch needed re-checking";
    case "assemble":
      if (cancelled) return "Stopped scoring: the build was interrupted";
      return flag(detail, "reused") ? "Kept the assessment already made" : "Skipped scoring the CV";
    case "improve_content":
      if (cancelled) return "The optional revision was interrupted; kept the original";
      return flag(detail, "kept") ? "Tried one targeted revision; kept the original" : "No further supported priority evidence needed adding";
    case "gap_quiz":
      return "No extra evidence questions needed";
    case "adopt_revision": {
      const reason = text(detail, "reason");
      return reason ? `Kept the original: ${lowerFirst(reason.replace(/\.$/, ""))}` : "Kept the original";
    }
    default:
      return cancelled ? `Interrupted while ${lowerFirst(step.title)}` : `Skipped ${lowerFirst(step.title)}`;
  }
}

/** The present-tense line, while the motion is open. */
function runningPhrase(step: CvJournalStep): string {
  const detail = step.detail;
  switch (step.motion) {
    case "write": {
      const attempt = number(detail, "attempt");
      return attempt !== null && attempt > 1 ? `Writing the CV again (attempt ${formatCount(attempt)})` : "Writing the CV";
    }
    case "rewrite": {
      // The second and third writing attempts are their own motion, each against a smaller budget,
      // so the line says which one is being paid for and why.
      const attempt = number(detail, "attempt");
      const pages = number(detail, "pages");
      const maxPages = number(detail, "maxPages");
      const reason = pages !== null && maxPages !== null
        ? `the draft ran to ${count(pages, "page")} against ${formatCount(maxPages)}`
        : text(detail, "reason");
      return `${step.title}${attempt === null ? "" : ` (attempt ${formatCount(attempt)})`}${reason ? `: ${reason}` : ""}`;
    }
    case "assess_batch": {
      const subject = assessSubject(detail);
      const revision = assessPass(step) === "revision";
      if (!subject) return revision ? `Checking the revision against your evidence${batchSuffix(detail)}` : `${step.title}${batchSuffix(detail)}`;
      return `Checking ${revision ? "the revision: " : ""}${subject} against your evidence${batchSuffix(detail)}`;
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
function donePhrase(step: CvJournalStep, context: NarrativeContext): string {
  const detail = step.detail;
  switch (step.motion) {
    case "plan_evidence": {
      const supported = number(detail, "supported");
      return flag(detail, "reused") ? "Reused the confirmed evidence plan" : `Matched the role to your evidence${supported === null ? "" : `: ${count(supported, "requirement")} ${supported === 1 ? "has" : "have"} supporting evidence`}`;
    }
    case "gap_quiz": {
      // No questions is not "0 questions": it is none being needed.
      const questions = number(detail, "questions");
      if (flag(detail, "skipped") || questions === 0) return "No further evidence questions needed";
      return questions === null ? "Prepared optional questions for you before writing" : `Prepared ${count(questions, "optional question")} for you before writing`;
    }
    case "improve_content": {
      const opportunities = number(detail, "opportunities");
      return opportunities === null || opportunities <= 0
        ? "Wrote one targeted revision using confirmed evidence already in your Library"
        : `Rewrote with ${count(opportunities, "improvement")}`;
    }
    case "compare_content":
      return flag(detail, "accepted") ? "Kept the stronger revision after checking its evidence and coverage" : "Kept the original CV because the revision did not pass every improvement check";
    case "adopt_revision": {
      const name = revisionName(detail);
      return name ? `Adopted the stronger revision as ${name}` : "Adopted the stronger revision";
    }
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
      const stage = text(detail, "stage");
      const inside = [
        left === null ? null : `${formatUsdPrecise(left)} left${limit === null ? "" : ` of ${formatUsdPrecise(limit)}`} this month`,
        // Per stage, what is held excludes this stage's own reservation: other calls in flight.
        held !== null && held > 0 ? `${formatUsdPrecise(held)} held by ${stage ? "other " : ""}calls in flight` : null,
      ].filter((part): part is string => part !== null);
      return `Reserved ${expected === null ? "this build's share" : formatUsdPrecise(expected)} of your AI budget${stage ? ` for ${budgetStage(stage)}` : ""}${inside.length ? ` (${inside.join(", ")})` : ""}`;
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
      const outcome = text(detail, "outcome");
      const said = outcome ? ` · ${outcome.replace(/_/g, " ")}` : "";
      if (pages === null) return `Measured the PDF against your page limit${said}`;
      return `Measured ${count(pages, "page")}${maxPages === null ? "" : ` against a limit of ${formatCount(maxPages)}`}${said}`;
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
      const revision = assessPass(step) === "revision";
      return `Checked ${revision ? "the revision: " : ""}${subject ?? "a batch of requirements and claims"}${batchSuffix(detail)}`;
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
function hintFor(step: CvJournalStep): string | null {
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
  if (step.motion === "measure") {
    const renders = number(detail, "renders");
    if (renders !== null && renders > 0) parts.push(count(renders, "render"));
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

const GLYPH = { running: "…", done: "✓", failed: "✗", skipped: "–", interrupted: "–" } as const;
const TONE: Record<NarratedStatus, NarrativeTone> = { running: "blue", done: "green", failed: "red", skipped: "gray", interrupted: "gray" };

/** "Interrupted after 46 min", or plain "Interrupted" when nothing says how long it had been open. */
function interruptedMeta(startedAt: Date, stoppedAt: Date | null | undefined): string {
  const ms = stoppedAt ? stoppedAt.getTime() - startedAt.getTime() : 0;
  return ms > 0 ? `Interrupted after ${formatStepDuration(ms)}` : "Interrupted";
}

/** The failure's own sentence for a failed step, whichever of the places the worker put it. */
function failureNote(step: CvJournalStep): string | null {
  return step.failure?.message ?? text(step.detail, "error") ?? step.error ?? null;
}

/**
 * One step, one line. `now` gives a running step its elapsed figure; the page keeps it moving with
 * a clock of its own between readings of the progress feed.
 */
export function narrateStep(step: CvJournalStep, now: Date = new Date(), context: NarrativeContext = {}): NarratedStep {
  const usd = number(step.detail, "usd");
  const optional = OPTIONAL_MOTIONS.has(step.motion);
  const status: NarratedStatus =
    step.status === "running" && context.interrupted ? "interrupted" : step.status === "failed" && optional ? "skipped" : step.status;
  const elapsedMs = step.status === "running" ? Math.max(0, now.getTime() - step.startedAt.getTime()) : null;
  const meta =
    status === "interrupted"
      ? interruptedMeta(step.startedAt, context.stoppedAt)
      : step.status === "running"
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
          ? skippedPhrase(step, context)
          : failedPhrase(step);
  const changes = step.motion === "shorten" ? names(step.detail, "changes") : [];
  const reason = optional ? text(step.detail, "reason") : null;
  const note =
    step.status === "failed"
      ? optional ? reason ?? failureNote(step) : failureNote(step)
      : changes.length
        ? `${changes.slice(0, 3).join("; ")}${changes.length > 3 ? ` (+${formatCount(changes.length - 3)} more)` : ""}`
        : step.motion === "compare_content" && !flag(step.detail, "accepted")
          ? names(step.detail, "reasons").join(" ") || null
          : step.motion === "improve_content" && step.status === "skipped" && flag(step.detail, "kept")
            ? reason
            : null;
  return {
    key: step.id,
    time: formatClock(step.startedAt, context.timeZone),
    glyph: GLYPH[status],
    tone: TONE[status],
    stage: CV_STAGE_LABELS[step.stage] ?? step.stage,
    text: body,
    meta,
    note,
    hint: hintFor(step),
    status,
  };
}

/**
 * The divider before a later attempt. A queue retry is the same task trying again ("Attempt 2 of
 * 3"); a retry the person asked for is a new task whose attempts start again at one, and saying
 * "Attempt 1 of 3" after "Attempt 3 of 3" without naming who asked read as the build looping.
 */
export function attemptLabel(attempt: number, maxAttempts?: number | null, manual = false): string {
  const of = maxAttempts ? `${formatCount(attempt)} of ${formatCount(maxAttempts)}` : formatCount(attempt);
  return manual ? `Retried by you · attempt ${of}` : `Attempt ${of}`;
}

/** One attempt of a build: the steps one queue row wrote on one of its attempts. */
export interface CvBuildRun {
  key: string;
  taskId: string | null;
  attempt: number;
  steps: CvJournalStep[];
  /** The queue's allowance, from the attempt's own `load_inputs`, when it recorded one. */
  maxAttempts: number | null;
}

const runKey = (step: Pick<CvJournalStep, "taskId" | "attempt">) => `${step.taskId ?? "-"}:${step.attempt}`;

/**
 * A build's steps split into its attempts, each in the order it ran, the attempts in the order
 * they began. The key is the queue row and its attempt together: a retry the person asked for is a
 * new row starting again at attempt one, and a zombie from an attempt the queue gave up on keeps
 * writing under its own attempt after the next has begun — so neither the attempt number alone nor
 * the order of the rows says which attempt a step belongs to.
 */
export function cvBuildRuns(steps: readonly CvJournalStep[]): CvBuildRun[] {
  const runs = new Map<string, CvBuildRun & { first: number }>();
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    const key = runKey(step);
    let run = runs.get(key);
    if (!run) {
      run = { key, taskId: step.taskId ?? null, attempt: step.attempt, steps: [], maxAttempts: null, first: step.seq };
      runs.set(key, run);
    }
    run.steps.push(step);
    if (step.motion === "load_inputs" && run.maxAttempts === null) run.maxAttempts = number(step.detail, "maxAttempts");
  }
  return [...runs.values()].sort((a, b) => a.first - b.first).map(({ first: _first, ...run }) => run);
}

/** A batch's line with the re-checks that were made of it underneath. */
export interface NarratedBatch {
  line: NarratedStep;
  retries: NarratedStep[];
}

/**
 * One pass of the assessment, gathered: the batches run together, so five interleaved lines said
 * less than one row that counts them.
 */
export interface NarratedGroup {
  key: string;
  line: NarratedStep;
  pass: "draft" | "revision";
  batches: NarratedBatch[];
  /** Failed and cancelled batches, which are shown whether or not the batches are. */
  flagged: NarratedBatch[];
}

export type NarrativeItem =
  | { kind: "divider"; key: string; label: string }
  | { kind: "line"; key: string; line: NarratedStep }
  | { kind: "group"; key: string; group: NarratedGroup };

const ASSESS_MOTIONS = new Set(["assess_batch", "assess_retry"]);

function usdOf(step: CvJournalStep): number {
  return number(step.detail, "usd") ?? 0;
}

/** The milestone row for one pass of the assessment, from the batches and re-checks inside it. */
function narrateGroup(steps: CvJournalStep[], now: Date, context: NarrativeContext, pass: "draft" | "revision"): NarratedGroup {
  const batches = steps.filter((step) => step.motion === "assess_batch");
  const retries = steps.filter((step) => step.motion === "assess_retry");
  const first = steps.reduce((min, step) => (step.startedAt < min.startedAt ? step : min), steps[0]!);
  const running = steps.some((step) => step.status === "running");
  const interrupted = running && !!context.interrupted;
  const failed = steps.some((step) => step.status === "failed");
  const of = batches.reduce<number | null>((max, step) => {
    const value = batchPosition(step.detail).of;
    return value === null ? max : Math.max(max ?? 0, value);
  }, null) ?? (batches.length || null);
  const done = batches.filter((step) => step.status === "done").length;
  const usd = steps.reduce((sum, step) => sum + usdOf(step), 0);
  let last = first.startedAt.getTime();
  for (const step of steps) last = Math.max(last, (step.finishedAt ?? step.startedAt).getTime());
  const subject = pass === "revision" ? "the revision" : "requirements and claims";
  // The totals across batches, but only when every batch said what it held.
  const summed = (key: string) => (batches.length && batches.every((step) => number(step.detail, key) !== null) ? batches.reduce((sum, step) => sum + number(step.detail, key)!, 0) : null);
  const requirements = summed("requirements");
  const claims = summed("claims");
  const held = [requirements === null ? null : count(requirements, "requirement"), claims === null ? null : count(claims, "claim")].filter((part): part is string => part !== null);
  const failedBatch = batches.find((step) => step.status === "failed");
  let text: string;
  let meta: string;
  let status: NarratedStatus;
  if (running) {
    const tally = of === null ? "" : done > 0 ? ` — ${formatCount(done)} of ${count(of, "batch", "batches")} done` : ` — ${count(of, "batch", "batches")}`;
    text = `Checking ${subject} against your evidence${tally}`;
    status = interrupted ? "interrupted" : "running";
    meta = interrupted
      ? interruptedMeta(first.startedAt, context.stoppedAt)
      : [`running ${formatStepDuration(Math.max(0, now.getTime() - first.startedAt.getTime()))}`, usd > 0 ? `${formatUsdPrecise(usd)} so far` : null]
          .filter((part): part is string => part !== null)
          .join(" · ");
  } else {
    const position = failedBatch ? batchPosition(failedBatch.detail) : null;
    const which = position?.index == null ? "a batch" : `batch ${formatCount(position.index)}${position.of === null ? "" : ` of ${formatCount(position.of)}`}`;
    if (failed) {
      text = `Could not finish checking ${subject} against your evidence: ${which} failed`;
      status = "failed";
    } else {
      const heldText = pass === "revision" ? (held.length ? `the revision: ${held.join(" and ")}` : "the revision") : held.length ? held.join(" and ") : "requirements and claims";
      text = `Checked ${heldText} against your evidence${of === null ? "" : ` in ${count(of, "batch", "batches")}`}`;
      status = batches.length && batches.every((step) => step.status === "skipped") ? "skipped" : "done";
    }
    meta = [formatStepDuration(Math.max(0, last - first.startedAt.getTime())), usd > 0 ? formatUsdPrecise(usd) : null].filter((part): part is string => part !== null).join(" · ");
  }
  const batchContext: NarrativeContext = { ...context, batchFailed: failed };
  const narratedBatches: NarratedBatch[] = batches.map((step) => ({ line: narrateStep(step, now, batchContext), retries: [] }));
  const byIndex = new Map<number, NarratedBatch>();
  batches.forEach((step, i) => {
    const index = batchPosition(step.detail).index;
    if (index !== null && !byIndex.has(index)) byIndex.set(index, narratedBatches[i]!);
  });
  for (const retry of retries) {
    const index = batchPosition(retry.detail).index;
    const owner = index === null ? undefined : byIndex.get(index);
    const line = narrateStep(retry, now, batchContext);
    // A re-check of a batch this pass never showed still says what it did, on a line of its own.
    if (owner) owner.retries.push(line);
    else narratedBatches.push({ line, retries: [] });
  }
  const flagged = narratedBatches.filter((batch) => batch.line.status === "failed" || (batch.line.status === "skipped" && batch.line.text.startsWith("Stopped checking")));
  return {
    key: `group:${first.id}`,
    pass,
    batches: narratedBatches,
    flagged,
    line: {
      key: `group:${first.id}`,
      time: formatClock(first.startedAt, context.timeZone),
      glyph: GLYPH[status],
      tone: TONE[status],
      stage: CV_STAGE_LABELS[first.stage] ?? first.stage,
      text,
      meta,
      note: failedBatch ? failureNote(failedBatch) : null,
      hint: null,
      status,
    },
  };
}

/**
 * A build's steps as the narrative shows them: a divider before every attempt after the first,
 * each attempt's motions in the order they ran, and each pass of the assessment gathered into one
 * row with its batches behind it.
 *
 * A motion still marked running in an attempt that has been replaced, or under a build that has
 * stopped (`context.interrupted`), was interrupted; it says so with how long it had been open.
 */
export function narrateBuild(steps: readonly CvJournalStep[], now: Date = new Date(), context: NarrativeContext = {}): NarrativeItem[] {
  const runs = cvBuildRuns(steps);
  const out: NarrativeItem[] = [];
  runs.forEach((run, i) => {
    const latest = i === runs.length - 1;
    const next = runs[i + 1];
    // An attempt the queue has moved past stopped no later than the next one began.
    const runContext: NarrativeContext = latest
      ? context
      : { ...context, interrupted: true, stoppedAt: next ? next.steps[0]!.startedAt : context.stoppedAt };
    if (runs.length > 1 && i > 0) {
      const previous = runs[i - 1]!;
      const manual = !!run.taskId && !!previous.taskId && run.taskId !== previous.taskId;
      out.push({ kind: "divider", key: `divider:${run.key}`, label: attemptLabel(run.attempt, run.maxAttempts ?? context.maxAttemptsFallback ?? null, manual) });
    }
    const groups = new Map<string, CvJournalStep[]>();
    const placed = new Map<string, number>();
    for (const step of run.steps) {
      if (!ASSESS_MOTIONS.has(step.motion)) {
        out.push({ kind: "line", key: step.id, line: narrateStep(step, now, runContext) });
        continue;
      }
      const pass = assessPass(step);
      let members = groups.get(pass);
      if (!members) {
        members = [];
        groups.set(pass, members);
        placed.set(pass, out.length);
        out.push({ kind: "line", key: `pending:${run.key}:${pass}`, line: narrateStep(step, now, runContext) });
      }
      members.push(step);
    }
    for (const [pass, members] of groups) {
      const at = placed.get(pass)!;
      const group = narrateGroup(members, now, runContext, pass as "draft" | "revision");
      out[at] = { kind: "group", key: group.key, group };
    }
  });
  return out;
}

export interface CvBuildTotals {
  motions: number;
  ms: number;
  usd: number;
  running: boolean;
  /**
   * What the build reserved, from its `publish` step, when the worker recorded it — and only when
   * that figure covers everything summed in `usd`. The worker's `reservedUsd` is what the publishing
   * attempt's stages were admitted at before publication, so beside a total that includes an
   * earlier attempt or the improvement pass after publication it would read as a wild overspend.
   */
  reservedUsd: number | null;
}

/**
 * What the whole build came to. The elapsed figure is wall clock within each attempt — first
 * motion opening to last one closing — summed over the attempts, so neither the assessment's
 * batches that ran together nor the days between a failure and its retry are billed as time.
 *
 * `live` says whether anything is still working on the build. Only then is a motion marked running
 * counted up to `now` and the figures called provisional: a finished draft with a row left open by
 * a process that died reads as the total it came to, not "so far" for ever.
 */
export function cvBuildTotals(steps: readonly CvJournalStep[], now: Date = new Date(), options: { live?: boolean } = {}): CvBuildTotals {
  if (!steps.length) return { motions: 0, ms: 0, usd: 0, running: false, reservedUsd: null };
  const runs = cvBuildRuns(steps);
  let ms = 0;
  let usd = 0;
  let running = false;
  let reservedUsd: number | null = null;
  runs.forEach((run, i) => {
    let first = run.steps[0]!.startedAt.getTime();
    let last = 0;
    let open = false;
    for (const step of run.steps) {
      first = Math.min(first, step.startedAt.getTime());
      last = Math.max(last, (step.finishedAt ?? step.startedAt).getTime());
      if (step.status === "running") open = true;
      usd += usdOf(step);
    }
    if (open && options.live && i === runs.length - 1) {
      running = true;
      last = Math.max(last, now.getTime());
    }
    ms += Math.max(0, last - first);
  });
  // One attempt, and publication its last motion: the reservation and the spend cover the same work.
  const only = runs.length === 1 ? runs[0]!.steps : null;
  const publish = only?.[only.length - 1];
  if (publish && publish.motion === "publish") reservedUsd = number(publish.detail, "reservedUsd");
  return { motions: steps.length, ms, usd, running, reservedUsd };
}

/** The disclosure's first line: what the build cost and how long it took. */
export function cvBuildTotalsLine(totals: CvBuildTotals): string {
  if (!totals.motions) return "No motions recorded for this build.";
  const reserved = totals.reservedUsd !== null && totals.reservedUsd > 0 && !totals.running ? ` of ${formatUsdPrecise(totals.reservedUsd)} reserved` : "";
  return `${count(totals.motions, "motion")} in ${formatStepDuration(totals.ms)}${
    totals.usd > 0 ? `, costing ${formatUsdPrecise(totals.usd)}${reserved}` : ", with no recorded model spend"
  }${totals.running ? " so far" : ""}.`;
}

/** Typical durations by motion, in milliseconds, for motions with enough runs to say. */
export type CvMotionMedians = Readonly<Record<string, number>>;

/** Fewer runs than this and a median is an anecdote, so nothing is estimated from it. */
export const CV_MEDIAN_MIN_RUNS = 5;

/** The newest attempt, which is the one anything is still happening in. */
function latestRun(steps: readonly CvJournalStep[]): CvBuildRun | null {
  const runs = cvBuildRuns(steps);
  return runs[runs.length - 1] ?? null;
}

/**
 * What is happening now, in one line, for the strip above the narrative: the open motion — or the
 * pass of the assessment it is part of — with how long it has run and, where enough builds have
 * run it, how long it usually takes. When nothing is open, the last thing that closed.
 */
export function currentMotionLine(
  steps: readonly CvJournalStep[],
  now: Date = new Date(),
  context: NarrativeContext = {},
  medians: CvMotionMedians = {},
): string | null {
  const run = latestRun(steps);
  if (!run) return null;
  const open = [...run.steps].reverse().find((step) => step.status === "running");
  if (open && !context.interrupted) {
    if (ASSESS_MOTIONS.has(open.motion)) {
      const pass = assessPass(open);
      const group = narrateGroup(run.steps.filter((step) => ASSESS_MOTIONS.has(step.motion) && assessPass(step) === pass), now, context, pass);
      return `${group.line.text} · ${group.line.meta}`;
    }
    const line = narrateStep(open, now, context);
    const usual = medians[open.motion];
    return `${line.text} · ${line.meta}${usual ? ` · usually about ${formatStepDuration(usual)}` : ""}`;
  }
  const closed = [...run.steps].reverse().find((step) => step.status !== "running");
  return closed ? narrateStep(closed, now, context).text : null;
}

/**
 * The milestone the strip lights, from what the build is doing rather than from the stage column
 * the worker writes: measuring the PDF is Optimise, whatever the column said. A build that has
 * reached `publishing` has passed every milestone. Null when nothing has been recorded.
 */
export function cvBuildMilestone(steps: readonly CvJournalStep[]): CvMilestone | "publishing" | null {
  const run = latestRun(steps);
  if (!run) return null;
  for (const step of [...run.steps].reverse()) {
    if (step.stage === "publishing") return "publishing";
    if ((CV_MILESTONES as readonly string[]).includes(step.stage)) return step.stage as CvMilestone;
  }
  return null;
}

/** What is left after writing, in the order a build runs it. */
const AFTER_WRITING = ["check_plan", "measure", "assess_batch", "assemble", "publish"] as const;

/**
 * The strip's honest progress: which of the four stages this is, the units of the stage where it
 * has them, and — only once writing has closed, when what remains is predictable — roughly how long
 * is left from the medians of the motions still to run. Nothing is estimated from a motion with
 * fewer than `CV_MEDIAN_MIN_RUNS` runs, and no estimate is better than a wrong one.
 */
export function cvBuildProgressLine(steps: readonly CvJournalStep[], now: Date = new Date(), medians: CvMotionMedians = {}): string | null {
  const milestone = cvBuildMilestone(steps);
  const run = latestRun(steps);
  if (!milestone || !run || milestone === "publishing") return null;
  const parts = [`Stage ${CV_MILESTONES.indexOf(milestone) + 1} of ${CV_MILESTONES.length}`];
  const batches = run.steps.filter((step) => step.motion === "assess_batch");
  const lastPass = batches.length ? assessPass(batches[batches.length - 1]!) : "draft";
  const passBatches = batches.filter((step) => assessPass(step) === lastPass);
  if (milestone === "assessing" && passBatches.length) {
    const of = passBatches.reduce<number | null>((max, step) => {
      const value = batchPosition(step.detail).of;
      return value === null ? max : Math.max(max ?? 0, value);
    }, null) ?? passBatches.length;
    const done = passBatches.filter((step) => step.status === "done").length;
    parts.push(`${formatCount(done)} of ${count(of, "batch", "batches")} done`);
  }
  if (milestone === "writing") {
    const writing = [...run.steps].reverse().find((step) => step.motion === "write" || step.motion === "rewrite");
    const attempt = writing ? number(writing.detail, "attempt") : null;
    if (attempt !== null && attempt > 1) parts.push(`writing attempt ${formatCount(attempt)}`);
  }
  const wrote = run.steps.some((step) => (step.motion === "write" || step.motion === "rewrite") && (step.status === "done" || step.status === "skipped"));
  if (wrote) {
    let remaining = 0;
    let known = true;
    for (const motion of AFTER_WRITING) {
      const own = run.steps.filter((step) => step.motion === motion && (motion !== "assess_batch" || assessPass(step) === lastPass));
      const closed = own.length > 0 && own.every((step) => step.status !== "running") && (motion !== "assess_batch" || own.every((step) => step.status === "done"));
      if (closed) continue;
      const usual = medians[motion];
      if (!usual) {
        known = false;
        break;
      }
      const open = own.find((step) => step.status === "running");
      remaining += open ? Math.max(0, usual - (now.getTime() - open.startedAt.getTime())) : usual;
    }
    if (known && remaining > 0) parts.push(`about ${formatStepDuration(remaining)} left`);
  }
  return parts.join(" · ");
}

/** The revision the improvement pass adopted, once it has, for the link above the log. */
export function adoptedRevision(steps: readonly CvJournalStep[]): { name: string | null; draftId: string | null } | null {
  const adopted = [...steps].reverse().find((step) => step.motion === "adopt_revision" && step.status === "done");
  if (!adopted) return null;
  // TODO(merge P2): the adopted revision's draft id; `revision` is its name or number.
  const draftId = text(adopted.detail, "draftId") ?? text(adopted.detail, "revisionId");
  return { name: revisionName(adopted.detail), draftId };
}

/** The Applications row's few words for what a build is doing: "checking batch 3 of 5". */
export function cvBuildRowLabel(step: Pick<CvJournalStep, "motion" | "detail" | "status">): string | null {
  const position = batchPosition(step.detail);
  const batch = position.index === null ? "" : ` batch ${formatCount(position.index)}${position.of === null ? "" : ` of ${formatCount(position.of)}`}`;
  switch (step.motion) {
    case "load_inputs": return "reading your Library";
    case "admit_budget": return "reserving budget";
    case "rubric": return "reading the role";
    case "plan_evidence": return "matching your evidence";
    case "gap_quiz": return "preparing questions";
    case "write": return "writing";
    case "check_plan": return "checking every role is kept";
    case "measure": return "measuring the PDF";
    case "shorten": return "trimming to fit";
    case "rewrite": return "rewriting to fit";
    case "assess_batch": return assessPass(step) === "revision" ? `checking the revision${batch ? `,${batch}` : ""}` : batch ? `checking${batch}` : "checking against your evidence";
    case "assess_retry": return "re-checking a batch";
    case "assemble": return "scoring";
    case "publish": return "saving";
    case "improve_content": return "trying a stronger revision";
    case "compare_content": return "comparing the revision";
    case "adopt_revision": return "deciding on the revision";
    default: return null;
  }
}

/** A build that has not moved for ten minutes or more, in whole minutes. */
export function cvStalledMessage(sinceProgressMs: number): string {
  const minutes = Math.floor(Math.max(0, sinceProgressMs) / 60_000);
  return `No progress for ${minutes} minutes. The worker may be restarting; an administrator can see why in Operations.`;
}
