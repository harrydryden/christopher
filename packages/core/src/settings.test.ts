import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isValidScanTime, isValidTimezone, localDateParts, modelForCallSite, resolveSettings } from "./settings";

describe("resolveSettings", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(resolveSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  it("applies a stored value of the same kind", () => {
    expect(resolveSettings([{ key: "scanTime", value: "07:30" }]).scanTime).toBe("07:30");
    expect(resolveSettings([{ key: "nearMissEnabled", value: false }]).nearMissEnabled).toBe(false);
    expect(resolveSettings([{ key: "monthlyAiBudgetUsd", value: 40 }]).monthlyAiBudgetUsd).toBe(40);
  });

  it("applies a numeric hideThreshold even though its default is null", () => {
    // The default is null, meaning the threshold is off. A set value is a number, so the guard
    // must not reject it for having a different type from the default.
    expect(resolveSettings([{ key: "hideThreshold", value: 30 }]).hideThreshold).toBe(30);
    expect(resolveSettings([{ key: "hideThreshold", value: 0 }]).hideThreshold).toBe(0);
  });

  it("treats a stored null hideThreshold as off", () => {
    expect(resolveSettings([{ key: "hideThreshold", value: null }]).hideThreshold).toBeNull();
    expect(resolveSettings([]).hideThreshold).toBeNull();
  });

  it("ignores a stored value of the wrong kind", () => {
    expect(resolveSettings([{ key: "scanTime", value: 6 }]).scanTime).toBe(DEFAULT_SETTINGS.scanTime);
    expect(resolveSettings([{ key: "hideThreshold", value: { nope: true } }]).hideThreshold).toBeNull();
    expect(resolveSettings([{ key: "nearMissDailyCap", value: "ten" }]).nearMissDailyCap).toBe(DEFAULT_SETTINGS.nearMissDailyCap);
  });

  it("merges the gate onto its defaults rather than replacing it", () => {
    const settings = resolveSettings([{ key: "gate", value: { locationTerms: ["London"] } }]);
    expect(settings.gate.locationTerms).toEqual(["London"]);
    expect(settings.gate.includeKeywords).toEqual(DEFAULT_SETTINGS.gate.includeKeywords);
    expect(settings.gate.includeRemote).toBe(true);
  });

  it("ignores unknown keys, including the worker's internal bookkeeping", () => {
    const settings = resolveSettings([
      { key: "internal:lastWeeklyYmd", value: "2026-09-06" },
      { key: "nonsense", value: 1 },
    ]);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("does not mutate the defaults", () => {
    resolveSettings([{ key: "gate", value: { locationTerms: ["London"] } }]);
    expect(DEFAULT_SETTINGS.gate.locationTerms).toEqual([]);
  });
});

describe("settings helpers", () => {
  it("picks a per-call-site model, falling back to the default", () => {
    const settings = { ...DEFAULT_SETTINGS, defaultModel: "claude-opus-5", modelOverrides: { A3: "claude-haiku-4-5" } };
    expect(modelForCallSite(settings, "A3")).toBe("claude-haiku-4-5");
    expect(modelForCallSite(settings, "A5")).toBe("claude-opus-5");
  });

  it("validates scan times and timezones", () => {
    expect(isValidScanTime("06:00")).toBe(true);
    expect(isValidScanTime("23:59")).toBe(true);
    expect(isValidScanTime("24:00")).toBe(false);
    expect(isValidScanTime("6:00")).toBe(false);
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
  });

  it("reports local date parts in the configured timezone", () => {
    // 05:30 UTC in September is 06:30 in London (British Summer Time).
    const parts = localDateParts(new Date("2026-09-05T05:30:00Z"), "Europe/London");
    expect(parts).toEqual({ ymd: "2026-09-05", hm: "06:30", weekday: 6 });
    // Just after midnight UTC is still the previous day in New York.
    expect(localDateParts(new Date("2026-09-05T00:30:00Z"), "America/New_York").ymd).toBe("2026-09-04");
  });
});
