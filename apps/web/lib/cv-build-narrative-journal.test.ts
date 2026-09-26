/**
 * The narrative against the journal the worker writes now: the motions and figures of the build
 * that publishes its baseline first and improves on it after, the assessment's passes gathered into
 * one row each, attempts told apart by the queue row as well as the attempt number, and a build
 * that stopped reading as stopped. Every sentence is asserted whole: a change here is a change to
 * what the product says.
 */
import { describe, expect, it } from "vitest";
import type { CvJournalStep } from "./cv-build-journal";
import {
  adoptedRevision,
  attemptLabel,
  currentMotionLine,
  cvBuildMilestone,
  cvBuildProgressLine,
  cvBuildRowLabel,
  cvBuildRuns,
  cvBuildTotals,
  cvBuildTotalsLine,
  cvStalledMessage,
  narrateBuild,
  narrateStep,
  type NarrativeItem,
} from "./cv-build-narrative";

const T0 = Date.parse("2026-09-18T18:00:00.000Z");
const s = (seconds: number) => new Date(T0 + seconds * 1000);
const now = s(600);

const STAGES: Record<string, string> = {
  load_inputs: "preparing", admit_budget: "preparing", rubric: "analysing", plan_evidence: "analysing", gap_quiz: "analysing",
  write: "writing", check_plan: "writing", measure: "fitting", shorten: "fitting", rewrite: "fitting",
  assess_batch: "assessing", assess_retry: "assessing", assemble: "assessing", publish: "publishing",
  improve_content: "assessing", compare_content: "assessing", adopt_revision: "publishing",
};
const TITLES: Record<string, string> = {
  measure: "Measuring the PDF against your page limit",
  rewrite: "Rewriting to a smaller budget",
  assess_batch: "Checking requirements and claims against your evidence",
  adopt_revision: "Deciding whether to adopt the revision",
};

let nextSeq = 0;
function step(
  motion: string,
  status: CvJournalStep["status"],
  detail: Record<string, unknown> = {},
  overrides: Partial<CvJournalStep> = {},
): CvJournalStep {
  const seq = overrides.seq ?? ++nextSeq;
  const startedAt = overrides.startedAt ?? s(seq * 10);
  return {
    id: `${motion}-${status}-${seq}`,
    seq,
    attempt: 1,
    taskId: "task-1",
    stage: STAGES[motion] ?? "preparing",
    motion,
    title: TITLES[motion] ?? motion,
    status,
    startedAt,
    finishedAt: status === "running" ? null : new Date(startedAt.getTime() + 2_000),
    ms: status === "running" ? null : 2_000,
    detail,
    error: null,
    failure: null,
    ...overrides,
  };
}
const text = (value: CvJournalStep) => narrateStep(value, now).text;

