import { expect, it } from "vitest";
import { STAGE_ROUTE_IDS } from "@ava/core";
import { CV_FITTER_ATTEMPTS, cvStageModel, estimateCostUsd, estimateCvBuildUsd, estimateStage } from "./pricing";
import { PROMPTS, PROMPT_IDS } from "./prompt-registry";
import { createAiEngine } from "./engine";

it("reserves both writing/checking passes and releases completed planning work at the quiz pause", () => {
  const model = "claude-fable-5-1";
  const size = { libraryBytes: 45_000, descriptionBytes: 9_000 };
  const planning = estimateCostUsd(model, { inputTokens: 19_500, outputTokens: 6_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const rubric = estimateCostUsd(model, { inputTokens: 3_000, outputTokens: 4_500, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const legacy = estimateCvBuildUsd(model, size, "all");
  const completion = estimateCvBuildUsd(model, size, "tailored_completion");
  expect(completion).toBeCloseTo(2 * (legacy - rubric) + planning, 6);
  expect(estimateCvBuildUsd(model, size, "tailored")).toBeCloseTo(completion + rubric + planning, 6);
  expect(completion).toBeGreaterThan(estimateCvBuildUsd(model, size, "assessment"));
  expect(estimateCvBuildUsd(model, size, "tailored_assessment")).toBeCloseTo(
    estimateCvBuildUsd(model, size, "assessment") + legacy - rubric, 6,
  );
});

it("holds a build for the fitter's worst case: three author calls, each reading the library and writing its most", () => {
  const size = { libraryBytes: 45_000, descriptionBytes: 9_000 };
  const model = "claude-fable-5-1";
  const writing = estimateCvBuildUsd(model, size, "all") - estimateCvBuildUsd(model, size, "assessment");
  const author = estimateCostUsd(model, { inputTokens: (45_000 + 9_000) / 3, outputTokens: 16_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const rubric = estimateCostUsd(model, { inputTokens: 9_000 / 3, outputTokens: 4_500, cacheReadTokens: 0, cacheWriteTokens: 0 });
  expect(writing).toBeCloseTo(CV_FITTER_ATTEMPTS * author + rubric, 6);
  expect(CV_FITTER_ATTEMPTS).toBe(3);
});

it("keys stage routes by exactly the registry's entries", () => {
  expect([...STAGE_ROUTE_IDS].sort()).toEqual([...PROMPT_IDS].sort());
});

it("prices a stage the administrator routed elsewhere at its own model, and the rest at the build's", () => {
  const model = "claude-fable-5-1";
  const size = { libraryBytes: 45_000, descriptionBytes: 9_000 };
  expect(cvStageModel("cv.review", model)).toBe(model);
  expect(cvStageModel("cv.review", model, { "cv.review": { model: "claude-sonnet-5" } })).toBe("claude-sonnet-5");
  // An effort-only route changes no price here: the estimate is calibrated in tokens.
  expect(estimateCvBuildUsd(model, size, "all", { "cv.review": { effort: "medium" } })).toBe(estimateCvBuildUsd(model, size, "all"));
  const audit = (m: string) => estimateCvBuildUsd(m, size, "assessment");
  const routed = estimateCvBuildUsd(model, size, "all", { "cv.review": { model: "claude-sonnet-5" } });
  expect(routed).toBeCloseTo(estimateCvBuildUsd(model, size, "all") - audit(model) + audit("claude-sonnet-5"), 5);
  // A tailored build audits twice; routing the re-audit prices only that one away.
  const candidate = estimateCvBuildUsd(model, size, "tailored_completion", { "cv.review_candidate": { model: "claude-sonnet-5" } });
  expect(candidate).toBeCloseTo(estimateCvBuildUsd(model, size, "tailored_completion") - audit(model) + audit("claude-sonnet-5"), 5);
});

it("estimates one stage from its layout: cached blocks written once at their lifetime and read back by the later calls", () => {
  const review = PROMPTS["cv.review"];
  const system = Buffer.byteLength(review.system) / 3;
  const usd = estimateStage(review, { stableBytes: [30_000, 9_000], tailBytes: 6_000, calls: 5 }, { cvModel: "claude-fable-5-1" });
  // The evidence block (and the system prompt before it) is an hour-long entry; the CV a five-minute one.
  expect(usd).toBeCloseTo(estimateCostUsd("claude-fable-5-1", {
    inputTokens: 5 * 2_000, cacheWriteTokens: system + 10_000 + 3_000, cacheWrite1hTokens: system + 10_000,
    cacheReadTokens: 4 * (system + 13_000), outputTokens: 5 * review.expectedOutputTokens,
  }), 6);
  // Routed to another model, the same stage is priced there.
  expect(estimateStage(review, { stableBytes: [30_000, 9_000], tailBytes: 6_000, calls: 5 }, { cvModel: "claude-fable-5-1", routes: { "cv.review": { model: "claude-sonnet-5" } } }))
    .toBeLessThan(usd);
  // A single-shot entry with no stable blocks: its system prompt is a five-minute write.
  const rubric = PROMPTS["cv.rubric"];
  expect(estimateStage(rubric, { tailBytes: 9_000 }, { cvModel: "claude-fable-5-1" })).toBeCloseTo(estimateCostUsd("claude-fable-5-1", {
    inputTokens: 3_000, cacheWriteTokens: Buffer.byteLength(rubric.system) / 3, cacheReadTokens: 0, outputTokens: rubric.expectedOutputTokens,
  }), 6);
  // A call-site entry is priced at the deployment's model for it.
  expect(estimateStage(PROMPTS.A5, { stableBytes: [9_000], tailBytes: 3_000 }, { callSiteModel: "claude-haiku-4-5" }))
    .toBeLessThan(estimateStage(PROMPTS.A5, { stableBytes: [9_000], tailBytes: 3_000 }, { callSiteModel: "claude-fable-5-1" }));
});

it("sends each call at the model and effort the administrator routed its stage to", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const engine = createAiEngine({
    getModel: () => "claude-fable-5-1",
    getStageRoutes: () => ({ "cv.rubric": { model: "claude-sonnet-5", effort: "medium" } }),
    client: { messages: { create: async params => {
      sent.push(params);
      return { parsed_output: { requirements: [{ id: "r1", label: "Ops", quote: "Lead operations", importance: "essential", category: "experience" }], caveats: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
    } } },
  });
  await engine.analyseCvJob("Lead operations");
  expect(sent[0]).toMatchObject({ model: "claude-sonnet-5", output_config: { effort: "medium" } });
  // Unrouted stages keep the account's model and the entry's effort; an unreadable setting changes nothing.
  const plain = createAiEngine({ getModel: () => "claude-fable-5-1", getStageRoutes: () => { throw new Error("settings down"); },
    client: { messages: { create: async params => { sent.push(params); return { parsed_output: null, usage: {} }; } } } });
  await plain.analyseCvJob("Lead operations");
  expect(sent[1]).toMatchObject({ model: "claude-fable-5-1", output_config: { effort: "high" } });
});
