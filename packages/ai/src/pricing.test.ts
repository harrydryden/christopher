import { expect, it } from "vitest";
import { estimateCostUsd, estimateCvBuildUsd } from "./pricing";

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
