import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_AI_BUDGET_USD, DEFAULT_SETTINGS, DEFAULT_SYSTEM_SETTINGS, MAX_ACCOUNT_AI_BUDGET_USD, isValidScanTime, isValidTimezone, localDateParts, modelForCallSite, resolveSettings, resolveSystemSettings, resolveUserSettings } from "./settings";

describe("resolveSettings", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(resolveSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  it("applies a stored value of the same kind", () => {
    expect(resolveSettings([{ key: "scanTime", value: "07:30" }]).scanTime).toBe("07:30");
    expect(resolveSettings([{ key: "nearMissEnabled", value: true }])).not.toHaveProperty("nearMissEnabled");
    expect(resolveSettings([{ key: "weeklyDay", value: 3 }]).weeklyDay).toBe(3);
  });

  it("applies a numeric hideThreshold even though its default is null", () => {
    // The default is null, meaning the threshold is off. A set value is a number, so the guard
    // must not reject it for having a different type from the default.
    expect(resolveSettings([], [{ key: "hideThreshold", value: 30 }]).hideThreshold).toBe(30);
    expect(resolveSettings([], [{ key: "hideThreshold", value: 0 }]).hideThreshold).toBe(0);
  });

  it("treats a stored null hideThreshold as off", () => {
    expect(resolveSettings([], [{ key: "hideThreshold", value: null }]).hideThreshold).toBeNull();
    expect(resolveSettings([]).hideThreshold).toBeNull();
  });

  it("ignores a stored value of the wrong kind", () => {
    expect(resolveSettings([{ key: "scanTime", value: 6 }]).scanTime).toBe(DEFAULT_SETTINGS.scanTime);
    expect(resolveSettings([], [{ key: "hideThreshold", value: { nope: true } }]).hideThreshold).toBeNull();
    expect(resolveSettings([], [{ key: "showClosedDays", value: "ten" }]).showClosedDays).toBe(DEFAULT_SETTINGS.showClosedDays);
  });

  it("merges the gate onto its defaults rather than replacing it", () => {
    const settings = resolveSettings([], [{ key: "gate", value: { locationTerms: ["London"] } }]);
    expect(settings.gate.locationTerms).toEqual(["London"]);
    expect(settings.gate.includeKeywords).toEqual(DEFAULT_SETTINGS.gate.includeKeywords);
    expect(settings.gate.includeRemote).toBe(true);
  });

  it("ignores unknown keys: the worker's bookkeeping, and settings a later version removed", () => {
    const settings = resolveSettings([
      { key: "internal:lastWeeklyYmd", value: "2026-09-06" },
      { key: "nonsense", value: 1 },
      // The shared monthly ceiling that budgets used to have. A database that stored one before it
      // was removed keeps the row; nothing reads it, and it changes nothing that is read.
      { key: "monthlyAiBudgetUsd", value: 40 },
    ]);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings).not.toHaveProperty("monthlyAiBudgetUsd");
    expect(resolveSystemSettings([{ key: "monthlyAiBudgetUsd", value: 40 }])).toEqual(DEFAULT_SYSTEM_SETTINGS);
  });

  it("ignores an account's keys when they turn up in the shared system rows", () => {
    // `settings` is the administrator's table. A user-scoped row in it — left by an old migration,
    // a script or a hand-edit — must not become every account's gate, budget or threshold, and
    // must not beat the account's own row either.
    const strays = [
      { key: "gate", value: { includeKeywords: ["everything"], locationTerms: ["Mars"] } },
      { key: "aiBudgetUsd", value: 9999 },
      { key: "hideThreshold", value: 90 },
      { key: "seedProfile", value: "not this account's" },
    ];
    const settings = resolveSettings(strays);
    expect(settings.gate).toEqual(DEFAULT_SETTINGS.gate);
    expect(settings.aiBudgetUsd).toBe(DEFAULT_ACCOUNT_AI_BUDGET_USD);
    expect(settings.hideThreshold).toBeNull();
    expect(settings.seedProfile).toBe(DEFAULT_SETTINGS.seedProfile);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    // The account's own rows still decide, and the system rows beside them still apply.
    const merged = resolveSettings([...strays, { key: "scanTime", value: "07:30" }], [{ key: "hideThreshold", value: 40 }]);
    expect(merged.hideThreshold).toBe(40);
    expect(merged.aiBudgetUsd).toBe(DEFAULT_ACCOUNT_AI_BUDGET_USD);
    expect(merged.scanTime).toBe("07:30");
    // Both scoped resolvers agree: neither reads a user-scoped key from the shared table.
    expect(resolveSystemSettings(strays)).toEqual(DEFAULT_SYSTEM_SETTINGS);
    expect(resolveUserSettings([{ key: "hideThreshold", value: 40 }]).hideThreshold).toBe(40);
  });

  it("starts every account on the default AI budget with no reset behind it", () => {
    expect(resolveSettings([]).aiBudgetUsd).toBe(DEFAULT_ACCOUNT_AI_BUDGET_USD);
    expect(resolveSettings([]).aiBudgetResetAt).toBeNull();
    expect(resolveUserSettings([]).aiBudgetUsd).toBe(DEFAULT_ACCOUNT_AI_BUDGET_USD);
    expect(resolveUserSettings([]).aiBudgetResetAt).toBeNull();
    // The budget and its reset marker are an account's alone; neither is a system setting.
    expect(Object.keys(DEFAULT_SYSTEM_SETTINGS)).not.toContain("aiBudgetUsd");
    expect(Object.keys(DEFAULT_SYSTEM_SETTINGS)).not.toContain("aiBudgetResetAt");
  });

  it("clamps a stored account budget and ignores one that is not a number", () => {
    expect(resolveUserSettings([{ key: "aiBudgetUsd", value: 60 }]).aiBudgetUsd).toBe(60);
    expect(resolveUserSettings([{ key: "aiBudgetUsd", value: 0 }]).aiBudgetUsd).toBe(0);
    expect(resolveUserSettings([{ key: "aiBudgetUsd", value: -5 }]).aiBudgetUsd).toBe(0);
    expect(resolveUserSettings([{ key: "aiBudgetUsd", value: 1e9 }]).aiBudgetUsd).toBe(MAX_ACCOUNT_AI_BUDGET_USD);
    expect(resolveUserSettings([{ key: "aiBudgetUsd", value: "lots" }]).aiBudgetUsd).toBe(DEFAULT_ACCOUNT_AI_BUDGET_USD);
    expect(resolveUserSettings([{ key: "aiBudgetUsd", value: Number.NaN }]).aiBudgetUsd).toBe(DEFAULT_ACCOUNT_AI_BUDGET_USD);
  });

  it("keeps a reset marker only when it is a usable timestamp", () => {
    expect(resolveUserSettings([{ key: "aiBudgetResetAt", value: "2026-09-17T09:00:00.000Z" }]).aiBudgetResetAt).toBe("2026-09-17T09:00:00.000Z");
    expect(resolveUserSettings([{ key: "aiBudgetResetAt", value: "yesterday" }]).aiBudgetResetAt).toBeNull();
    expect(resolveUserSettings([{ key: "aiBudgetResetAt", value: 1789554417069 }]).aiBudgetResetAt).toBeNull();
    // The marker arrives with the account's rows, which are applied last.
    const merged = resolveSettings([{ key: "scanTime", value: "07:30" }], [{ key: "aiBudgetResetAt", value: "2026-09-17T09:00:00.000Z" }]);
    expect(merged.aiBudgetResetAt).toBe("2026-09-17T09:00:00.000Z");
  });

  it("does not mutate the defaults", () => {
    resolveSettings([], [{ key: "gate", value: { locationTerms: ["London"] } }]);
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

it("validates stored appearance and keeps the legacy fallback when absent", () => {
  const theme = { version: 1, primary: "#142D46", background: "#ffffff", surface: "#eff4f8", pill: "#e3edf5", introPanel: true, skillPills: false };
  // Themes saved before the font and page limit existed pick up the defaults without a save.
  expect(resolveSettings([], [{ key: "cvTheme", value: theme }]).cvTheme).toEqual({ ...theme, skillPills: true, font: "Christopher", maxPages: 3 });
  expect(resolveSettings([], [{ key: "cvTheme", value: { ...theme, font: "Arial", maxPages: 2 } }]).cvTheme).toMatchObject({ font: "Arial", maxPages: 2 });
  expect(resolveSettings([], [{ key: "cvTheme", value: { ...theme, maxPages: 9 } }]).cvTheme).toBeUndefined();
  expect(resolveSettings([], [{ key: "cvTheme", value: { ...theme, primary: "bad" } }]).cvTheme).toBeUndefined();
});