describe("the journal's wording, motion by motion", () => {
  it("measures the PDF, with the outcome, and leaves out what it did not record", () => {
    expect(text(step("measure", "running", { maxPages: 2 }))).toBe("Measuring the PDF against your page limit");
    expect(text(step("measure", "done", { pages: 3, maxPages: 2, renders: 2, outcome: "overflow" }))).toBe("Measured 3 pages against a limit of 2 · overflow");
    expect(text(step("measure", "done", { pages: 2, maxPages: 2, outcome: "fits" }))).toBe("Measured 2 pages against a limit of 2 · fits");
    expect(text(step("measure", "done", { outcome: "layout_error" }))).toBe("Measured the PDF against your page limit · layout error");
    expect(narrateStep(step("measure", "done", { pages: 3, maxPages: 2, renders: 2 }), now).hint).toBe("2 renders");
    expect(text(step("measure", "failed"))).toBe("Could not measure the PDF against your page limit");
  });

  it("says why a rewrite is paying for a smaller budget", () => {
    expect(text(step("rewrite", "running", { attempt: 2, reason: "overflow", pages: 3, maxPages: 2 }))).toBe(
      "Rewriting to a smaller budget (attempt 2): the draft ran to 3 pages against 2",
    );
    expect(text(step("rewrite", "running", { attempt: 3, reason: "the layout broke" }))).toBe("Rewriting to a smaller budget (attempt 3): the layout broke");
    expect(text(step("rewrite", "running", { attempt: 2 }))).toBe("Rewriting to a smaller budget (attempt 2)");
  });

  it("names what a resumed build kept instead of paying for it again", () => {
    expect(text(step("write", "skipped", { reused: "checkpoint", attempt: 1 }))).toBe("Kept the wording already written in attempt 1");
    expect(text(step("write", "skipped", { reused: "checkpoint" }))).toBe("Kept the wording already written");
    expect(text(step("plan_evidence", "skipped", { reused: true }))).toBe("Reused the confirmed evidence plan from the previous attempt");
    expect(text(step("assemble", "skipped", { reused: true }))).toBe("Kept the assessment already made");
    expect(text(step("assemble", "skipped"))).toBe("Skipped scoring the CV");
  });

  it("reads each assessment batch in its pass, and the revision's pass as a check of the revision", () => {
    const draft = { pass: "draft", index: 1, of: 5, requirements: 8, claims: 3 };
    expect(text(step("assess_batch", "running", draft))).toBe("Checking 8 requirements and 3 claims against your evidence (batch 1 of 5)");
    expect(text(step("assess_batch", "done", draft))).toBe("Checked 8 requirements and 3 claims (batch 1 of 5)");
    const revision = { ...draft, pass: "revision" };
    expect(text(step("assess_batch", "running", revision))).toBe("Checking the revision: 8 requirements and 3 claims against your evidence (batch 1 of 5)");
    expect(text(step("assess_batch", "done", revision))).toBe("Checked the revision: 8 requirements and 3 claims (batch 1 of 5)");
    expect(text(step("assess_batch", "running", { pass: "revision", index: 2, of: 5 }))).toBe("Checking the revision against your evidence (batch 2 of 5)");
    expect(text(step("assess_batch", "failed", { pass: "revision", index: 2, of: 5 }))).toBe("Could not check the revision against your evidence (batch 2 of 5)");
  });

  it("gives a failed batch its reason, and a cancelled sibling its own grey line", () => {
    const failed = narrateStep(
      step("assess_batch", "failed", { pass: "draft", index: 3, of: 5, error: "The model's answer could not be used" }, {
        failure: { kind: "output_invalid", resolvedBy: "system", retryable: true, message: "The model's answer for batch 3 could not be used.", batch: 3 },
      }),
      now,
    );
    expect(failed.text).toBe("Could not check requirements and claims against your evidence (batch 3 of 5)");
    expect(failed.note).toBe("The model's answer for batch 3 could not be used.");
    expect(failed.tone).toBe("red");
    // Without a failure record, the detail's own error is the reason, never nothing.
    expect(narrateStep(step("assess_batch", "failed", { index: 3, of: 5, error: "Stream stalled" }), now).note).toBe("Stream stalled");

    const cancelled = narrateStep(step("assess_batch", "skipped", { pass: "draft", index: 3, of: 5, cancelled: true }), now);
    expect(cancelled.text).toBe("Stopped checking batch 3 of 5: another batch failed");
    expect(cancelled.tone).toBe("gray");
    expect(cancelled.glyph).toBe("–");
  });

  it("tells the improvement pass's outcome without calling a kept original a failure", () => {
    expect(text(step("improve_content", "done", { opportunities: 3, usd: 0.9 }))).toBe("Rewrote with 3 improvements");
    expect(text(step("improve_content", "done", { opportunities: 1 }))).toBe("Rewrote with 1 improvement");
    const kept = narrateStep(step("improve_content", "skipped", { kept: true, reason: "No supported evidence would raise coverage." }), now);
    expect(kept.text).toBe("Tried one targeted revision; kept the original");
    expect(kept.note).toBe("No supported evidence would raise coverage.");
    expect(kept.tone).toBe("gray");
    // A failure of the optional pass runs after the CV was published: grey, never red over a ready CV.
    const failed = narrateStep(step("improve_content", "failed", {}, { error: "overloaded" }), now);
    expect(failed.text).toBe("Tried one targeted revision; kept the original");
    expect(failed.tone).toBe("gray");
    expect(failed.status).toBe("skipped");
  });

  it("says which revision it adopted, or why it kept the original", () => {
    expect(text(step("adopt_revision", "done", { revision: "18-Sep-V4" }))).toBe("Adopted the stronger revision as 18-Sep-V4");
    expect(text(step("adopt_revision", "done", { revision: 4 }))).toBe("Adopted the stronger revision as revision 4");
    expect(text(step("adopt_revision", "done"))).toBe("Adopted the stronger revision");
    expect(text(step("adopt_revision", "skipped", { reason: "The revision weakened an essential requirement." }))).toBe(
      "Kept the original: the revision weakened an essential requirement",
    );
    expect(text(step("adopt_revision", "skipped"))).toBe("Kept the original");
    expect(text(step("adopt_revision", "running"))).toBe("Deciding whether to adopt the revision");
    expect(narrateStep(step("adopt_revision", "failed"), now).tone).toBe("gray");
  });

  it("reserves the budget stage by stage, with what other calls hold", () => {
    expect(text(step("admit_budget", "done", { stage: "writing", expectedUsd: 1.2, leftUsd: 14, limitUsd: 18.4, heldUsd: 0.4 }))).toBe(
      "Reserved US$1.20 of your AI budget for writing (US$14.00 left of US$18.40 this month, US$0.40 held by other calls in flight)",
    );
    expect(text(step("admit_budget", "done", { stage: "improve", expectedUsd: 0.9, leftUsd: 12 }))).toBe(
      "Reserved US$0.90 of your AI budget for the improvement pass (US$12.00 left this month)",
    );
    expect(text(step("admit_budget", "done", { stage: "tailored_completion", expectedUsd: 0.5 }))).toBe(
      "Reserved US$0.50 of your AI budget for tailored completion",
    );
  });

  it("omits the questions it did not count, and never prints zero questions", () => {
    expect(text(step("gap_quiz", "done", { questions: 0 }))).toBe("No further evidence questions needed");
    expect(text(step("gap_quiz", "done", {}))).toBe("Prepared optional questions for you before writing");
    expect(text(step("gap_quiz", "done", { questions: 3 }))).toBe("Prepared 3 optional questions for you before writing");
    expect(text(step("gap_quiz", "failed"))).toBe("Could not prepare the optional evidence questions");
  });

  it("names the motion in a few words for the Applications row", () => {
    expect(cvBuildRowLabel(step("assess_batch", "running", { index: 3, of: 5 }))).toBe("checking batch 3 of 5");
    expect(cvBuildRowLabel(step("assess_batch", "running", { pass: "revision", index: 2, of: 5 }))).toBe("checking the revision, batch 2 of 5");
    expect(cvBuildRowLabel(step("write", "running"))).toBe("writing");
    expect(cvBuildRowLabel(step("measure", "done"))).toBe("measuring the PDF");
    expect(cvBuildRowLabel(step("something_new", "running"))).toBeNull();
  });

  it("counts the minutes of a build that has not moved", () => {
    expect(cvStalledMessage(12 * 60_000 + 5_000)).toBe("No progress for 12 minutes. The worker may be restarting; an administrator can see why in Operations.");
  });
});

