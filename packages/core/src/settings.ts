/**
 * Application settings stored as key/value JSON in the `settings` table.
 * Shared by web (edits) and worker (reads). Defaults apply when a key is missing.
 */
import type { GateSettings } from "./gate";

export interface AppSettings {
  gate: GateSettings;
  /** Daily run time "HH:MM" in `timezone`. */
  scanTime: string;
  timezone: string;
  /** Fit-score threshold under which in-table roles are collapsed. null = off. */
  hideThreshold: number | null;
  nearMissEnabled: boolean;
  nearMissDailyCap: number;
  nearMissMinScore: number;
  /** Free text written by the user at setup; never overwritten by the model. */
  seedProfile: string;
  monthlyAiBudgetUsd: number;
  /** Model id per call site; missing keys fall back to `defaultModel`. */
  defaultModel: string;
  cvModel: string;
  modelOverrides: Record<string, string>;
  /** Days a closed role stays visible in the table by default. */
  showClosedDays: number;
  /** Consecutive ok scans a role must be absent from before it closes. */
  closeAfterMissingScans: number;
  respectRobotsTxt: boolean;
  /** Companies whose HTML sources may match keywords against descriptions (requires detail fetches). */
  descriptionMatchCompanyIds: string[];
  suggestionsEnabled: boolean;
  /** Day of week (0 = Sunday) for weekly jobs: suggestions, filter proposals, profile synthesis fallback. */
  weeklyDay: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  gate: {
    includeKeywords: ["operations"],
    excludeKeywords: [],
    matchFields: ["title"],
    locationTerms: [],
    includeRemote: true,
  },
  scanTime: "06:00",
  timezone: "Europe/London",
  hideThreshold: null,
  nearMissEnabled: true,
  nearMissDailyCap: 10,
  nearMissMinScore: 70,
  seedProfile: "",
  monthlyAiBudgetUsd: 25,
  defaultModel: "claude-opus-5",
  cvModel: "claude-sonnet-5",
  modelOverrides: {},
  showClosedDays: 30,
  closeAfterMissingScans: 2,
  respectRobotsTxt: true,
  descriptionMatchCompanyIds: [],
  suggestionsEnabled: true,
  weeklyDay: 0,
};

export type SettingsKey = keyof AppSettings;
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

/** Merge stored rows onto defaults, tolerating missing or malformed values. */
export function resolveSettings(rows: Array<{ key: string; value: unknown }>): AppSettings {
  const out: AppSettings = structuredClone(DEFAULT_SETTINGS);
  for (const row of rows) {
    const key = row.key as SettingsKey;
    if (!(key in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[key];
    const val = row.value;
    if (val === null || val === undefined) continue;
    // A stored value replaces the default when the two are the same kind. `hideThreshold` is the
    // one setting whose default is null (meaning "off") and whose set value is a number, so a null
    // default accepts any primitive; a stored null is already skipped above and keeps the default.
    const compatible = def === null ? typeof val !== "object" : typeof def === typeof val;
    if (!compatible) continue;
    if (key === "gate" && typeof val === "object") {
      out.gate = { ...DEFAULT_SETTINGS.gate, ...(val as Partial<GateSettings>) };
      continue;
    }
    (out as unknown as Record<string, unknown>)[key] = val;
  }
  return out;
}

export function modelForCallSite(settings: AppSettings, callSite: string): string {
  return settings.modelOverrides[callSite] ?? settings.defaultModel;
}

/** Validate "HH:MM". */
export function isValidScanTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" and "HH:MM" for `date` in `tz`. */
export function localDateParts(date: Date, tz: string): { ymd: string; hm: string; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hm: `${hour}:${parts.minute}`, weekday: weekdays.indexOf(parts.weekday ?? "Sun") };
}
