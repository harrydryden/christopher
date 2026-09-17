/**
 * Application settings stored as key/value JSON.
 *
 * Two scopes share one shape. System settings (the daily schedule, models, the AI budget, closure
 * and robots policy) live in the `settings` table and are edited by an administrator. User
 * settings (keywords, locations, seed profile, CV preferences) live in `user_settings`, one row
 * per account and key. `AppSettings` is the two merged, which is what most code wants to read.
 * Defaults apply when a key is missing.
 */
import { CvWritingPreferencesSchema, type CvWritingPreferences } from "./cv-writing-preferences";
import { CvThemeSchema, type CvTheme } from "./cv-theme";
import type { GateSettings } from "./gate";

export interface SystemSettings {
  /** Daily run time "HH:MM" in `timezone`. One run for every company anyone follows. */
  scanTime: string;
  timezone: string;
  /** The ceiling over everything, including work done for no particular account. */
  monthlyAiBudgetUsd: number;
  /**
   * When the shared spend counter was last zeroed (ISO), or null for "not since the month began".
   * Spend recorded before it does not count this month; see `aiBudgetWindowStart`.
   */
  aiBudgetResetAt: string | null;
  /** Model id per call site; missing keys fall back to `defaultModel`. */
  defaultModel: string;
  modelOverrides: Record<string, string>;
  /** Consecutive ok scans a role must be absent from before it closes. */
  closeAfterMissingScans: number;
  respectRobotsTxt: boolean;
  /** Day of week (0 = Sunday) for weekly jobs: suggestions, filter proposals, profile synthesis fallback. */
  weeklyDay: number;
  /** Whether anyone may create an account. Addresses listed in ADMIN_EMAILS always may. */
  registrationOpen: boolean;
}

export interface UserSettings {
  gate: GateSettings;
  /**
   * This account's own monthly AI budget, which an administrator may raise. The shared
   * `monthlyAiBudgetUsd` still caps everything, so an account can never spend past it.
   */
  aiBudgetUsd: number;
  /** When this account's spend counter was last zeroed (ISO), or null. Read by `aiBudgetWindowStart`. */
  aiBudgetResetAt: string | null;
  /** Fit-score threshold under which in-table roles are collapsed. null = off. */
  hideThreshold: number | null;
  /** Free text written by the user at setup; never overwritten by the model. */
  seedProfile: string;
  cvModel: string;
  cvTheme?: CvTheme;
  cvWritingPreferences?: CvWritingPreferences;
  /** Days a closed role stays visible in the table by default. */
  showClosedDays: number;
  /** Companies whose HTML sources may match keywords against descriptions (requires detail fetches). */
  descriptionMatchCompanyIds: string[];
  suggestionsEnabled: boolean;
}

export type AppSettings = SystemSettings & UserSettings;

/** What a new account may spend on AI in a month until an administrator raises it. */
export const DEFAULT_ACCOUNT_AI_BUDGET_USD = 25;
/** The most an account budget may be set to, so a typed figure cannot become an unbounded bill. */
export const MAX_ACCOUNT_AI_BUDGET_USD = 10000;

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  scanTime: "06:00",
  timezone: "Europe/London",
  monthlyAiBudgetUsd: 25,
  aiBudgetResetAt: null,
  defaultModel: "claude-sonnet-5",
  modelOverrides: {},
  closeAfterMissingScans: 2,
  respectRobotsTxt: true,
  weeklyDay: 0,
  registrationOpen: false,
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  gate: {
    includeKeywords: ["operations"],
    excludeKeywords: [],
    matchFields: ["title"],
    locationTerms: [],
    includeRemote: true,
  },
  aiBudgetUsd: DEFAULT_ACCOUNT_AI_BUDGET_USD,
  aiBudgetResetAt: null,
  hideThreshold: null,
  seedProfile: "",
  cvModel: "claude-fable-5-1",
  cvTheme: undefined,
  cvWritingPreferences: undefined,
  showClosedDays: 30,
  descriptionMatchCompanyIds: [],
  suggestionsEnabled: true,
};

export const DEFAULT_SETTINGS: AppSettings = { ...DEFAULT_SYSTEM_SETTINGS, ...DEFAULT_USER_SETTINGS };