const lines = (items: NarrativeItem[]) =>
  items.map((item) =>
    item.kind === "divider" ? `— ${item.label} —` : item.kind === "line" ? `${item.line.glyph} ${item.line.text}${item.line.meta ? ` · ${item.line.meta}` : ""}` : `${item.group.line.glyph} ${item.group.line.text} · ${item.group.line.meta}`,
  );

describe("the narrative's shape", () => {
  it("gathers a pass's batches into one row, whatever order they close in", () => {
    nextSeq = 0;
    const batch = (index: number, status: CvJournalStep["status"], closeAt: number | null, usd?: number) =>
      step("assess_batch", status, { pass: "draft", index, of: 5, requirements: 3, claims: 2, ...(usd ? { usd } : {}) }, {
        startedAt: s(100 + index),
        finishedAt: closeAt === null ? null : s(closeAt),
        ms: closeAt === null ? null : (closeAt - 100 - index) * 1000,
      });
    const steps = [
      step("measure", "done", { pages: 2, maxPages: 2, outcome: "fits" }),
      // Batch 1 opens alone; 3 closes before 2; 4 and 5 still running.
      batch(1, "done", 130, 0.12),
      batch(2, "done", 150, 0.1),
      batch(3, "done", 140, 0.09),
      batch(4, "running", null, undefined),
      batch(5, "running", null, undefined),
    ];
    const items = narrateBuild(steps, s(181));
    expect(lines(items)).toEqual([
      "✓ Measured 2 pages against a limit of 2 · fits · 2.0 s",
      "… Checking requirements and claims against your evidence — 3 of 5 batches done · running 1 min 20 s · US$0.31 so far",
    ]);
    const group = items[1]!.kind === "group" ? items[1]!.group : null;
    expect(group!.batches.map((b) => b.line.text)).toEqual([
      "Checked 3 requirements and 2 claims (batch 1 of 5)",
      "Checked 3 requirements and 2 claims (batch 2 of 5)",
      "Checked 3 requirements and 2 claims (batch 3 of 5)",
      "Checking 3 requirements and 2 claims against your evidence (batch 4 of 5)",
      "Checking 3 requirements and 2 claims against your evidence (batch 5 of 5)",
    ]);
    expect(group!.flagged).toEqual([]);

    // All closed: the row sums what the batches held and times the pass by the clock.
    const closed = steps.map((value) => (value.status === "running" ? { ...value, status: "done" as const, finishedAt: s(170), ms: 60_000 } : value));
    expect(lines(narrateBuild(closed, s(200)))[1]).toBe("✓ Checked 15 requirements and 10 claims against your evidence in 5 batches · 1 min 9 s · US$0.31");
  });

  it("keeps the failed and the cancelled batch in view, and hangs a re-check under its batch", () => {
    nextSeq = 0;
    const steps = [
      step("assess_batch", "done", { index: 1, of: 3 }),
      step("assess_batch", "failed", { index: 2, of: 3 }, { failure: { kind: "stalled", resolvedBy: "system", retryable: true, message: "The model stopped responding.", batch: 2 } }),
      step("assess_batch", "skipped", { index: 3, of: 3, cancelled: true }),
      step("assess_retry", "done", { index: 1, corrections: 2 }),
    ];
    const [item] = narrateBuild(steps, now);
    expect(item!.kind).toBe("group");
    const group = item!.kind === "group" ? item!.group : null;
    expect(group!.line.text).toBe("Could not finish checking requirements and claims against your evidence: batch 2 of 3 failed");
    expect(group!.line.note).toBe("The model stopped responding.");
    expect(group!.line.tone).toBe("red");
    expect(group!.flagged.map((b) => b.line.text)).toEqual([
      "Could not check requirements and claims against your evidence (batch 2 of 3)",
      "Stopped checking batch 3 of 3: another batch failed",
    ]);
    expect(group!.batches[0]!.retries.map((r) => r.text)).toEqual(["Re-checked (batch 1) and corrected 2 findings"]);
  });

  it("gives the revision's re-check its own row, so the second pass does not read as a loop", () => {
    nextSeq = 0;
    const steps = [
      step("assess_batch", "done", { pass: "draft", index: 1, of: 2 }),
      step("assess_batch", "done", { pass: "draft", index: 2, of: 2 }),
      step("assemble", "done", { demonstrated: 5, partial: 0, missing: 0, unknown: 0, supported: 9 }),
      step("publish", "done", { revision: 3 }),
      step("improve_content", "done", { opportunities: 2 }),
      step("assess_batch", "done", { pass: "revision", index: 1, of: 2 }),
      step("assess_batch", "running", { pass: "revision", index: 2, of: 2 }),
    ];
    expect(lines(narrateBuild(steps, s(80))).map((line) => line.split(" · ")[0])).toEqual([
      "✓ Checked requirements and claims against your evidence in 2 batches",
      "✓ Scored: 5 of 5 requirements demonstrated; every claim supported by your evidence",
      "✓ Saved as version revision 3",
      "✓ Rewrote with 2 improvements",
      "… Checking the revision against your evidence — 1 of 2 batches done",
    ]);
  });

  it("files a zombie's row under its own attempt, interrupted, and divides the attempts", () => {
    nextSeq = 0;
    const attempt2 = { attempt: 2 };
    const steps = [
      step("load_inputs", "done", { maxAttempts: 3 }),
      step("write", "done", { attempt: 1 }),
      step("assess_batch", "running", { index: 1, of: 2 }, { startedAt: s(30) }),
      // The queue gave attempt 1 up at its deadline and started attempt 2; attempt 1's process
      // kept going and opened another batch after attempt 2 had begun.
      step("load_inputs", "done", { maxAttempts: 3 }, { ...attempt2, startedAt: s(300) }),
      step("assess_batch", "running", { index: 2, of: 2 }, { startedAt: s(310) }),
      step("write", "skipped", { reused: "checkpoint", attempt: 1 }, { ...attempt2, startedAt: s(320) }),
      step("assess_batch", "running", { index: 1, of: 2 }, { ...attempt2, startedAt: s(330) }),
    ];
    const items = narrateBuild(steps, s(340));
    expect(lines(items)).toEqual([
      "✓ Read your Library · 2.0 s",
      "✓ Wrote the CV · 2.0 s",
      // Attempt 1's pass, gathered with the zombie's batch, and interrupted when attempt 2 began.
      "– Checking requirements and claims against your evidence — 2 batches · Interrupted after 4 min 30 s",
      "— Attempt 2 of 3 —",
      "✓ Read your Library · 2.0 s",
      "– Kept the wording already written in attempt 1",
      "… Checking requirements and claims against your evidence — 2 batches · running 10 s",
    ]);
    expect(cvBuildRuns(steps).map((run) => `${run.attempt}:${run.steps.length}`)).toEqual(["1:4", "2:3"]);
  });

  it("names a retry the person asked for, whose attempts start again at one", () => {
    nextSeq = 0;
    const steps = [
      step("load_inputs", "done", { maxAttempts: 3 }, { taskId: "task-1", attempt: 3 }),
      step("write", "failed", {}, { taskId: "task-1", attempt: 3 }),
      step("load_inputs", "done", { maxAttempts: 3 }, { taskId: "task-2", attempt: 1 }),
      step("write", "done", {}, { taskId: "task-2", attempt: 1 }),
      step("load_inputs", "done", { maxAttempts: 3 }, { taskId: "task-2", attempt: 2 }),
    ];
    expect(lines(narrateBuild(steps, now)).filter((line) => line.startsWith("—"))).toEqual([
      "— Retried by you · attempt 1 of 3 —",
      "— Attempt 2 of 3 —",
    ]);
    // Same attempt number under two tasks is two attempts, not one merged.
    const same = [
      step("load_inputs", "done", {}, { taskId: "task-1", attempt: 1 }),
      step("load_inputs", "done", {}, { taskId: "task-2", attempt: 1 }),
    ];
    expect(lines(narrateBuild(same, now, { maxAttemptsFallback: 3 }))).toContain("— Retried by you · attempt 1 of 3 —");
    expect(attemptLabel(1, 3, true)).toBe("Retried by you · attempt 1 of 3");
    expect(attemptLabel(2, null, true)).toBe("Retried by you · attempt 2");
  });

  it("calls a running row under a stopped build interrupted, with how long it had been open", () => {
    nextSeq = 0;
    const steps = [step("rubric", "done"), step("write", "running", {}, { startedAt: s(60) })];
    const stopped = narrateBuild(steps, s(4000), { interrupted: true, stoppedAt: s(60 + 46 * 60) });
    expect(lines(stopped)[1]).toBe("– Writing the CV · Interrupted after 46 min");
    const [, write] = stopped;
    expect(write!.kind === "line" && write!.line.status).toBe("interrupted");
    // With no moment to measure to, it says so without a figure.
    expect(lines(narrateBuild(steps, s(4000), { interrupted: true }))[1]).toBe("– Writing the CV · Interrupted");
  });
});

