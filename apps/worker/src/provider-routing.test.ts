import { expect, it } from "vitest";
import { serverFallbackEnabled } from "./provider-routing";

it("preserves the normal server fallback and disables it only for an explicit evaluation", () => {
  expect(serverFallbackEnabled({})).toBe(true);
  expect(serverFallbackEnabled({ disableServerFallback: false })).toBe(true);
  expect(serverFallbackEnabled({ disableServerFallback: true })).toBe(false);
});
