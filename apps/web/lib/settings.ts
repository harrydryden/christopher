import { settings as settingsTable } from "@christopher/db/schema";
import { resolveSettings, type AppSettings } from "@christopher/core";
import { db } from "./db";

export async function getSettings(): Promise<AppSettings> {
  const rows = await db().select({ key: settingsTable.key, value: settingsTable.value }).from(settingsTable);
  return resolveSettings(rows);
}

/** Upsert one settings key. `value` must be JSON-serialisable. */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await db()
    .insert(settingsTable)
    .values({ key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: value as object, updatedAt: new Date() } });
}

export async function setSettings(entries: Partial<AppSettings>): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await setSetting(key, value);
  }
}
