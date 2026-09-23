import { cache } from "react";
import { and, eq, inArray, notLike, sql } from "drizzle-orm";
import { settings as settingsTable, userSettings as userSettingsTable } from "@ava/db/schema";
import { isSystemSettingsKey, isUserSettingsKey, resolveSettings, resolveSystemSettings, type AppSettings, type SystemSettings, type UserSettings } from "@ava/core";
import { enqueueTask, reevaluateGate } from "@ava/db";
import { requireUser } from "./auth";
import { db } from "./db";

type Writer = Pick<ReturnType<typeof db>, "select" | "insert" | "execute">;

async function systemRows(writer: Writer = db()) {
  return writer.select({ key: settingsTable.key, value: settingsTable.value }).from(settingsTable).where(notLike(settingsTable.key, "internal:%"));
}

async function userRows(userId: string, writer: Writer = db()) {
  return writer.select({ key: userSettingsTable.key, value: userSettingsTable.value }).from(userSettingsTable).where(eq(userSettingsTable.userId, userId));
}

/** The schedule, models and scan policy: one set for the whole deployment. */
export const getSystemSettings = cache(async (): Promise<SystemSettings> => resolveSystemSettings(await systemRows()));

/** One account's settings merged onto the system ones. */
export async function getSettingsFor(userId: string, writer: Writer = db()): Promise<AppSettings> {
  const [system, user] = await Promise.all([systemRows(writer), userRows(userId, writer)]);
  return resolveSettings(system, user);
}

/** The signed-in account's settings, memoised per request. */
export const getSettings = cache(async (): Promise<AppSettings> => getSettingsFor((await requireUser()).id));

export async function setSystemSetting(key: keyof SystemSettings, value: unknown): Promise<void> {
  if (!isSystemSettingsKey(key)) throw new Error(`Not a system setting: ${key}`);
  await db()
    .insert(settingsTable)
    .values({ key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: value as object, updatedAt: new Date() } });
}

export async function setUserSetting(userId: string, key: keyof UserSettings, value: unknown): Promise<void> {
  if (!isUserSettingsKey(key)) throw new Error(`Not a user setting: ${key}`);
  await db()
    .insert(userSettingsTable)
    .values({ userId, key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [userSettingsTable.userId, userSettingsTable.key], set: { value: value as object, updatedAt: new Date() } });
}

/**
 * Persist one account's settings and its gate membership in one transaction before returning to the
 * interface. `rescore` is false for an account that has not confirmed its address: re-scoring is
 * model work, and filters are the one thing such an account sets at once (the gate itself spends
 * nothing).
 */
export async function saveSettingsAndGate(userId: string, entries: Partial<UserSettings>, options: { rescore?: boolean } = {}): Promise<void> {
  await db().transaction(async (tx) => {
    for (const [key, value] of Object.entries(entries)) {
      if (!isUserSettingsKey(key)) throw new Error(`Not a user setting: ${key}`);
      await tx.insert(userSettingsTable).values({ userId, key, value: value as object, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [userSettingsTable.userId, userSettingsTable.key], set: { value: value as object, updatedAt: new Date() } });
    }
    const settings = await getSettingsFor(userId, tx as unknown as Writer);
    const size = await tx.execute(sql`select count(*)::int as n from (
      select j.id from jobs j where exists (select 1 from company_subscriptions s where s.company_id = j.company_id and s.user_id = ${userId} and s.status <> 'archived') limit 501) bounded`);
    if (Number(size.rows[0]?.n) > 500) {
      // Every save gets a task, including changes made during an earlier re-evaluation.
      await enqueueTask(tx, "reevaluate_gate", { userId }, { priority: 1 });
    } else await reevaluateGate(tx as unknown as ReturnType<typeof db>, userId, settings);
    if (options.rescore ?? true) await enqueueTask(tx, "rescore_all", { userId, onlyInTable: true }, { dedupeKey: `rescore_all:${userId}`, priority: 5 });
  });
}

/** Any of these keys, for one account or the system, in one call. Callers know which side each key belongs to. */
export async function readSettingRows(userId: string, keys: string[]) {
  const [system, user] = await Promise.all([
    db().select({ key: settingsTable.key, value: settingsTable.value }).from(settingsTable).where(inArray(settingsTable.key, keys)),
    db().select({ key: userSettingsTable.key, value: userSettingsTable.value }).from(userSettingsTable).where(and(eq(userSettingsTable.userId, userId), inArray(userSettingsTable.key, keys))),
  ]);
  return [...system, ...user];
}
