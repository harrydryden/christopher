/**
 * The narrative against the rows the worker actually writes.
 *
 * The other narrative suites assert sentences for details written by hand, which is how the budget
 * line came to name stages (`planning`, `writing`, `assessing`) that the worker never records. Here
 * every `detail` object is replayed from `apps/worker/src/handlers/cv.ts` — the line each one comes
 * from is named beside it — and the motions, stages and titles come from the core package's own
 * catalogue. Whatever the worker can write, no rendered line may show a raw motion or stage name.
 *
 * When the worker's detail objects change, change the constants here with them.
 */
import { describe, expect, it } from "vitest";
import { CV_BUILD_MOTIONS, CV_BUILD_STAGE_NAMES } from "@ava/core";
import type { CvJournalStep } from "./cv-build-journal";
import {
  currentMotionLine,
  cvBuildProgressLine,
  cvBuildRowLabel,
  cvBuildTotals,
  cvBuildTotalsLine,
  narrateBuild,
  type NarrativeItem,
  type NarratedStep,
} from "./cv-build-narrative";

const T0 = Date.parse("2026-09-18T18:00:00.000Z");
const s = (seconds: number) => new Date(T0 + seconds * 1000);

type Motion = keyof typeof CV_BUILD_MOTIONS | "adopt_revision";
let seq = 0;
function row(
  motion: Motion,
  status: CvJournalStep["status"],
  detail: Record<string, unknown>,
  extra: Partial<CvJournalStep> = {},
): CvJournalStep {
  seq += 1;
  const catalogue = (CV_BUILD_MOTIONS as Record<string, { stage: string; title: string }>)[motion]!;
  const startedAt = extra.startedAt ?? s(seq * 5);
  return {
    id: `${motion}-${seq}`,
    seq,
    attempt: 1,
    taskId: "task-1",
    stage: catalogue.stage,
    motion,
    title: catalogue.title,
    status,
    startedAt,
    finishedAt: status === "running" ? null : new Date(startedAt.getTime() + 4_000),
    ms: status === "running" ? null : 4_000,
    detail,
    error: null,
    failure: null,
    ...extra,
  };
}

/** What `CvJournal.addCost` folds into a step that made a model call. */
const cost = (usd: number) => ({ usd, tokens: Math.round(usd * 40_000) });

/**
 * A build that fails its first audit, is retried by the queue, resumes, publishes, and adopts the
 * optional revision — every motion the worker writes, with the detail it writes.
 */
