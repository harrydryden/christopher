/**
 * The build narrative's wording, one motion at a time. These are the sentences the person reads
 * while a CV is being written, so they are asserted whole rather than by fragment: a change here
 * is a change to what the product says.
 */
import { expect, it } from "vitest";
import type { CvBuildMotion, CvBuildStepStatus, CvBuildStepView } from "@christopher/core";
import { CV_BUILD_MOTIONS } from "@christopher/core";
import { attemptLabel, cvBuildTotals, cvBuildTotalsLine, narrateStep } from "./cv-build-narrative";

const now = new Date("2026-09-18T18:12:00.000Z");
const at = (iso: string) => new Date(iso);

function step(
  motion: CvBuildMotion,
  status: CvBuildStepStatus,
  detail: Record<string, unknown> = {},
  overrides: Partial<CvBuildStepView> = {},
): CvBuildStepView {
  return {
    id: `${motion}-${status}`,
    seq: 1,
    attempt: 1,
    stage: CV_BUILD_MOTIONS[motion].stage,
    motion,
    title: CV_BUILD_MOTIONS[motion].title,
    status,
    startedAt: at("2026-09-18T18:10:25.000Z"),
    finishedAt: status === "running" ? null : at("2026-09-18T18:10:25.300Z"),
    ms: status === "running" ? null : 300,
    detail,
    error: null,
    failure: null,
    ...overrides,
  };
}

const line = (value: ReturnType<typeof narrateStep>) => `${value.time} ${value.glyph} ${value.text}${value.meta ? ` · ${value.meta}` : ""}`;

it("reads the library and the role, with the version, the shape and the description's size", () => {
  const read = narrateStep(
    step("load_inputs", "done", { libraryVersion: 14, roles: 6, qualifications: 4, skillBlocks: 3, descriptionCharacters: 7742 }),
    now,
  );
  expect(line(read)).toBe(
    "18:10:25 ✓ Read your Library (version 14: 6 roles, 4 qualifications, 3 skill blocks) and the role (7,742 characters) · 0.3 s",
  );
  expect(read.stage).toBe("Getting ready");
  expect(read.tone).toBe("green");

  // A resumed build says what it is not paying for again, and an assess-only build says so too.
  expect(
    narrateStep(step("load_inputs", "done", { libraryVersion: 14, roles: 1, qualifications: 1, skillBlocks: 1, mode: "assess", reusedRubric: true, reusedContent: true }), now).text,
  ).toBe(
    "Read your Library (version 14: 1 role, 1 qualification, 1 skill block), to fit and assess the wording already saved, resuming with the requirements from the last attempt and the CV already written",
  );
  // A detail the worker has not written yet leaves the clause out rather than printing "0".
  expect(narrateStep(step("load_inputs", "done", {}), now).text).toBe("Read your Library");
  expect(narrateStep(step("load_inputs", "running"), now).text).toBe("Reading your Library and the role");
  expect(narrateStep(step("load_inputs", "failed"), now).text).toBe("Could not read your Library and the role");
});

it("names what the budget reservation took and what it left", () => {
  expect(narrateStep(step("admit_budget", "done", { expectedUsd: 3.06, leftUsd: 18.4, limitUsd: 50, heldUsd: 0 }), now).text).toBe(
    "Reserved US$3.06 of your AI budget (US$18.40 left of US$50.00 this month)",
  );
  expect(narrateStep(step("admit_budget", "done", { expectedUsd: 3.06, leftUsd: 18.4, heldUsd: 2 }), now).text).toBe(
    "Reserved US$3.06 of your AI budget (US$18.40 left this month, US$2.00 held by calls in flight)",
  );
  expect(narrateStep(step("admit_budget", "running"), now).text).toBe("Reserving this build's share of your AI budget");
  const refused = narrateStep(
    step("admit_budget", "failed", {}, {
      error: "budget",
      failure: { kind: "budget_exhausted", resolvedBy: "user", retryable: false, action: "raise_budget", message: "This build needs $3.06 and $1.20 is left of your $50.00 budget this month." },
    }),
    now,
  );
  expect(refused.text).toBe("Could not reserve this build's share of your AI budget");
  expect(refused.note).toBe("This build needs $3.06 and $1.20 is left of your $50.00 budget this month.");
  expect(refused.glyph).toBe("✗");
  expect(refused.tone).toBe("red");
});

