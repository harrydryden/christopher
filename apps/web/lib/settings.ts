import { cache } from "react";
import { and, eq, inArray, notLike, sql } from "drizzle-orm";
import { settings as settingsTable, userSettings as userSettingsTable } from "@ava/db/schema";
import { dedupeKeyFor, isSystemSettingsKey, isUserSettingsKey, priorityFor, resolveSettings, resolveSystemSettings, type AppSettings, type GateSettings, type SystemSettings, type UserSettings } from "@ava/core";
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

/**
 * The same rows read once per request. The status strip, the page and a CV quote each want the
 * settings, and a render asked for the system rows up to three times and an account's rows twice.
 * `cache` is scoped to one server render (it memoises nothing in a server action, which may write),
 * and the account's rows stay keyed by `userId`. A caller with its own writer, a transaction that
 * may just have written, always reads afresh.
 */
const requestSystemRows = cache(() => systemRows());
const requestUserRows = cache((userId: string) => userRows(userId));

/** The schedule, models and scan policy: one set for the whole deployment. */
export const getSystemSettings = cache(async (): Promise<SystemSettings> => resolveSystemSettings(await requestSystemRows()));

/** One account's settings merged onto the system ones. */
export async function getSettingsFor(userId: string, writer?: Writer): Promise<AppSettings> {
  const [system, user] = await Promise.all(writer
    ? [systemRows(writer), userRows(userId, writer)]
    : [requestSystemRows(), requestUserRows(userId)]);
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

/** A gate's settings as one comparable string, whatever order its keys were stored in. */
function gateFingerprint(gate: GateSettings): string {
  return JSON.stringify(Object.fromEntries(Object.entries(gate).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * Persist one account's settings and its gate membership in one transaction before returning to the
 * interface. Only a save that changes the gate re-evaluates it and re-scores the table: every pass
 * reads every posting of every followed company, and a display setting reads none of that.
 * `rescore` is false for an account that has not confirmed its address: re-scoring is model work,
 * and filters are the one thing such an account sets at once (the gate itself spends nothing).
 *
 * A large account's re-evaluation runs in the background. One queued pass is enough however many
 * saves arrive before it starts, because it reads the settings when it runs; a save made while a
 * pass is already running queues the next one, so no change is ever left unapplied.
 */
export async function saveSettingsAndGate(userId: string, entries: Partial<UserSettings>, options: { rescore?: boolean } = {}): Promise<void> {
  await db().transaction(async (tx) => {
    // One save per account at a time, so the queued-pass check below cannot race another save.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`settings:${userId}`}))`);
    const before = await getSettingsFor(userId, tx as unknown as Writer);
    for (const [key, value] of Object.entries(entries)) {
      if (!isUserSettingsKey(key)) throw new Error(`Not a user setting: ${key}`);
      await tx.insert(userSettingsTable).values({ userId, key, value: value as object, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [userSettingsTable.userId, userSettingsTable.key], set: { value: value as object, updatedAt: new Date() } });
    }
    const settings = await getSettingsFor(userId, tx as unknown as Writer);
    if (gateFingerprint(settings.gate) === gateFingerprint(before.gate)) return;
    const size = await tx.execute(sql`select count(*)::int as n from (
      select j.id from jobs j where exists (select 1 from company_subscriptions s where s.company_id = j.company_id and s.user_id = ${userId} and s.status <> 'archived') limit 501) bounded`);
    if (Number(size.rows[0]?.n) > 500) {
      // The account's key holds only a pass that has not started, so a running one never absorbs
      // this; a waiting one — the boot pass, say — is brought up to a person's priority instead.
      const payload = { userId };
      await enqueueTask(tx, "reevaluate_gate", payload, { dedupeKey: dedupeKeyFor("reevaluate_gate", payload), priority: priorityFor("reevaluate_gate"), promote: true });
    } else await reevaluateGate(tx as unknown as ReturnType<typeof db>, userId, settings);
    if (options.rescore ?? true) await enqueueTask(tx, "rescore_all", { userId, onlyInTable: true }, { dedupeKey: `rescore_all:${userId}`, priority: 5, promote: true });
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