function workerBuild(): CvJournalStep[] {
  seq = 0;
  const attempt2 = { attempt: 2 };
  return [
    // cv.ts:308 `journal.run("load_inputs", { libraryVersion, descriptionCharacters, mode, maxAttempts })`,
    // then `step.add({ roles, qualifications, skillBlocks, reusedRubric, reusedContent })` at :339.
    row("load_inputs", "done", { libraryVersion: 14, descriptionCharacters: 7742, mode: "build", maxAttempts: 3, roles: 6, qualifications: 2, skillBlocks: 3, reusedRubric: false, reusedContent: false }),
    // cv.ts:378 `journal.run("admit_budget", { stage, expectedUsd })`, closed with
    // `{ limitUsd, heldUsd, leftUsd }` at :399.
    row("admit_budget", "done", { stage: "rubric", expectedUsd: 0.12, limitUsd: 20, heldUsd: 0, leftUsd: 18.2 }),
    // cv.ts:489 `journal.run("rubric", {})`, then `step.add({ requirements, essential, desirable, responsibilities })` at :502.
    row("rubric", "done", { requirements: 14, essential: 6, desirable: 4, responsibilities: 4, ...cost(0.09) }),
    row("admit_budget", "done", { stage: "plan", expectedUsd: 0.2, limitUsd: 20, heldUsd: 0, leftUsd: 18 }),
    // cv.ts:526 `journal.run("plan_evidence", {})`, `step.add({ reused: false, ...planFigures })` at :531.
    row("plan_evidence", "done", { reused: false, requirements: 14, supported: 11, questions: 0, ...cost(0.15) }),
    // cv.ts:551 `journal.record("gap_quiz", { questions, skipped: !gapQuiz })`.
    row("gap_quiz", "done", { questions: 0, skipped: true }),
    row("admit_budget", "done", { stage: "write", expectedUsd: 1.1, limitUsd: 20, heldUsd: 0, leftUsd: 16.9 }),
    // cv.ts:629 `journal.open(writingMotion(1), { attempt, budgetCharacters, budgetScale, maxPages })`,
    // closed with `{ roles, bullets, characters }` at :637.
    row("write", "done", { attempt: 1, budgetCharacters: 2400, budgetScale: 1, maxPages: 2, roles: 6, bullets: 20, characters: 2600, ...cost(0.8) }),
    // cv.ts:646 `journal.record("check_plan", { omitted, skillFormatCorrections })`.
    row("check_plan", "done", { omitted: [], skillFormatCorrections: 0 }),
    // cv.ts:652 `journal.open("measure", { maxPages })`, closed with `{ pages, renders, outcome }` at :654.
    row("measure", "done", { maxPages: 2, pages: 3, renders: 1, outcome: "overflow" }),
    // cv.ts:629 again for attempt 2: `writingMotion(2)` is `rewrite`, with `reason` and `pages`.
    row("rewrite", "done", { attempt: 2, budgetCharacters: 1824, budgetScale: 0.76, maxPages: 2, reason: "overflow", pages: 3, roles: 6, bullets: 15, characters: 1900, ...cost(0.7) }),
    row("measure", "done", { maxPages: 2, pages: 3, renders: 3, outcome: "overflow" }),
    // cv.ts:663 `journal.record("shorten", { removed, pages, changes })`.
    row("shorten", "done", { removed: 2, pages: 2, changes: ["Dropped a 2014 bullet", "Merged two skill lines"] }),
    row("measure", "done", { maxPages: 2, pages: 2, renders: 1, outcome: "fits" }),
    row("admit_budget", "done", { stage: "audit", expectedUsd: 0.6, limitUsd: 20, heldUsd: 0, leftUsd: 14.6 }),
    // cv.ts:769 `journal.open("assess_batch", { batch, batches, index, of, pass, requirements?, claims? }, title)`.
    row("assess_batch", "done", { batch: 1, batches: 3, index: 1, of: 3, pass: "draft", requirements: 5, claims: 9, ...cost(0.1) }, { title: "Checking requirements 1–5 and 9 claims (batch 1 of 3)" }),
    // cv.ts:817 a failed batch closes `failed` with the error and failure on the step.
    row("assess_batch", "failed", { batch: 2, batches: 3, index: 2, of: 3, pass: "draft", requirements: 5, claims: 8, ...cost(0.05) }, {
      title: "Checking requirements 6–10 and 8 claims (batch 2 of 3)",
      error: "The model returned an incomplete assessment (batch 2 of 3)",
    }),
    // cv.ts:813 a sibling cancelled because of it closes `skipped` with `{ cancelled: true }`.
    row("assess_batch", "skipped", { batch: 3, batches: 3, index: 3, of: 3, pass: "draft", requirements: 4, claims: 6, cancelled: true }, { title: "Checking requirements 11–14 and 6 claims (batch 3 of 3)" }),

    // The queue's second attempt resumes from the checkpoint.
    row("load_inputs", "done", { libraryVersion: 14, descriptionCharacters: 7742, mode: "build", maxAttempts: 3, roles: 6, qualifications: 2, skillBlocks: 3, reusedRubric: true, reusedContent: true }, attempt2),
    // cv.ts:326 the saved wording is measured inside `load_inputs`: `{ maxPages }` then `{ pages, renders: 1, outcome }`.
    row("measure", "done", { maxPages: 2, pages: 2, renders: 1, outcome: "fits" }, attempt2),
    // cv.ts:514 a reused rubric is recorded `skipped` with `{ reused }`.
    row("rubric", "skipped", { reused: "checkpoint" }, attempt2),
    row("admit_budget", "done", { stage: "audit", expectedUsd: 0.4, limitUsd: 20, heldUsd: 0, leftUsd: 14.2 }, attempt2),
    row("assess_batch", "done", { batch: 2, batches: 3, index: 2, of: 3, pass: "draft", requirements: 5, claims: 8, ...cost(0.1) }, attempt2),
    // cv.ts:782 a misattributed batch closes done and opens `assess_retry` with `{ batch, index, pass, corrections? }`.
    row("assess_batch", "done", { batch: 3, batches: 3, index: 3, of: 3, pass: "draft", requirements: 4, claims: 6, ...cost(0.08) }, attempt2),
    row("assess_retry", "done", { batch: 3, index: 3, pass: "draft", corrections: 2, ...cost(0.03) }, attempt2),
    // cv.ts:832 `journal.run("assemble", { pageCount })`, `step.add(assessmentTally(review))`.
    row("assemble", "done", { pageCount: 2, demonstrated: 10, partial: 2, missing: 2, unknown: 0, supported: 21, unsupported: 1, uncertain: 0 }, attempt2),
    // cv.ts:881 `journal.open("publish", { revision })`, closed at :896 with `{ archivedPrevious, reservedUsd, spentUsd }`.
    row("publish", "done", { revision: 1, archivedPrevious: false, reservedUsd: 0.4, spentUsd: 2.2 }, attempt2),
    // The optional improvement, after publication.
    row("admit_budget", "done", { stage: "improve", expectedUsd: 0.9, limitUsd: 20, heldUsd: 0, leftUsd: 12.9 }, attempt2),
    // cv.ts:925 `journal.open("improve_content", { opportunities })`, closed done with the same at :952.
    row("improve_content", "done", { opportunities: 2, ...cost(0.6) }, attempt2),
    row("admit_budget", "done", { stage: "reaudit", expectedUsd: 0.3, limitUsd: 20, heldUsd: 0, leftUsd: 12 }, attempt2),
    row("assess_batch", "done", { batch: 1, batches: 1, index: 1, of: 1, pass: "revision", claims: 4, ...cost(0.05) }, attempt2),
    row("assemble", "done", { pageCount: 2, pass: "revision", demonstrated: 12, partial: 1, missing: 1, unknown: 0, supported: 22, unsupported: 0, uncertain: 0 }, attempt2),
    // cv.ts:975 `journal.record("compare_content", { accepted, reasons })`.
    row("compare_content", "done", { accepted: true, reasons: ["Two more essential requirements demonstrated."] }, attempt2),
    // cv.ts:988 `journal.record("adopt_revision", { draftId, revisionId, revision, version, label, name })`.
    row("adopt_revision", "done", { draftId: "00000000-0000-4000-8000-000000000002", revisionId: "00000000-0000-4000-8000-000000000002", revision: 2, version: 3, label: "18-Sep-V3", name: "18-Sep-V3" }, attempt2),
  ];
}

