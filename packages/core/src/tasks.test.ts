import { describe, expect, it } from "vitest";
import { AGEING_PRIORITY_FLOOR, dedupeKeyFor, deadlineMsFor, INTERACTIVE_TASK_TYPES, priorityFor, TASK_DEADLINES_MS, TASK_TYPE_NAMES, type TaskPayloads, type TaskType } from "./tasks";

describe("task priorities", () => {
  it("floors ageing at the least urgent priority an interactive type is queued at", () => {
    const interactive = INTERACTIVE_TASK_TYPES.map(priorityFor);
    expect(AGEING_PRIORITY_FLOOR).toBe(Math.max(...interactive));
    // A CV build is the slowest thing a person waits for, and the interface queues it at 2.
    expect(priorityFor("generate_cv")).toBe(2);
    expect(AGEING_PRIORITY_FLOOR).toBe(2);
    // The quick requests stay strictly ahead of anything ageing can lift.
    for (const type of ["discover", "import_posting", "review_library", "import_library_document"] as const)
      expect(priorityFor(type)).toBeLessThan(AGEING_PRIORITY_FLOOR);
  });

  it("queues background work behind the floor, so only ageing brings it level", () => {
    for (const type of ["score_job", "fetch_description", "fetch_locations", "scan_company", "synthesize_profile", "suggest_companies"] as const)
      expect(priorityFor(type)).toBeGreaterThan(AGEING_PRIORITY_FLOOR);
  });
});

describe("task dedupe keys and priorities", () => {
  it("keys and ranks one payload of every type exactly as the queue has always stored it", () => {
    const u = "u1", c = "c1";
    const cases: { [T in TaskType]: [TaskPayloads[T], string | null, number] } = {
      extract_document: [{ sourceId: "s1", documentId: "d1" }, "extract_document:d1", 5],
      verify_company: [{ candidateId: "k1" }, "verify_company:k1", 5],
      monitor_source: [{ sourceId: "s1" }, "monitor_source:s1", 5],
      discover: [{ companyId: c }, "discover:c1", 1],
      scan_company: [{ companyId: c }, "scan_company:c1", 5],
      run_daily: [{ trigger: "schedule" }, "run_daily", 5],
      fetch_description: [{ jobId: "j1" }, "fetch_description:j1", 4],
      fetch_locations: [{ jobId: "j1", locationRevision: "r1" }, "fetch_locations:j1:r1", 4],
      score_job: [{ userId: u, jobId: "j1" }, "score_job:u1:j1", 4],
      admit_scores: [{ userId: u, jobIds: ["j1"], requestKey: "h1" }, "admit_scores:u1:h1", 1],
      tag_reason: [{ decisionId: "x1" }, "tag_reason:x1", 1],
      synthesize_profile: [{ userId: u }, "synthesize_profile:u1", 6],
      suggest_filters: [{ userId: u }, "suggest_filters:u1", 6],
      suggest_from_scans: [{ userId: u }, "suggest_from_scans:u1", 6],
      profile_company: [{ companyId: c }, "profile_company:c1", 6],
      suggest_companies: [{ userId: u }, "suggest_companies:u1", 7],
      rescore_all: [{ userId: u }, "rescore_all:u1", 6],
      reevaluate_gate: [{ userId: u, companyId: c }, "reevaluate_gate:u1:c1", 1],
      generate_cv: [{ draftId: "cv1" }, "generate_cv:cv1", 2],
      import_posting: [{ userId: u, companyId: c, url: "https://a.example/j" }, "import_posting:u1:c1:https://a.example/j", 1],
      review_library: [{ userId: u, libraryVersion: 3 }, "review_library:u1", 1],
      import_library_document: [{ userId: u, importId: "i1" }, "import_library_document:i1", 1],
      collect_score_batch: [{}, "collect_score_batch", 4],
      poll_score_batch: [{ batchId: "b1" } as TaskPayloads["poll_score_batch"], "poll_score_batch:b1", 4],
      reencode_logos: [{}, "reencode_logos", 7],
    };
    for (const type of TASK_TYPE_NAMES) {
      const [payload, key, priority] = cases[type];
      expect(dedupeKeyFor(type, payload as never)).toBe(key);
      expect(priorityFor(type)).toBe(priority);
    }
    expect(dedupeKeyFor("discover", { companyId: c, logoOnly: true, homepageUrl: "https://a.example" })).toBe("company_logo:c1:https://a.example");
    expect(dedupeKeyFor("reevaluate_gate", {})).toBe("reevaluate_gate:all");
  });
});

describe("task deadlines", () => {
  it("covers the model calls of extraction, profile synthesis and company suggestions, under ten minutes", () => {
    // Each makes one high-effort call whose answer alone can take longer than the two-minute default.
    expect(deadlineMsFor("extract_document")).toBe(6 * 60_000);
    expect(deadlineMsFor("synthesize_profile")).toBe(5 * 60_000);
    expect(deadlineMsFor("suggest_companies")).toBe(7 * 60_000);
    for (const type of ["extract_document", "synthesize_profile", "suggest_companies"] as const) {
      expect(deadlineMsFor(type)).toBeGreaterThan(TASK_DEADLINES_MS.default);
      expect(deadlineMsFor(type)).toBeLessThanOrEqual(10 * 60_000);
    }
  });

  it("names every task type once", () => {
    expect(new Set(TASK_TYPE_NAMES).size).toBe(TASK_TYPE_NAMES.length);
    expect(TASK_TYPE_NAMES).toHaveLength(25);
  });
});

describe("the CV build deadline", () => {
  it("is the stages' allowances added up, never under three quarters of an hour", async () => {
    const { CV_STAGE_ALLOWANCE_MS, CV_BUILD_DEADLINE_FLOOR_MS, cvBuildDeadlineMs } = await import("./tasks");
    const sum = Object.values(CV_STAGE_ALLOWANCE_MS).reduce((total, ms) => total + ms, 0);
    expect(deadlineMsFor("generate_cv")).toBe(Math.max(CV_BUILD_DEADLINE_FLOOR_MS, sum));
    // Every stage's own stop comes before the deadline, so one runaway stage leaves the rest room.
    for (const ms of Object.values(CV_STAGE_ALLOWANCE_MS)) expect(ms).toBeLessThan(deadlineMsFor("generate_cv"));
    expect(cvBuildDeadlineMs({ rubric: 60_000 })).toBe(CV_BUILD_DEADLINE_FLOOR_MS);
  });
});