describe("what a build came to", () => {
  it("totals each attempt by its own clock and leaves out the days between them", () => {
    nextSeq = 0;
    const day = 86_400;
    const steps = [
      step("rubric", "done", { usd: 0.3 }, { startedAt: s(0), finishedAt: s(50), ms: 50_000 }),
      step("write", "failed", { usd: 1 }, { startedAt: s(60), finishedAt: s(180), ms: 120_000 }),
      // Retried by the person two days later.
      step("load_inputs", "done", {}, { taskId: "task-2", startedAt: s(2 * day), finishedAt: s(2 * day + 1), ms: 1_000 }),
      step("write", "done", { usd: 1.2 }, { taskId: "task-2", startedAt: s(2 * day + 10), finishedAt: s(2 * day + 130), ms: 120_000 }),
      step("publish", "done", { reservedUsd: 3.1, spentUsd: 2.5 }, { taskId: "task-2", startedAt: s(2 * day + 140), finishedAt: s(2 * day + 141), ms: 1_000 }),
    ];
    const totals = cvBuildTotals(steps, s(3 * day));
    // 3 min for the first attempt and 2 min 21 s for the second: not "2 days".
    expect(totals.ms).toBe(180_000 + 141_000);
    expect(cvBuildTotalsLine(totals)).toBe("5 motions in 5 min 21 s, costing US$2.50 of US$3.10 reserved.");
  });

  it("is provisional only while something is working on it", () => {
    nextSeq = 0;
    const steps = [step("rubric", "done", { usd: 0.3 }, { startedAt: s(0), finishedAt: s(50), ms: 50_000 }), step("write", "running", {}, { startedAt: s(60) })];
    expect(cvBuildTotalsLine(cvBuildTotals(steps, s(120), { live: true }))).toBe("2 motions in 2 min, costing US$0.30 so far.");
    expect(cvBuildTotalsLine(cvBuildTotals(steps, s(120)))).toBe("2 motions in 1 min, costing US$0.30.");
  });
});

