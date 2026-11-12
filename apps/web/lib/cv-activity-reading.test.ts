import { expect, it } from "vitest";
import type { CvActivity } from "@col/db";
import { serialiseCvActivities } from "./cv-activity-reading";
import { cvActivityLabel } from "./cv-activity";
const now = new Date("2026-11-12T12:00:00Z");
const item: CvActivity = { id: "draft:a", draftId: "a", contextId: null, company: "Acme", jobTitle: "Analyst",
  status: "generating", stage: "writing", createdAt: now, updatedAt: now, completedAt: null, read: true, unread: false };
it("uses the same stale/stopped state as the detail page without returning operational data", () => {
  const [reading] = serialiseCvActivities([{ ...item, work: { progressAt: new Date(now.getTime() - 11 * 60_000),
    error: "private provider details", failure: null,
    task: { status: "running", attempts: 1, maxAttempts: 3, startedAt: now, error: "private task error" } } }], now);
  expect(reading?.phase).toBe("stalled"); expect(cvActivityLabel(reading!)).toBe("CV taking longer than expected");
  expect(JSON.stringify(reading)).not.toContain("private"); expect(reading).not.toHaveProperty("work");
  const [stopped] = serialiseCvActivities([{ ...item, work: { progressAt: now, failure: null, error: null, task: null } }], now);
  expect(stopped?.phase).toBe("stopped"); expect(cvActivityLabel(stopped!)).toBe("CV needs attention");
});
