/**
 * The derivation the October incident needed: a heartbeat is rewritten on every boot, so freshness
 * alone says a crash-looping worker is healthy. These are the rules both Health pages read.
 */
import { expect, it } from "vitest";
import { deriveWorkerStatus, governorSummary, heapSummary, workerStateTone, workerStatusSentence, type WorkerHeartbeat } from "./worker-status";

const now = new Date("2026-09-18T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

function heartbeat(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    at: ago(20_000),
    workerId: "worker-1",
    aiConfigured: true,
    browserAvailable: true,
    commit: null,
    bootedAt: ago(3_600_000),
    vitals: { heapUsedMb: 184, heapLimitMb: 258, heapFraction: 0.71, rssMb: 410, externalMb: 30, uptimeSeconds: 3600 },
    active: 2,
    concurrency: 3,
    ...overrides,
  };
}

it("calls a fresh worker with no recoveries healthy, and says nothing extra about it", () => {
  const status = deriveWorkerStatus({ heartbeat: heartbeat(), restartsLastHour: 0, restartsLastDay: 0, now });
  expect(status.state).toBe("healthy");
  expect(status.heapPressure).toBe(false);
  expect(workerStatusSentence(status)).toBeNull();
  expect(workerStateTone("healthy")).toBe("green");
  expect(heapSummary(heartbeat().vitals!)).toBe("184 of 258 MB heap, 71%");
});

it("calls a worker restarting when it has recovered from two crashes in the hour, however fresh its heartbeat", () => {
  const status = deriveWorkerStatus({ heartbeat: heartbeat({ at: ago(5_000) }), restartsLastHour: 12, restartsLastDay: 108, now });
  expect(status.state).toBe("restarting");
  // The count people recognise is the day's, not the hour's.
  expect(workerStatusSentence(status)).toBe(
    "The background worker has restarted 108 times today; scans and CV builds may be interrupted. An administrator can see why in Operations.",
  );
  expect(workerStateTone("restarting")).toBe("amber");
  // One recovery is an incident, not a loop.
  expect(deriveWorkerStatus({ heartbeat: heartbeat(), restartsLastHour: 1, restartsLastDay: 1, now }).state).toBe("healthy");
});

it("calls a worker stopped when four heartbeats have been missed, or when it has never reported", () => {
  const stale = deriveWorkerStatus({ heartbeat: heartbeat({ at: ago(11 * 60_000) }), restartsLastHour: 0, restartsLastDay: 0, now });
  expect(stale.state).toBe("stopped");
  expect(workerStatusSentence(stale)).toBe(
    "The background worker has not reported for 11 minutes; scans and CV builds are not running. An administrator can see why in Operations.",
  );
  // Two minutes exactly is still inside the window; a second past it is not.
  expect(deriveWorkerStatus({ heartbeat: heartbeat({ at: ago(120_000) }), restartsLastHour: 0, restartsLastDay: 0, now }).state).toBe("healthy");
  expect(deriveWorkerStatus({ heartbeat: heartbeat({ at: ago(121_000) }), restartsLastHour: 0, restartsLastDay: 0, now }).state).toBe("stopped");

  const never = deriveWorkerStatus({ heartbeat: null, restartsLastHour: 0, restartsLastDay: 0, now });
  expect(never.state).toBe("stopped");
  expect(never.ageMs).toBeNull();
  expect(workerStatusSentence(never)).toContain("has not reported;");
  expect(workerStateTone("stopped")).toBe("red");
});

it("flags heap pressure separately: close to the ceiling is not the same as down", () => {
  const hot = heartbeat({ vitals: { heapUsedMb: 230, heapLimitMb: 258, heapFraction: 0.89, rssMb: 480, externalMb: 40, uptimeSeconds: 120 } });
  const status = deriveWorkerStatus({ heartbeat: hot, restartsLastHour: 0, restartsLastDay: 0, now });
  expect(status.state).toBe("healthy");
  expect(status.heapPressure).toBe(true);
  // A heartbeat written before the worker reported vitals says nothing about the heap.
  expect(deriveWorkerStatus({ heartbeat: heartbeat({ vitals: null }), restartsLastHour: 0, restartsLastDay: 0, now }).heapPressure).toBe(false);
});

it("names the stream cap as the per-model figure it is, with each busy model's share and the pause", () => {
  const pausedUntil = new Date("2026-09-18T12:05:00.000Z");
  expect(
    governorSummary(
      { streamCap: 4, inFlight: 6, queued: 2, pausedUntil, models: [{ model: "model-a", inFlight: 4, queued: 2 }, { model: "model-b", inFlight: 2, queued: 0 }, { model: "model-c", inFlight: 0, queued: 0 }] },
      now,
    ),
  ).toBe("Model streams: 6 open, 2 waiting for a slot; each model may have 4 open at once; model-a 4 open, 2 waiting; model-b 2 open; paused by the provider until 12:05 UTC.");
  // A pause that has ended, and a worker that reports no per-model figures.
  expect(governorSummary({ streamCap: 4, inFlight: 1, queued: 0, pausedUntil: ago(1_000) }, now)).toBe(
    "Model streams: 1 open; each model may have 4 open at once.",
  );
});