describe("honest progress", () => {
  const medians = { check_plan: 5_000, measure: 3_000, assess_batch: 50_000, assemble: 2_000, publish: 1_000, write: 90_000 };

  it("lights Optimise when measuring opens, whatever stage the column holds", () => {
    nextSeq = 0;
    const steps = [step("write", "done"), step("check_plan", "done"), step("measure", "running")];
    expect(cvBuildMilestone(steps)).toBe("fitting");
    expect(cvBuildMilestone([...steps, step("publish", "done")])).toBe("publishing");
    expect(cvBuildMilestone([])).toBeNull();
  });

  it("says what is happening now, and how long it usually takes where enough builds have run it", () => {
    nextSeq = 0;
    const writing = [step("rubric", "done"), step("write", "running", {}, { startedAt: s(100) })];
    expect(currentMotionLine(writing, s(146), {}, medians)).toBe("Writing the CV · running 46 s · usually about 1 min 30 s");
    expect(currentMotionLine(writing, s(146))).toBe("Writing the CV · running 46 s");
    const checking = [
      step("write", "done"),
      step("assess_batch", "done", { index: 1, of: 2, usd: 0.2 }, { startedAt: s(100), finishedAt: s(130) }),
      step("assess_batch", "running", { index: 2, of: 2 }, { startedAt: s(101) }),
    ];
    expect(currentMotionLine(checking, s(180), {}, medians)).toBe(
      "Checking requirements and claims against your evidence — 1 of 2 batches done · running 1 min 20 s · US$0.20 so far",
    );
    // Nothing open: the last thing that closed.
    expect(currentMotionLine([step("rubric", "done", { requirements: 4 })], now)).toBe("Extracted 4 requirements");
  });

  it("estimates the time left only once writing has closed, and only from medians it has", () => {
    nextSeq = 0;
    const before = [step("rubric", "done"), step("write", "running", {}, { startedAt: s(100) })];
    expect(cvBuildProgressLine(before, s(120), medians)).toBe("Stage 2 of 4");
    const after = [
      step("write", "done", {}, { startedAt: s(100), finishedAt: s(190) }),
      step("check_plan", "done", {}, { startedAt: s(191), finishedAt: s(192) }),
      step("measure", "running", {}, { startedAt: s(193) }),
    ];
    // measure: 3 s median, 1 s gone → 2 s; assess 50 s; assemble 2 s; publish 1 s.
    expect(cvBuildProgressLine(after, s(194), medians)).toBe("Stage 3 of 4 · about 55 s left");
    // A motion without a median of five runs or more: no estimate at all.
    const { assemble: _assemble, ...partial } = medians;
    expect(cvBuildProgressLine(after, s(194), partial)).toBe("Stage 3 of 4");
    const assessing = [
      ...after.map((value) => (value.status === "running" ? { ...value, status: "done" as const, finishedAt: s(195) } : value)),
      step("assess_batch", "done", { index: 1, of: 5 }, { startedAt: s(200), finishedAt: s(230) }),
      step("assess_batch", "running", { index: 2, of: 5 }, { startedAt: s(231) }),
    ];
    expect(cvBuildProgressLine(assessing, s(241), medians)).toBe("Stage 4 of 4 · 1 of 5 batches done · about 43 s left");
  });

  it("points at the revision the improvement pass adopted", () => {
    nextSeq = 0;
    expect(adoptedRevision([step("adopt_revision", "skipped", { reason: "weaker" })])).toBeNull();
    expect(adoptedRevision([step("adopt_revision", "done", { revision: "18-Sep-V4", draftId: "d-4" })])).toEqual({ name: "18-Sep-V4", draftId: "d-4" });
  });
});
