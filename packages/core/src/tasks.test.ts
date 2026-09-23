import { describe, expect, it } from "vitest";
import { AGEING_PRIORITY_FLOOR, INTERACTIVE_TASK_TYPES, priorityFor } from "./tasks";

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
