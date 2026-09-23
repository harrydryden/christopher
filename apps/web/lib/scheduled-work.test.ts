import { expect, it } from "vitest";
import { scheduledWorkSentence } from "./scheduled-work";

it("says what a run started by hand did, in one sentence", () => {
  expect(scheduledWorkSentence(200, { ok: true, processed: 0, byType: {}, durationMs: 800, timedOut: false, drained: false }))
    .toEqual({ ok: true, sentence: "The scheduler ran: anything due is queued for the worker." });
  expect(scheduledWorkSentence(200, { ok: true, processed: 0, byType: {}, durationMs: 800, timedOut: false, drained: true }).sentence)
    .toBe("The scheduler ran, and nothing in the queue was waiting to run here.");
  expect(scheduledWorkSentence(200, { ok: true, processed: 4, byType: { scan_company: 3, discover: 1 }, durationMs: 42_000, timedOut: true, drained: true }).sentence)
    .toBe("The scheduler ran and worked through 4 tasks in 42s (1 discover, 3 scan_company); it stopped at the time limit, and the next run picks up the rest.");
  expect(scheduledWorkSentence(200, { ok: true, processed: 1, byType: { discover: 1 }, durationMs: 3_000, timedOut: false, drained: true }).sentence)
    .toBe("The scheduler ran and worked through 1 task in 3s (1 discover).");
  expect(scheduledWorkSentence(200, { ok: true, processed: 0, byType: {}, durationMs: 5, timedOut: false, standDown: "worker" }).sentence)
    .toContain("a worker reported in the last two minutes");
});

it("says why nothing ran when the route refused or failed", () => {
  expect(scheduledWorkSentence(403, { ok: false, error: "invalid request origin" })).toEqual({ ok: false, sentence: "Nothing ran: invalid request origin." });
  expect(scheduledWorkSentence(500, { ok: false, error: "scheduled run failed" }).sentence).toBe("Nothing ran: scheduled run failed.");
  expect(scheduledWorkSentence(502, null)).toEqual({ ok: false, sentence: "Nothing ran: the server answered 502." });
});