/** The improvement's other endings, each as the worker records it. */
function keptEndings(): CvJournalStep[][] {
  seq = 100;
  return [
    [
      // cv.ts:959 the call failed before the step opened: `record("improve_content", { opportunities, kept, reason }, "skipped")`.
      row("improve_content", "skipped", { opportunities: 2, kept: true, reason: "the optional revision omitted employment or education" }),
      row("compare_content", "done", { accepted: false, reasons: ["The optional revision could not be verified; the checked original was retained."] }),
      // cv.ts:918 `keep(reason)` is `record("adopt_revision", { reason }, "skipped")`.
      row("adopt_revision", "skipped", { reason: "the optional revision omitted employment or education" }),
    ],
    // cv.ts:998 nothing to improve: `record("improve_content", { opportunities: 0, skipped: true, reason }, "skipped")`.
    [row("improve_content", "skipped", { opportunities: 0, skipped: true, reason: "No important evidence available in the Library was omitted." })],
    // cv.ts:544 an evidence plan from the checkpoint, and cv.ts:569 wording from it.
    [row("plan_evidence", "skipped", { reused: true, requirements: 14, supported: 11, questions: 0 }), row("write", "skipped", { reused: "checkpoint", attempt: 2 })],
    // cv.ts:874 a published baseline's assessment taken as it stood.
    [row("assemble", "skipped", { reused: true })],
  ];
}

