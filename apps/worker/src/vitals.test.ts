import { expect, it } from "vitest";
import { heapUsedFraction, vitals } from "./vitals";

it("reports heap pressure against the V8 ceiling without rounding across the 85% alert", () => {
  expect(heapUsedFraction(846, 1000)).toBe(0.846);
  expect(heapUsedFraction(850, 1000)).toBe(0.85);
  expect(heapUsedFraction(1, 0)).toBe(0);
  // The public reading uses the same ratio; its rounded MB fields are for display only.
  const current = vitals();
  expect(current.heapFraction).toBeGreaterThanOrEqual(0);
  expect(current.heapLimitMb).toBeGreaterThan(0);
});
