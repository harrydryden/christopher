/** The source read budget is shared by workers, not by an in-process counter. */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client";
import { reserveLocationRead, WORKDAY_LOCATION_READS_PER_HOUR } from "./location-read-budget";
import { runMigrations } from "./migrate";
import * as schema from "./schema";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test";
const first = createDb(databaseUrl, { max: 4 });
const second = createDb(databaseUrl, { max: 4 });
const now = new Date("2026-10-01T12:00:00Z");

beforeAll(() => runMigrations(first.db), 60_000);
beforeEach(() => first.db.execute(sql`truncate companies restart identity cascade`));
afterAll(async () => { await first.pool.end(); await second.pool.end(); });

async function source(name: string) {
  const [company] = await first.db.insert(schema.companies).values({ name, domain: `${name}.example`,
    homepageUrl: `https://${name}.example` }).returning();
  const [row] = await first.db.insert(schema.careerSources).values({ companyId: company!.id, type: "workday",
    url: `https://${name}.wd1.myworkdayjobs.com/External` }).returning();
  return row!.id;
}

it("grants exactly 50 attempts, then defers to the next hourly window", async () => {
  const id = await source("boundary");
  for (let i = 0; i < WORKDAY_LOCATION_READS_PER_HOUR; i++)
    expect(await reserveLocationRead(first.db, id, now)).toEqual({ allowed: true });
  expect(await reserveLocationRead(first.db, id, now)).toEqual({ allowed: false,
    retryAt: new Date("2026-10-01T13:00:00Z") });
  const [row] = await first.db.select().from(schema.workdayLocationReadBudgets)
    .where(eq(schema.workdayLocationReadBudgets.sourceId, id));
  expect(row).toMatchObject({ requestCount: 50, windowStartedAt: now });
});

it("atomically caps concurrent reservations from separate worker pools", async () => {
  const id = await source("concurrent");
  const attempts = await Promise.all(Array.from({ length: 60 }, (_, i) =>
    reserveLocationRead(i % 2 ? first.db : second.db, id, now)));
  expect(attempts.filter((result) => result.allowed)).toHaveLength(50);
  expect(attempts.filter((result) => !result.allowed)).toHaveLength(10);
  expect((await first.db.select().from(schema.workdayLocationReadBudgets))[0]!.requestCount).toBe(50);
});

it("isolates sources and resets at exactly one hour", async () => {
  const a = await source("alpha");
  const b = await source("bravo");
  for (let i = 0; i < 50; i++) await reserveLocationRead(first.db, a, now);
  expect(await reserveLocationRead(first.db, b, now)).toEqual({ allowed: true });
  expect(await reserveLocationRead(first.db, a, new Date(now.getTime() + 3_599_999))).toEqual({
    allowed: false, retryAt: new Date(now.getTime() + 3_600_000),
  });
  expect(await reserveLocationRead(second.db, a, new Date(now.getTime() + 3_600_000))).toEqual({ allowed: true });
  const rows = await first.db.select().from(schema.workdayLocationReadBudgets);
  expect(rows.find((row) => row.sourceId === a)).toMatchObject({ requestCount: 1,
    windowStartedAt: new Date(now.getTime() + 3_600_000) });
  expect(rows.find((row) => row.sourceId === b)).toMatchObject({ requestCount: 1, windowStartedAt: now });
});
