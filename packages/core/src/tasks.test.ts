import { describe, expect, it } from "vitest";
import { AGEING_PRIORITY_FLOOR, deadlineMsFor, INTERACTIVE_TASK_TYPES, priorityFor, SHORT_TASK_DEADLINE_MS, SHORT_TASK_TYPES, TASK_DEADLINES_MS, TASK_TYPE_NAMES } from "./tasks";

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
    for (const type of ["score_job", "fetch_description", "scan_company", "synthesize_profile", "suggest_companies"] as const)
      expect(priorityFor(type)).toBeGreaterThan(AGEING_PRIORITY_FLOOR);
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

  it("names as short exactly the types whose deadline fits a serverless invocation", () => {
    expect(new Set(TASK_TYPE_NAMES).size).toBe(TASK_TYPE_NAMES.length);
    expect(TASK_TYPE_NAMES).toHaveLength(20);
    for (const type of TASK_TYPE_NAMES)
      expect(SHORT_TASK_TYPES.includes(type)).toBe(deadlineMsFor(type) <= SHORT_TASK_DEADLINE_MS);
    // A CV build, a scan or a discovery can never be claimed by such a runner.
    for (const type of ["generate_cv", "scan_company", "discover"] as const) expect(SHORT_TASK_TYPES).not.toContain(type);
  });
});