export type SystemSettingsKey = keyof SystemSettings;
export type UserSettingsKey = keyof UserSettings;
export type SettingsKey = keyof AppSettings;
export const SYSTEM_SETTINGS_KEYS = Object.keys(DEFAULT_SYSTEM_SETTINGS) as SystemSettingsKey[];
export const USER_SETTINGS_KEYS = Object.keys(DEFAULT_USER_SETTINGS) as UserSettingsKey[];
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

export function isSystemSettingsKey(key: string): key is SystemSettingsKey {
  return (SYSTEM_SETTINGS_KEYS as string[]).includes(key);
}

export function isUserSettingsKey(key: string): key is UserSettingsKey {
  return (USER_SETTINGS_KEYS as string[]).includes(key);
}

type SettingsRow = { key: string; value: unknown };

/** Apply stored rows onto a defaults object in place, tolerating missing or malformed values. */
function applyRows(out: AppSettings, rows: SettingsRow[]): void {
  for (const row of rows) {
    const key = row.key as SettingsKey;
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (key === "cvWritingPreferences") {
      const parsed = CvWritingPreferencesSchema.safeParse(row.value);
      if (parsed.success) out.cvWritingPreferences = parsed.data;
      continue;
    }
    if (key === "cvTheme") {
      const theme = CvThemeSchema.safeParse(row.value);
      if (theme.success) out.cvTheme = { ...theme.data, skillPills: true };
      continue;
    }
    const def = DEFAULT_SETTINGS[key];
    const val = row.value;
    if (val === null || val === undefined) continue;
    // A stored value replaces the default when the two are the same kind. `hideThreshold` is the
    // one setting whose default is null (meaning "off") and whose set value is a number, so a null
    // default accepts any primitive; a stored null is already skipped above and keeps the default.
    const compatible = def === null ? typeof val !== "object" : typeof def === typeof val;
    if (!compatible) continue;
    // Both budget keys are read by money-spending code, so a stored value is checked here rather
    // than trusted: the budget is clamped to a sane range and the reset marker must be a usable
    // timestamp. `aiBudgetResetAt` belongs to both scopes — the shared counter in `settings`, an
    // account's in `user_settings` — and the account row is applied last, so it wins for an account.
    if (key === "aiBudgetUsd") {
      if (typeof val === "number" && Number.isFinite(val)) out.aiBudgetUsd = Math.min(MAX_ACCOUNT_AI_BUDGET_USD, Math.max(0, val));
      continue;
    }
    if (key === "aiBudgetResetAt") {
      if (typeof val === "string" && !Number.isNaN(Date.parse(val))) out.aiBudgetResetAt = val;
      continue;
    }
    if (key === "gate" && typeof val === "object") {
      out.gate = { ...DEFAULT_SETTINGS.gate, ...(val as Partial<GateSettings>) };
      continue;
    }
    (out as unknown as Record<string, unknown>)[key] = val;
  }
}

/**
 * Merge stored rows onto defaults. `rows` are usually the system table and `userRows` one
 * account's rows. The key sets are disjoint but for `aiBudgetResetAt`, which both scopes keep:
 * user rows are applied last, so an account's own reset marker wins over the shared one. A single
 * mixed list therefore still works, as long as it is ordered system rows first.
 */
export function resolveSettings(rows: SettingsRow[], userRows: SettingsRow[] = []): AppSettings {
  const out: AppSettings = structuredClone(DEFAULT_SETTINGS);
  applyRows(out, rows);
  applyRows(out, userRows);
  return out;
}

export function resolveSystemSettings(rows: SettingsRow[]): SystemSettings {
  const merged = resolveSettings(rows.filter((row) => isSystemSettingsKey(row.key)));
  return Object.fromEntries(SYSTEM_SETTINGS_KEYS.map((key) => [key, merged[key]])) as unknown as SystemSettings;
}

export function resolveUserSettings(rows: SettingsRow[]): UserSettings {
  const merged = resolveSettings(rows.filter((row) => isUserSettingsKey(row.key)));
  return Object.fromEntries(USER_SETTINGS_KEYS.map((key) => [key, merged[key]])) as unknown as UserSettings;
}

export function modelForCallSite(settings: Pick<SystemSettings, "defaultModel" | "modelOverrides">, callSite: string): string {
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
