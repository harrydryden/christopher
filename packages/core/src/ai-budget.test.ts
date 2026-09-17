import { describe, expect, it } from "vitest";
import { aiBudgetWindowStart, aiFeatureLabel } from "./ai-budget";

describe("aiBudgetWindowStart", () => {
  const now = new Date("2026-09-17T12:00:00Z");

  it("counts from the start of the current UTC month when nothing was reset", () => {
    expect(aiBudgetWindowStart(now, null).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(aiBudgetWindowStart(now, undefined).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(aiBudgetWindowStart(now, "").toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("counts from a reset made this month, so earlier calls stop counting", () => {
    expect(aiBudgetWindowStart(now, "2026-09-10T08:30:00.000Z").toISOString()).toBe("2026-09-10T08:30:00.000Z");
  });

  it("ignores a reset older than the month, which the month start already covers", () => {
    expect(aiBudgetWindowStart(now, "2026-08-02T00:00:00.000Z").toISOString()).toBe("2026-09-01T00:00:00.000Z");
    // The marker set at deploy keeps working after the month it was made in rolls over.
    expect(aiBudgetWindowStart(new Date("2026-10-01T00:05:00Z"), "2026-09-17T09:00:00.000Z").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("falls back to the month start when the marker is not a usable timestamp", () => {
    expect(aiBudgetWindowStart(now, "not a date").toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(aiBudgetWindowStart(now, "2026-13-45T99:00:00Z").toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("aiFeatureLabel", () => {
  it("names the feature behind a call site", () => {
    expect(aiFeatureLabel("CV")).toBe("CV builder");
    expect(aiFeatureLabel("A5")).toBe("Role scoring");
    expect(aiFeatureLabel("A3")).toBe("Extraction");
    expect(aiFeatureLabel("A1")).toBe("Discovery");
    expect(aiFeatureLabel("A2")).toBe("Discovery");
  });

  it("reports an unknown call site as itself", () => {
    expect(aiFeatureLabel("A99")).toBe("A99");
  });
});
