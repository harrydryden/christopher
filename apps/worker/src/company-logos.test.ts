/**
 * The stored company logo, at the database: a capture round-trips byte for byte and clears the
 * retry state, a failure widens the backoff without touching what is stored, and the due-set is
 * what the scheduler will ask for.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  companiesDueLogoCapture, createDb, noteLogoFailure, readCompanyLogo, schema, storeCompanyLogo, type Db,
} from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import pg from "pg";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";
const DAY = 86_400_000;
const now = new Date("2026-09-19T09:00:00Z");

let db: Db;
let pool: pg.Pool;

beforeAll(async () => {
  const created = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(created.db);
  db = created.db;
  pool = created.pool;
}, 60_000);

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await db.execute(sql`truncate companies, company_logos restart identity cascade`);
});

const png = (length = 300) => {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < length; i++) bytes[i] = i % 251;
  return bytes;
};

async function company(overrides: Partial<typeof schema.companies.$inferInsert> = {}) {
  const domain = overrides.domain ?? `acme-${Math.random().toString(36).slice(2, 10)}.test`;
  const [row] = await db.insert(schema.companies).values({
    name: "Acme", domain, homepageUrl: `https://${domain}`, ...overrides,
  }).returning();
  return row!;
}

const read = async (id: string) => (await db.select().from(schema.companies).where(eq(schema.companies.id, id)).limit(1))[0]!;

it("stores the bytes and clears the retry state the failures left", async () => {
  const subject = await company({ logoAttempts: 3, logoError: "was failing", logoNextAttemptAt: new Date(now.getTime() + DAY), faviconUrl: "https://old.test/favicon.ico" });
  const bytes = png();
  await storeCompanyLogo(db, subject.id, { bytes, contentType: "image/png", source: "site_icon", sourceUrl: "https://acme.test/touch.png" }, now);

  const stored = await readCompanyLogo(db, subject.id);
  expect(stored?.contentType).toBe("image/png");
  expect(stored?.fetchedAt.toISOString()).toBe(now.toISOString());
  expect(Uint8Array.from(stored!.bytes)).toEqual(bytes);

  const after = await read(subject.id);
  expect(after).toMatchObject({ logoAttempts: 0, logoNextAttemptAt: null, logoError: null, faviconUrl: "https://acme.test/touch.png" });
  expect(after.logoFetchedAt?.toISOString()).toBe(now.toISOString());
  const [row] = await db.select().from(schema.companyLogos).where(eq(schema.companyLogos.companyId, subject.id));
  expect(row).toMatchObject({ byteLength: bytes.length, source: "site_icon", sourceUrl: "https://acme.test/touch.png" });

  // A later capture replaces the bytes rather than colliding on the primary key.
  await storeCompanyLogo(db, subject.id, { bytes: png(64), contentType: "image/x-icon", source: "icon_service", sourceUrl: "https://icons.duckduckgo.com/ip3/acme.test.ico" }, now);
  expect((await readCompanyLogo(db, subject.id))?.bytes.length).toBe(64);
  expect(await readCompanyLogo(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
});

it("counts each failure, widens the backoff, and leaves a stored logo alone", async () => {
  const subject = await company();
  await storeCompanyLogo(db, subject.id, { bytes: png(), contentType: "image/png", source: "site_icon", sourceUrl: "https://acme.test/icon.png" }, new Date(now.getTime() - DAY));

  const first = await noteLogoFailure(db, subject.id, "x".repeat(900), now);
  expect(first.attempts).toBe(1);
  expect(first.nextAttemptAt.toISOString()).toBe(new Date(now.getTime() + 3_600_000).toISOString());
  const second = await noteLogoFailure(db, subject.id, "HTTP 500", now);
  expect(second.attempts).toBe(2);
  expect(second.nextAttemptAt.toISOString()).toBe(new Date(now.getTime() + 6 * 3_600_000).toISOString());

  const after = await read(subject.id);
  expect(after.logoError).toBe("HTTP 500");
  expect(after.logoNextAttemptAt?.toISOString()).toBe(second.nextAttemptAt.toISOString());
  // The error text is bounded, and yesterday's capture is still what the interface serves.
  await noteLogoFailure(db, subject.id, "y".repeat(900), now);
  expect((await read(subject.id)).logoError).toHaveLength(500);
  expect((await readCompanyLogo(db, subject.id))?.bytes.length).toBe(300);
});

it("asks for the companies that are due and no others", async () => {
  const never = await company({ domain: "never.test" });
  const stale = await company({ domain: "stale.test", logoFetchedAt: new Date(now.getTime() - 100 * DAY) });
  const fresh = await company({ domain: "fresh.test", logoFetchedAt: new Date(now.getTime() - DAY) });
  const backingOff = await company({ domain: "backoff.test", logoNextAttemptAt: new Date(now.getTime() + 2 * 3_600_000), logoAttempts: 2 });
  const overdue = await company({ domain: "overdue.test", logoNextAttemptAt: new Date(now.getTime() - 2 * 3_600_000), logoAttempts: 2 });
  const archived = await company({ domain: "archived.test", status: "archived" });

  const due = await companiesDueLogoCapture(db, now);
  const ids = due.map((row) => row.id);
  expect(ids).toContain(never.id);
  expect(ids).toContain(stale.id);
  expect(ids).toContain(overdue.id);
  expect(ids).not.toContain(fresh.id);
  expect(ids).not.toContain(backingOff.id);
  expect(ids).not.toContain(archived.id);
  // Oldest attempt first, and a company nobody has ever captured has the oldest attempt of all.
  expect(ids).toEqual([never.id, stale.id, overdue.id]);
  expect(due.find((row) => row.id === never.id)?.homepageUrl).toBe("https://never.test");
  expect(await companiesDueLogoCapture(db, now, 1)).toHaveLength(1);
});
