import { describe, expect, it } from "vitest";
import { parseScoreBatchCustomId, scoreBatchCustomId, scoreBatchHolds, scoreBatchPollDelayMs } from "./score-batch";
import { resolveSystemSettings } from "./settings";

const task = "0d9f1c2e-5b3a-4c7d-8e9f-0123456789ab";
const user = "ffffffff-0000-4000-8000-000000000001";
const job = "12345678-9abc-4def-8123-456789abcdef";

describe("a scoring request's custom_id", () => {
  it("names its task, account and role within the provider's 64 characters of [a-zA-Z0-9_-]", () => {
    const id = scoreBatchCustomId(task, user, job)!;
    expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(id).toHaveLength(64);
    expect(parseScoreBatchCustomId(id)).toEqual({ taskId: task, userId: user, jobId: job });
  });

  it("differs whenever any of the three differs, so two accounts scoring one role never collide", () => {
    const other = "ffffffff-0000-4000-8000-000000000002";
    const ids = new Set([scoreBatchCustomId(task, user, job), scoreBatchCustomId(task, other, job), scoreBatchCustomId(job, user, task)]);
    expect(ids.size).toBe(3);
  });

  it("reads uppercase ids back as the same ids, lowercased", () => {
    expect(parseScoreBatchCustomId(scoreBatchCustomId(task.toUpperCase(), user, job)!)?.taskId).toBe(task);
  });

  it("refuses to name a request whose ids are not uuids, and reads nothing from a name it did not write", () => {
    expect(scoreBatchCustomId("u", user, job)).toBeNull();
    expect(parseScoreBatchCustomId(`${task}:${user}:${job}`)).toBeNull();
    expect(parseScoreBatchCustomId("short")).toBeNull();
  });
});

describe("a batch's holds", () => {
  it("are one per account, each the sum of that account's requests", () => {
    const holds = scoreBatchHolds([
      { userId: "a", estimateUsd: 0.001 }, { userId: "b", estimateUsd: 0.004 }, { userId: "a", estimateUsd: 0.002 },
    ]);
    expect([...holds.entries()]).toEqual([["a", 0.003], ["b", 0.004]]);
  });
});

describe("polling a running batch", () => {
  it("waits half as long as the batch has run, at least a minute and never more than fifteen", () => {
    expect([0, 1, 4, 10, 30, 60, 24 * 60].map(minutes => scoreBatchPollDelayMs(minutes * 60_000)))
      .toEqual([1, 1, 2, 5, 15, 15, 15].map(minutes => minutes * 60_000));
  });
});

describe("the scoring settings", () => {
  it("default to live scoring collected every ten minutes", () => {
    expect(resolveSystemSettings([])).toMatchObject({ scoringMode: "live", scoringBatchMinutes: 10 });
  });

  it("keep a stored batch mode and interval, and drop anything else", () => {
    expect(resolveSystemSettings([{ key: "scoringMode", value: "batch" }, { key: "scoringBatchMinutes", value: 30 }]))
      .toMatchObject({ scoringMode: "batch", scoringBatchMinutes: 30 });
    expect(resolveSystemSettings([{ key: "scoringMode", value: "sometimes" }, { key: "scoringBatchMinutes", value: 0 }]))
      .toMatchObject({ scoringMode: "live", scoringBatchMinutes: 10 });
    expect(resolveSystemSettings([{ key: "scoringBatchMinutes", value: 61 }]).scoringBatchMinutes).toBe(10);
    expect(resolveSystemSettings([{ key: "scoringBatchMinutes", value: 2.5 }]).scoringBatchMinutes).toBe(10);
  });
});