it("counts the requirements it extracted, and says where reused ones came from", () => {
  const extracted = narrateStep(
    step("rubric", "done", { requirements: 12, essential: 5, desirable: 4, responsibilities: 3, usd: 0.28, tokens: 23_120 }, { ms: 52_000 }),
    now,
  );
  expect(line(extracted)).toBe("18:10:25 ✓ Extracted 12 requirements (5 essential, 4 desirable, 3 responsibilities) · 52 s · US$0.28");
  expect(extracted.hint).toBe("23,120 tokens");
  expect(narrateStep(step("rubric", "running"), now).text).toBe("Extracting the role's requirements");
  expect(narrateStep(step("rubric", "skipped", { reused: "checkpoint" }), now).text).toBe("Reused the requirements from the previous attempt");
  expect(narrateStep(step("rubric", "skipped", { reused: "parent" }), now).text).toBe("Reused the requirements from the parent revision");
  expect(narrateStep(step("rubric", "skipped", { reused: "assessment" }), now).text).toBe("Reused the requirements from the earlier assessment");
  expect(narrateStep(step("rubric", "skipped", {}), now).text).toBe("Reused the requirements already extracted");
  // A skipped motion paid for nothing, so it carries no duration.
  expect(narrateStep(step("rubric", "skipped", { reused: "parent" }), now).meta).toBe("");
  expect(narrateStep(step("rubric", "failed"), now).text).toBe("Could not extract the role's requirements");
});

it("says what the writer produced, and keeps its content budget as a hint", () => {
  const wrote = narrateStep(
    step("write", "done", { attempt: 1, budgetCharacters: 2400, budgetScale: 0.8, maxPages: 2, roles: 6, bullets: 18, characters: 1980, usd: 1.17, tokens: 40_000 }, { ms: 180_000 }),
    now,
  );
  expect(line(wrote)).toBe("18:10:25 ✓ Wrote the CV: 6 roles, 18 bullets, 1,980 characters · 3 min · US$1.17");
  expect(wrote.hint).toBe("budget 2,400 characters at 80% of full length · for 2 pages · 40,000 tokens");
  expect(narrateStep(step("write", "running"), now).text).toBe("Writing the CV");
  expect(narrateStep(step("write", "running", { attempt: 2 }), now).text).toBe("Writing the CV again (attempt 2)");
  expect(narrateStep(step("write", "done", { attempt: 2, roles: 6, bullets: 16, characters: 1740 }), now).text).toBe(
    "Wrote the CV again (attempt 2): 6 roles, 16 bullets, 1,740 characters",
  );
  expect(narrateStep(step("write", "skipped"), now).text).toBe("Kept the wording already written");
  expect(narrateStep(step("write", "failed"), now).text).toBe("Could not write the CV");
});

it("reports the plan check, including the entries the writer dropped", () => {
  expect(narrateStep(step("check_plan", "done", { omitted: [], skillFormatCorrections: 0 }), now).text).toBe(
    "Checked the writer kept every role and qualification",
  );
  expect(narrateStep(step("check_plan", "done", { omitted: ["Acme Ltd", "BSc Chemistry"], skillFormatCorrections: 3 }), now).text).toBe(
    "Found 2 entries the writer had left out: Acme Ltd, BSc Chemistry; corrected 3 skill labels",
  );
  // Entries the worker records as objects are counted, never printed as raw JSON.
  expect(narrateStep(step("check_plan", "done", { omitted: [{ id: "role-1" }] }), now).text).toBe("Found 1 entry the writer had left out");
  expect(narrateStep(step("check_plan", "running"), now).text).toBe("Checking the writer kept every role and qualification");
  expect(narrateStep(step("check_plan", "skipped"), now).text).toBe("Skipped checking the writer kept every role and qualification");
  expect(narrateStep(step("check_plan", "failed"), now).text).toBe("Could not check that every role and qualification survived the writing");
});