function linesOf(step: NarratedStep): string[] {
  return [step.text, step.meta, step.note, step.hint, step.stage].filter((part): part is string => !!part);
}

function rendered(items: NarrativeItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === "divider") out.push(item.label);
    else if (item.kind === "line") out.push(...linesOf(item.line));
    else {
      out.push(...linesOf(item.group.line));
      for (const batch of item.group.batches) {
        out.push(...linesOf(batch.line));
        for (const retry of batch.retries) out.push(...linesOf(retry));
      }
    }
  }
  return out;
}

/** Every motion's key and every budget stage's name, as whole words: none may reach the page raw. */
const RAW = [...new Set([...Object.keys(CV_BUILD_MOTIONS), "adopt_revision", ...CV_BUILD_STAGE_NAMES])];
/** English words that are also names, in the phrases the narrative uses them in on purpose. */
const ALLOWED = [/\bevidence plan\b/gi, /\bWrite your CV\b/g];

function rawNamesIn(line: string): string[] {
  let scrubbed = line;
  for (const pattern of ALLOWED) scrubbed = scrubbed.replace(pattern, "");
  return RAW.filter((name) => new RegExp(`(^|[^A-Za-z_])${name}($|[^A-Za-z_])`, "i").test(scrubbed));
}

describe("the narrative over the rows the worker writes", () => {
  it("renders every motion and budget stage in words, never by its raw name", () => {
    const build = workerBuild();
    const offenders: string[] = [];
    const check = (line: string | null) => {
      if (line && rawNamesIn(line).length) offenders.push(`${line}  <- ${rawNamesIn(line).join(", ")}`);
    };
    // The finished build, the log and its totals.
    for (const line of rendered(narrateBuild(build, s(1_000)))) check(line);
    check(cvBuildTotalsLine(cvBuildTotals(build, s(1_000))));
    // Every moment of it while it ran: each prefix with its newest row still open.
    for (let n = 1; n <= build.length; n += 1) {
      const prefix = build.slice(0, n).map((step, i) => (i === n - 1 ? { ...step, status: "running" as const, finishedAt: null, ms: null } : step));
      for (const line of rendered(narrateBuild(prefix, s(1_000)))) check(line);
      check(currentMotionLine(prefix, s(1_000)));
      check(cvBuildProgressLine(prefix, s(1_000)));
      check(cvBuildRowLabel(prefix[n - 1]!));
    }
    for (const ending of keptEndings()) for (const line of rendered(narrateBuild(ending, s(1_000)))) check(line);
    expect(offenders).toEqual([]);
  });

  it("names each budget stage the worker admits", () => {
    const build = workerBuild();
    const reservations = rendered(narrateBuild(build.filter((step) => step.motion === "admit_budget"), s(1_000))).filter((line) => line.startsWith("Reserved"));
    expect(reservations.map((line) => line.replace(/ \(.*\)$/, ""))).toEqual([
      "Reserved US$0.12 of your AI budget for extracting the requirements",
      "Reserved US$0.20 of your AI budget for matching your evidence",
      "Reserved US$1.10 of your AI budget for writing",
      "Reserved US$0.60 of your AI budget for checking",
      "Reserved US$0.40 of your AI budget for checking",
      "Reserved US$0.90 of your AI budget for the improvement pass",
      "Reserved US$0.30 of your AI budget for checking the revision",
    ]);
  });

  it("covers every stage the worker can admit", () => {
    const admitted = new Set(workerBuild().filter((step) => step.motion === "admit_budget").map((step) => step.detail.stage));
    expect([...CV_BUILD_STAGE_NAMES].filter((name) => !admitted.has(name))).toEqual([]);
  });
});
