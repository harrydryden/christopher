/**
 * The CV build's stage runner, without a database: reuse by key, admission around the work, the
 * per-stage allowance, and an audit whose batches finish, fail and are cancelled independently.
 */
import { describe, expect, it } from "vitest";
import type { CvBuildCheckpoint } from "@ava/core";
import type { CvRubric } from "@ava/core/cv-assessment";
import { CvBuildStop } from "@ava/core/cv-build-failure";
import { CvStageRunner, cvAuditBatches, estimateCvStage, type CvStage } from "./handlers/cv-stages";

function runnerWith(options: { prompts?: string; allowanceMs?: number; signal?: AbortSignal; checkpoint?: CvBuildCheckpoint } = {}) {
  let checkpoint: CvBuildCheckpoint = options.checkpoint ?? { v: 2, promptSetVersion: options.prompts ?? "p1", stages: {} };
  const admitted: Array<{ stage: string; usd: number; released: boolean }> = [];
  const runner = new CvStageRunner({
    checkpoint: () => checkpoint,
    persist: async next => { checkpoint = next; },
    admit: async (stage, usd) => {
      const entry = { stage, usd, released: false };
      admitted.push(entry);
      return { release: async () => { entry.released = true; } };
    },
    signal: options.signal ?? new AbortController().signal,
    model: "claude-sonnet-5",
    promptSetVersion: options.prompts ?? "p1",
    now: () => new Date("2026-09-26T09:00:00Z"),
    ...(options.allowanceMs ? { allowanceMs: { rubric: options.allowanceMs } } : {}),
  });
  return { runner, admitted, checkpoint: () => checkpoint };
}

const doubling = (calls: { n: number }): CvStage<{ value: number }, number> => ({
  name: "rubric", admission: "rubric", motion: "rubric",
  key: input => input,
  estimate: () => 0.25,
  run: async input => { calls.n++; return input.value * 2; },
  validate: value => value,
  mirror: value => ({ attempt: value }),
});

describe("the stage runner", () => {
  it("admits a stage just before it runs, saves its result under its key, and gives the hold back", async () => {
    const calls = { n: 0 };
    const { runner, admitted, checkpoint } = runnerWith();
    expect(await runner.run(doubling(calls), { value: 2 })).toEqual({ value: 4, reused: false });
    expect(admitted).toEqual([{ stage: "rubric", usd: 0.25, released: true }]);
    expect(checkpoint().stages!.rubric).toMatchObject({ value: 4, at: "2026-09-26T09:00:00.000Z" });
    expect(checkpoint().attempt).toBe(4);
    // The same inputs, prompts and model: reused, and nothing admitted for it.
    expect(await runner.run(doubling(calls), { value: 2 })).toEqual({ value: 4, reused: true });
    expect(calls.n).toBe(1);
    expect(admitted).toHaveLength(1);
    // Different inputs are a different key.
    expect(await runner.run(doubling(calls), { value: 3 })).toEqual({ value: 6, reused: false });
  });

  it("reuses nothing another prompt set made", async () => {
    const calls = { n: 0 };
    const first = runnerWith({ prompts: "p1" });
    await first.runner.run(doubling(calls), { value: 2 });
    const later = runnerWith({ prompts: "p2", checkpoint: first.checkpoint() });
    expect(await later.runner.run(doubling(calls), { value: 2 })).toEqual({ value: 4, reused: false });
    expect(calls.n).toBe(2);
  });

  it("stops a stage at its own allowance as a stalled stage, and still gives its hold back", async () => {
    const { runner, admitted } = runnerWith({ allowanceMs: 30 });
    const stuck: CvStage<object, number> = {
      ...doubling({ n: 0 }), key: () => ({}),
      run: (_input, ctx) => new Promise<number>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    };
    const stopped = await runner.run(stuck, {}).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(CvBuildStop);
    expect(stopped).toMatchObject({ kind: "stalled", extra: { motion: "rubric" } });
    expect((stopped as Error).message).toContain("requirements analysis step ran past its");
    expect(admitted[0]!.released).toBe(true);
  });

  it("lets the build's own stop through as itself, not as a stalled stage", async () => {
    const build = new AbortController();
    const { runner } = runnerWith({ signal: build.signal });
    const stuck: CvStage<object, number> = {
      ...doubling({ n: 0 }), key: () => ({}),
      run: (_input, ctx) => new Promise<number>((_, reject) => {
        if (ctx.signal.aborted) return reject(new Error("interrupted"));
        ctx.signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
      }),
    };
    const running = runner.run(stuck, {}).catch((error: unknown) => error);
    build.abort(new Error("lease lost"));
    expect(await running).toMatchObject({ message: "interrupted" });
  });
});

describe("an audit's batches", () => {
  const rubric: CvRubric = { caveats: [], requirements: Array.from({ length: 20 }, (_, index) => ({
    id: `r${index}`, label: `R${index}`, quote: `R${index}`, importance: "essential" as const, category: "experience" as const })) };
  const claims = [{ id: "c0", text: "claim" }, { id: "c1", text: "claim" }, { id: "c2", text: "claim" }];

  it("splits as the engine does: evenly, at most eight requirements and claims each", () => {
    const batches = cvAuditBatches({ rubric, claims });
    expect(batches.map(batch => batch.requirements.length)).toEqual([7, 7, 6]);
    expect(batches.map(batch => batch.claims.length)).toEqual([1, 1, 1]);
  });

  it("sizes an audit's admission by the batches still to run", () => {
    const sizes = { libraryBytes: 30_000, descriptionBytes: 6_000 };
    const models = { cvModel: "claude-sonnet-5" };
    expect(estimateCvStage("audit", { ...sizes, batches: 1 }, models))
      .toBeLessThan(estimateCvStage("audit", { ...sizes, batches: 4 }, models));
    expect(estimateCvStage("rubric", sizes, models)).toBeLessThan(estimateCvStage("write", sizes, models));
    // Each stage is priced at the model the administrator routed it to.
    expect(estimateCvStage("rubric", sizes, { ...models, routes: { "cv.rubric": { model: "claude-haiku-4-5" } } }))
      .toBeLessThan(estimateCvStage("rubric", sizes, models));
  });
});
