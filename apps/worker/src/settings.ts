import { schema, type Db } from "@christopher/db";
import { resolveSettings, resolveSystemSettings, type AppSettings, type SystemSettings } from "@christopher/core";
import { eq } from "drizzle-orm";

/** System settings: the schedule, models, budget and scan policy an administrator controls. */
export async function loadSettings(db: Db): Promise<SystemSettings> {
  const rows = await db.select({ key: schema.settings.key, value: schema.settings.value }).from(schema.settings);
  return resolveSystemSettings(rows);
}

/** One account's settings (keywords, locations, profile, CV preferences) merged onto the system ones. */
export async function loadUserSettings(db: Db, userId: string): Promise<AppSettings> {
  const [systemRows, userRows] = await Promise.all([
    db.select({ key: schema.settings.key, value: schema.settings.value }).from(schema.settings),
    db.select({ key: schema.userSettings.key, value: schema.userSettings.value }).from(schema.userSettings).where(eq(schema.userSettings.userId, userId)),
  ]);
  return resolveSettings(systemRows, userRows);
}

/** Internal bookkeeping values live in the same table under an `internal:` prefix; resolveSettings ignores them. */
export async function getInternal<T>(db: Db, key: string): Promise<T | null> {
  const rows = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, `internal:${key}`)).limit(1);
  return (rows[0]?.value as T | undefined) ?? null;
}

export async function setInternal(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: `internal:${key}`, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: value as object, updatedAt: new Date() } });
}
