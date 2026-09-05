import { schema, type Db } from "@christopher/db";
import { resolveSettings, type AppSettings } from "@christopher/core";
import { eq } from "drizzle-orm";

export async function loadSettings(db: Db): Promise<AppSettings> {
  const rows = await db.select({ key: schema.settings.key, value: schema.settings.value }).from(schema.settings);
  return resolveSettings(rows);
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
