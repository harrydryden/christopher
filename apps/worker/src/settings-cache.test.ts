import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { createDeps, USER_SETTINGS_CACHE_MAX, type WorkerDeps } from "./context";
import { readEnv } from "./env";

/**
 * The worker's cache of each account's merged settings. Past a thousand accounts it used to be
 * cleared wholesale, and every gate re-evaluation cleared it for everyone.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
let deps: WorkerDeps;

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { settingsTtlMs: 600_000 });
}, 60_000);
afterAll(async () => { await deps?.close(); });

/** How many reads of one account's settings `body` made. */
async function accountReads(body: () => Promise<unknown>): Promise<number> {
  const pool = deps.pool as unknown as { query: (...args: unknown[]) => Promise<unknown> };
  const original = pool.query.bind(pool);
  let reads = 0;
  pool.query = (async (...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
    if (/from "user_settings"/.test(text)) reads++;
    return original(...args);
  }) as typeof pool.query;
  try { await body(); } finally { pool.query = original as typeof pool.query; }
  return reads;
}

it("keeps the accounts in use when there are more accounts than it holds, and lets the oldest go", async () => {
  const busy = randomUUID();
  const idle = randomUUID();
  await deps.userSettings(idle);
  await deps.userSettings(busy);
  for (let index = 0; index < USER_SETTINGS_CACHE_MAX + 100; index++) {
    await deps.userSettings(randomUUID());
    if (index % 500 === 0) await deps.userSettings(busy);
  }
  expect(await accountReads(() => deps.userSettings(busy))).toBe(0);
  expect(await accountReads(() => deps.userSettings(idle))).toBe(1);
}, 120_000);

it("drops one account's settings on its own invalidation, and leaves the others'", async () => {
  const [a, b] = [randomUUID(), randomUUID()];
  await deps.userSettings(a);
  await deps.userSettings(b);
  deps.invalidateSettings(a);
  expect(await accountReads(() => deps.userSettings(a))).toBe(1);
  expect(await accountReads(() => deps.userSettings(b))).toBe(0);
});

it("never caches a read that began before an invalidation", async () => {
  const a = randomUUID();
  const inFlight = deps.userSettings(a);
  deps.invalidateSettings(a);
  await inFlight;
  expect(await accountReads(() => deps.userSettings(a))).toBe(1);
});