it("measures, trims and rewrites in the reader's units", () => {
  expect(narrateStep(step("measure", "done", { pages: 2, maxPages: 2 }), now).text).toBe("Measured 2 pages against a limit of 2");
  expect(narrateStep(step("measure", "running"), now).text).toBe("Measuring the PDF against your page limit");
  expect(narrateStep(step("measure", "skipped"), now).text).toBe("Skipped measuring: the wording has not changed");
  expect(narrateStep(step("measure", "failed"), now).text).toBe("Could not measure the PDF against your page limit");

  const trimmed = narrateStep(step("shorten", "done", { removed: 4, pages: 2, changes: ["Dropped the interests block", "Shortened two bullets on Acme Ltd"] }), now);
  expect(trimmed.text).toBe("Trimmed 4 pieces of lower-priority wording; the CV now runs to 2 pages");
  expect(trimmed.note).toBe("Dropped the interests block; Shortened two bullets on Acme Ltd");
  expect(narrateStep(step("shorten", "running"), now).text).toBe("Trimming lower-priority wording to fit");
  expect(narrateStep(step("shorten", "skipped"), now).text).toBe("Nothing needed trimming");
  expect(narrateStep(step("shorten", "failed"), now).text).toBe("Could not trim the CV to fit your page limit");

  expect(narrateStep(step("rewrite", "done", { roles: 6, bullets: 14, characters: 1500 }), now).text).toBe(
    "Rewrote the CV to a smaller budget: 6 roles, 14 bullets, 1,500 characters",
  );
  expect(narrateStep(step("rewrite", "running"), now).text).toBe("Rewriting to a smaller budget");
  expect(narrateStep(step("rewrite", "skipped"), now).text).toBe("No rewrite was needed");
  expect(narrateStep(step("rewrite", "failed"), now).text).toBe("Could not rewrite the CV to a smaller budget");
});

it("counts a batch's requirements and claims, and its position in the assessment", () => {
  const running = narrateStep(step("assess_batch", "running", { batch: 1, batches: 5, requirements: 8, claims: 23 }), new Date("2026-09-18T18:11:11.000Z"));
  expect(line(running)).toBe("18:10:25 … Checking 8 requirements and 23 claims against your evidence (batch 1 of 5) · running 46 s");
  expect(running.tone).toBe("blue");
  expect(narrateStep(step("assess_batch", "done", { batch: 1, batches: 5, requirements: 8, claims: 23, usd: 0.12 }), now).text).toBe(
    "Checked 8 requirements and 23 claims (batch 1 of 5)",
  );
  expect(narrateStep(step("assess_batch", "done", {}), now).text).toBe("Checked a batch of requirements and claims");
  expect(narrateStep(step("assess_batch", "skipped", { batch: 2, batches: 5 }), now).text).toBe(
    "Skipped checking requirements and claims against your evidence",
  );
  expect(narrateStep(step("assess_batch", "failed", { batch: 2, batches: 5 }), now).text).toBe(
    "Could not check requirements and claims against your evidence (batch 2 of 5)",
  );

  expect(narrateStep(step("assess_retry", "running", { batch: 2 }), now).text).toBe("Re-checking (batch 2), whose evidence was misattributed");
  expect(narrateStep(step("assess_retry", "done", { batch: 2, corrections: 3, usd: 0.09 }), now).text).toBe("Re-checked (batch 2) and corrected 3 findings");
  expect(narrateStep(step("assess_retry", "skipped"), now).text).toBe("No batch needed re-checking");
  expect(narrateStep(step("assess_retry", "failed", { batch: 2 }), now).text).toBe("Could not re-check (batch 2)");
});

it("scores the CV in requirements and claims, not in percentages", () => {
  const scored = narrateStep(
    step("assemble", "done", { demonstrated: 7, partial: 3, missing: 2, unknown: 0, supported: 25, unsupported: 0, uncertain: 2, pageCount: 2 }, { ms: 1_200 }),
    now,
  );
  expect(line(scored)).toBe("18:10:25 ✓ Scored: 7 of 12 requirements demonstrated, 3 partial, 2 missing; 2 claims uncertain · 1.2 s");
  expect(scored.hint).toBe("25 claims supported · 2 pages");
  expect(
    narrateStep(step("assemble", "done", { demonstrated: 12, partial: 0, missing: 0, unknown: 0, supported: 27, unsupported: 0, uncertain: 0, pageCount: 2 }), now).text,
  ).toBe("Scored: 12 of 12 requirements demonstrated; every claim supported by your evidence");
  expect(
    narrateStep(step("assemble", "done", { demonstrated: 5, partial: 1, missing: 1, unknown: 1, supported: 20, unsupported: 2, uncertain: 1 }), now).text,
  ).toBe("Scored: 5 of 8 requirements demonstrated, 1 partial, 1 missing, 1 not judged; 2 claims unsupported and 1 uncertain");
  expect(narrateStep(step("assemble", "running"), now).text).toBe("Scoring the CV");
  expect(narrateStep(step("assemble", "skipped"), now).text).toBe("Skipped scoring the CV");
  expect(narrateStep(step("assemble", "failed"), now).text).toBe("Could not score the CV");
});

