import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { recordAiUsage, tryReserveAi, type AiHold } from "./budget";
import { ensureTestUser } from "./test-users";

/**
 * A finished call's cost reaching `ai_calls`, the only record of spend, and the hold it was made
 * under settling as it does.
 *
 * A write that failed used to be logged and dropped while its hold was released anyway, so the
 * spend vanished from the budget for good. And a build's single hold stayed at its whole estimate
 * while each of its calls was recorded, so the build's spend counted twice until it ended.
 */
const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
beforeAll(() => runMigrations(db));
beforeEach(() => db.execute(sql`truncate ai_calls, ai_reservations`));
// Holds are left live on purpose here; the suites after this one share the database.
afterAll(async () => { await db.execute(sql`truncate ai_calls, ai_reservations`); await pool.end(); });

const since = new Date("2026-01-01T00:00:00Z");
const usage = (costUsd: number) => ({
  callSite: "CV", model: "claude-sonnet-5", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
  costUsd, durationMs: 10, ok: true, refType: "cv", refId: "draft-1", stage: "author",
});
const rows = () => db.select().from(schema.aiCalls);
const quickly = { retryDelaysMs: [0, 0, 0] };

/** A database whose first `fail` inserts throw; `afterCommit` makes them throw only once the row has landed. */
function flaky(fail: number, afterCommit = false): Db {
  let failures = 0;
  const insert = (table: never) => {
    const builder = db.insert(table);
    return new Proxy(builder, { get(target, key, receiver) {
      if (key !== "values") return Reflect.get(target, key, receiver);
      return (values: never) => {
        const query = target.values(values);
        return new Proxy(query, { get(q, k, r) {
          if (k !== "onConflictDoNothing") return Reflect.get(q, k, r);
          return (config: never) => {
            const run = q.onConflictDoNothing(config);
            return { then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              if (failures < fail) {
                failures++;
                if (afterCommit) return run.then(() => reject(new Error("Connection terminated after commit")), reject);
                return reject(new Error("timeout exceeded when trying to connect"));
              }
              return run.then(resolve, reject);
            } };
          };
        } });
      };
    } });
  };
  return new Proxy(db, { get(target, key, receiver) {
    if (key === "insert") return insert;
    if (key === "transaction") return (work: (tx: Db) => Promise<unknown>) => target.transaction(tx => work(new Proxy(tx, {
      get(t, k, r) { return k === "insert" ? insert : Reflect.get(t, k, r); },
    }) as unknown as Db));
    return Reflect.get(target, key, receiver);
  } });
}

it("lands a call's row after failed attempts, once", async () => {
  await recordAiUsage(flaky(2), null, usage(0.5), quickly);
  expect(await rows()).toHaveLength(1);
});

it("never writes a row twice when an attempt committed but its acknowledgement was lost", async () => {
  await recordAiUsage(flaky(1, true), null, usage(0.5), quickly);
  expect(await rows()).toHaveLength(1);
});

it("keeps the hold, and says so at error, when the row cannot be written at all", async () => {
  const user = await ensureTestUser(db, "unrecorded@example.com");
  const hold = await tryReserveAi(db, "CV", 2, { account: { userId: user.id, budgetUsd: 10, since } }) as AiHold;
  await expect(recordAiUsage(flaky(10), user.id, usage(0.5), { ...quickly, hold })).rejects.toThrow("timeout exceeded");
  expect(await rows()).toHaveLength(0);
  // The spend exists nowhere else, so the hold goes on counting it until it expires.
  await hold.release();
  expect(await db.select().from(schema.aiReservations)).toHaveLength(1);
});

it("takes each recorded call off a build's hold, so its spend never counts twice", async () => {
  const user = await ensureTestUser(db, "build-hold@example.com");
  const account = { userId: user.id, budgetUsd: 10, since };
  const build = await tryReserveAi(db, "CV", 5, { account }) as AiHold;
  await recordAiUsage(db, user.id, usage(2), { hold: build });
  await recordAiUsage(db, user.id, usage(2), { hold: build });
  // Spent 4, held 1: another $5 build fits. Counted twice (4 + 5 + 5) it would not.
  const next = await tryReserveAi(db, "CV", 5, { account });
  expect(next).toMatchObject({ spent: 4, held: 1 });
  // A build that spends past its estimate holds nothing more, and is still alive to renew.
  await recordAiUsage(db, user.id, usage(3), { hold: build });
  const [row] = await db.select().from(schema.aiReservations).where(eq(schema.aiReservations.userId, user.id)).orderBy(schema.aiReservations.createdAt).limit(1);
  expect(row!.amount).toBe(0);
  expect(await build.renew()).toBe(true);
});

it("records and reduces the hold together, or neither", async () => {
  const user = await ensureTestUser(db, "together@example.com");
  const build = await tryReserveAi(db, "CV", 5, { account: { userId: user.id, budgetUsd: 10, since } }) as AiHold;
  const failing = { ...build, consume: vi.fn().mockRejectedValue(new Error("lock timeout")), keep: build.keep };
  await expect(recordAiUsage(db, user.id, usage(2), { retryDelaysMs: [], hold: failing })).rejects.toThrow("lock timeout");
  expect(await rows()).toHaveLength(0);
  expect((await db.select().from(schema.aiReservations))[0]!.amount).toBe(5);
});
