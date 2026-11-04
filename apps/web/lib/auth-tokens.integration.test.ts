/** Token issuance must have one live successor and wait for account credential changes. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { isNull, sql } from "drizzle-orm";
import { createDb, lockAccountScoreInput, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
vi.mock("@/lib/db", () => ({ db: () => database }));
import { issueAuthToken, peekAuthToken } from "./auth-tokens";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => { await database.execute(sql`truncate users restart identity cascade`); });

async function userId() {
  const [user] = await database.insert(schema.users).values({
    email: `token-${crypto.randomUUID()}@example.test`, claimedAt: new Date(), emailVerifiedAt: new Date(),
  }).returning({ id: schema.users.id });
  return user!.id;
}

it("leaves only the latest reset link live when several are requested together", async () => {
  const id = await userId();
  const raw = await Promise.all(Array.from({ length: 12 }, () => issueAuthToken(id, "password_reset")));
  const live = await database.select().from(schema.authTokens).where(isNull(schema.authTokens.usedAt));
  expect(live).toHaveLength(1);
  const usable = await Promise.all(raw.map(token => peekAuthToken(token, "password_reset")));
  expect(usable.filter(Boolean)).toEqual([{ userId: id }]);
});

it("waits for an in-flight account credential change before issuing a token", async () => {
  const id = await userId();
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const holder = database.transaction(async tx => {
    await lockAccountScoreInput(tx as unknown as Db, id, "exclusive");
    acquired();
    await held;
  });
  await ready;
  const issuance = issueAuthToken(id, "email_verification");
  try {
    await vi.waitFor(async () => {
      const row = await database.execute<{ n: number }>(sql`select count(*)::int as n from pg_locks
        where locktype = 'advisory' and not granted and classid::int = 874302`);
      expect(row.rows[0]?.n).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(await database.select().from(schema.authTokens)).toHaveLength(0);
  } finally {
    release();
    await holder;
  }
  expect(await peekAuthToken(await issuance, "email_verification")).toEqual({ userId: id });
});

it("rolls back token invalidation when an in-transaction authority check fails", async () => {
  const id = await userId();
  const first = await issueAuthToken(id, "password_reset");
  await expect(issueAuthToken(id, "password_reset", new Date(), async () => {
    throw new Error("authority changed");
  })).rejects.toThrow("authority changed");
  expect(await peekAuthToken(first, "password_reset")).toEqual({ userId: id });
  expect(await database.select().from(schema.authTokens)).toHaveLength(1);
});
