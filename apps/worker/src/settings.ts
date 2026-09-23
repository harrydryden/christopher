import { schema, type Db } from "@ava/db";
import { resolveSettings, resolveSystemSettings, type AppSettings, type SystemSettings } from "@ava/core";
import { eq, notLike } from "drizzle-orm";

/**
 * The settings table also carries the worker's own `internal:` bookkeeping, and both loaders below
 * are on hot paths (every AI call, every robots check, once per follower per scan), so neither may
 * ship rows nothing reads. The interface's twin filters the same way.
 */
const SYSTEM_KEYS_ONLY = notLike(schema.settings.key, "internal:%");

/** System settings: the schedule, models and scan policy an administrator controls. */
export async function loadSettings(db: Db): Promise<SystemSettings> {
  const rows = await db.select({ key: schema.settings.key, value: schema.settings.value }).from(schema.settings).where(SYSTEM_KEYS_ONLY);
  return resolveSystemSettings(rows);
}

/** One account's settings (keywords, locations, profile, CV preferences) merged onto the system ones. */
export async function loadUserSettings(db: Db, userId: string): Promise<AppSettings> {
  const [systemRows, userRows] = await Promise.all([
    db.select({ key: schema.settings.key, value: schema.settings.value }).from(schema.settings).where(SYSTEM_KEYS_ONLY),
    db.select({ key: schema.userSettings.key, value: schema.userSettings.value }).from(schema.userSettings).where(eq(schema.userSettings.userId, userId)),
  ]);
  return resolveSettings(systemRows, userRows);
}

/**
 * A handful of small worker markers (the heartbeat, the last weekly run, the maintenance claim)
 * live in the same table under an `internal:` prefix. They are read one key at a time and never by
 * the loaders above. Anything that grows with the number of accounts, roles or sources belongs in a
 * table of its own instead.
 */
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