it("saves the revision under the version label the page shows", () => {
  expect(narrateStep(step("publish", "done", { revision: 3, archivedPrevious: true }), now, { versionLabel: "18-Sep-V3" }).text).toBe(
    "Saved as version 18-Sep-V3, archiving the previous revision",
  );
  // Without the page's label, the draft's own revision number is the honest fallback.
  expect(narrateStep(step("publish", "done", { revision: 3 }), now).text).toBe("Saved as version revision 3");
  expect(narrateStep(step("publish", "running"), now).text).toBe("Saving the CV");
  expect(narrateStep(step("publish", "skipped"), now).text).toBe("Skipped saving the CV");
  expect(narrateStep(step("publish", "failed"), now).text).toBe("Could not save the CV");
});

it("gives every motion a line in every status, whatever the detail", () => {
  const motions = Object.keys(CV_BUILD_MOTIONS) as CvBuildMotion[];
  for (const motion of motions) {
    for (const status of ["running", "done", "failed", "skipped"] as CvBuildStepStatus[]) {
      const narrated = narrateStep(step(motion, status), now);
      expect(narrated.text.length, `${motion}/${status}`).toBeGreaterThan(0);
      expect(narrated.text, `${motion}/${status}`).not.toMatch(/undefined|null|NaN|\[object/);
      expect(narrated.time).toBe("18:10:25");
      expect(narrated.stage.length).toBeGreaterThan(0);
    }
  }
});

it("reads clock times in the deployment's timezone", () => {
  expect(narrateStep(step("publish", "done"), now, { timeZone: "Europe/London" }).time).toBe("19:10:25");
  expect(narrateStep(step("publish", "done"), now, { timeZone: "UTC" }).time).toBe("18:10:25");
});

it("totals a build by wall clock, not by adding up batches that ran together", () => {
  const steps = [
    step("rubric", "done", { usd: 0.28 }, { seq: 1, startedAt: at("2026-09-18T18:10:00.000Z"), finishedAt: at("2026-09-18T18:10:52.000Z"), ms: 52_000 }),
    // Two batches that overlapped: 40 seconds passed, not 80.
    step("assess_batch", "done", { usd: 0.12, batch: 1, batches: 2 }, { seq: 2, startedAt: at("2026-09-18T18:11:00.000Z"), finishedAt: at("2026-09-18T18:11:40.000Z"), ms: 40_000 }),
    step("assess_batch", "done", { usd: 0.1, batch: 2, batches: 2 }, { seq: 3, startedAt: at("2026-09-18T18:11:00.000Z"), finishedAt: at("2026-09-18T18:11:40.000Z"), ms: 40_000 }),
  ];
  const totals = cvBuildTotals(steps, now);
  expect(totals).toMatchObject({ motions: 3, ms: 100_000, running: false });
  expect(totals.usd).toBeCloseTo(0.5, 5);
  expect(cvBuildTotalsLine(totals)).toBe("3 motions in 1 min 40 s, costing US$0.50.");

  // A build still running counts up to now, and says the figures are not final.
  const open = cvBuildTotals([...steps, step("assemble", "running", {}, { seq: 4, startedAt: at("2026-09-18T18:11:50.000Z") })], now);
  expect(cvBuildTotalsLine(open)).toBe("4 motions in 2 min, costing US$0.50 so far.");
  expect(cvBuildTotalsLine(cvBuildTotals([], now))).toBe("No motions recorded for this build.");
});

it("labels a later attempt with its place in the queue's allowance", () => {
  expect(attemptLabel(2, 3)).toBe("Attempt 2 of 3");
  expect(attemptLabel(2, null)).toBe("Attempt 2");
});
