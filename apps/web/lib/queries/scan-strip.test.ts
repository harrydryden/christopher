/**
 * The status strip's own reads: the last completed scan of a company this account follows, and how
 * many it follows. Scans are shared, so both are seen through the account's subscriptions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
vi.mock("@/lib/db", () => ({ db: () => database }));

import { followingCount, lastCompletedScanAt } from "./scan-strip";
import { latestScanByCompany, listCatalogue, listCompanies } from "./companies";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await database.execute(sql`truncate companies, settings, users restart identity cascade`);
  user = await ensureTestUser(database, "strip@example.com", "member");
  other = await ensureTestUser(database, "strip-other@example.com", "member");
});

async function companyWithSource(domain: string) {
  const [company] = await database.insert(schema.companies).values({ name: domain, homepageUrl: `https://${domain}`, domain }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "greenhouse", url: `https://${domain}/careers` }).returning();
  return { company: company!, source: source! };
}

const follow = (userId: string, companyId: string, status: "active" | "paused" | "archived" = "active") =>
  database.insert(schema.companySubscriptions).values({ userId, companyId, status });

const scan = (sourceId: string, finishedAt: Date | null, status: "ok" | "partial" | "failed" = "ok") =>
  database.insert(schema.scans).values({ sourceId, startedAt: new Date((finishedAt ?? new Date()).getTime() - 60_000), finishedAt, status });

it("counts only active subscriptions", async () => {
  const a = await companyWithSource("a.example");
  const b = await companyWithSource("b.example");
  const c = await companyWithSource("c.example");
  await follow(user.id, a.company.id);
  await follow(user.id, b.company.id, "paused");
  await follow(user.id, c.company.id, "archived");
  await follow(other.id, c.company.id);
  expect(await followingCount(user.id)).toBe(1);
  expect(await followingCount(other.id)).toBe(1);
});

it("reads the latest finished, unfailed scan of a followed company", async () => {
  const followed = await companyWithSource("followed.example");
  const unfollowed = await companyWithSource("elsewhere.example");
  await follow(user.id, followed.company.id);
  expect(await lastCompletedScanAt(user.id)).toBeNull();

  await scan(followed.source.id, new Date("2026-09-10T05:30:00Z"));
  await scan(followed.source.id, new Date("2026-09-11T05:30:00Z"), "partial");
  // A later failure, a scan still running, and a newer scan of a company this account does not follow are none of them it.
  await scan(followed.source.id, new Date("2026-09-12T05:30:00Z"), "failed");
  await scan(followed.source.id, null);
  await scan(unfollowed.source.id, new Date("2026-09-13T05:30:00Z"));

  expect((await lastCompletedScanAt(user.id))?.toISOString()).toBe("2026-09-11T05:30:00.000Z");
  expect(await lastCompletedScanAt(other.id)).toBeNull();
});

/**
 * The per-source lookups that replaced reading every retained scan give the same answers as the
 * catalogue-wide queries they replaced, on a fixture with the awkward cases: several sources, one
 * never scanned, a disabled one whose newest scan failed, a running scan newest, a scan that
 * finished after a later one started, a paused follow.
 */
describe("per-source scan lookups agree with the catalogue-wide queries they replaced", () => {
  const at = (iso: string) => new Date(iso);
  async function fixture() {
    const a = await companyWithSource("a.example");
    const b = await companyWithSource("b.example");
    const c = await companyWithSource("c.example");
    const quiet = await companyWithSource("quiet.example");
    await database.insert(schema.careerSources).values({ companyId: a.company.id, type: "html", url: "https://a.example/jobs-new" });
    const [disabled] = await database.insert(schema.careerSources).values({ companyId: a.company.id, type: "lever", url: "https://a.example/jobs-old", status: "disabled" }).returning();
    await database.insert(schema.scans).values([
      { sourceId: a.source.id, startedAt: at("2026-09-10T05:00:00Z"), finishedAt: at("2026-09-10T05:20:00Z"), status: "ok" },
      // Started a day earlier, finished after the scan above: finish order is not start order.
      { sourceId: a.source.id, startedAt: at("2026-09-09T05:00:00Z"), finishedAt: at("2026-09-10T06:00:00Z"), status: "partial" },
      { sourceId: disabled!.id, startedAt: at("2026-09-11T05:00:00Z"), finishedAt: at("2026-09-11T05:01:00Z"), status: "failed" },
      { sourceId: b.source.id, startedAt: at("2026-09-08T05:00:00Z"), finishedAt: at("2026-09-08T05:10:00Z"), status: "ok" },
      { sourceId: b.source.id, startedAt: at("2026-09-12T05:00:00Z"), finishedAt: null, status: "partial" },
      { sourceId: c.source.id, startedAt: at("2026-09-13T05:00:00Z"), finishedAt: at("2026-09-13T05:10:00Z"), status: "ok" },
    ]);
    await follow(user.id, a.company.id);
    await follow(user.id, b.company.id);
    await follow(user.id, c.company.id, "paused");
    await follow(user.id, quiet.company.id);
    await follow(other.id, c.company.id);
    return [a.company.id, b.company.id, c.company.id, quiet.company.id];
  }

  it("for the strip's last completed scan", async () => {
    await fixture();
    const previous = async (userId: string) => {
      const result = await database.execute<{ at: string | null }>(sql`
        select max(scans.finished_at) as at from scans
        join career_sources on career_sources.id = scans.source_id
        join company_subscriptions on company_subscriptions.company_id = career_sources.company_id
        where company_subscriptions.user_id = ${userId} and company_subscriptions.status = 'active'
          and scans.finished_at is not null and scans.status <> 'failed'`);
      const value = result.rows[0]?.at;
      return value ? new Date(value).toISOString() : null;
    };
    for (const account of [user, other]) {
      expect((await lastCompletedScanAt(account.id))?.toISOString() ?? null).toBe(await previous(account.id));
    }
    expect((await lastCompletedScanAt(user.id))?.toISOString()).toBe("2026-09-10T06:00:00.000Z");
    expect((await lastCompletedScanAt(other.id))?.toISOString()).toBe("2026-09-13T05:10:00.000Z");
  });

  it("for the companies list and the catalogue's last scan", async () => {
    const ids = await fixture();
    const previous = await database
      .selectDistinctOn([schema.careerSources.companyId], { companyId: schema.careerSources.companyId, status: schema.scans.status, startedAt: schema.scans.startedAt })
      .from(schema.scans)
      .innerJoin(schema.careerSources, eq(schema.scans.sourceId, schema.careerSources.id))
      .where(inArray(schema.careerSources.companyId, ids))
      .orderBy(schema.careerSources.companyId, desc(schema.scans.startedAt));
    const byId = (rows: Array<{ companyId: string; status: string; startedAt: Date }>) =>
      Object.fromEntries(rows.map(row => [row.companyId, { status: row.status, startedAt: row.startedAt.toISOString() }]));
    const expected = byId(previous);
    expect(Object.keys(expected)).toHaveLength(3);
    expect(byId(await latestScanByCompany(ids))).toEqual(expected);
    // The pages that show it read it through the same lookup.
    const listed = await listCompanies(user.id, 1);
    expect(Object.fromEntries(listed.map(row => [row.company.id, row.lastScan && { status: row.lastScan.status, startedAt: row.lastScan.startedAt.toISOString() }])))
      .toEqual(Object.fromEntries(ids.map(id => [id, expected[id] ?? null])));
    const catalogue = await listCatalogue(user.id, 1);
    expect(Object.fromEntries(catalogue.map(row => [row.company.id, row.lastScan && { status: row.lastScan.status, startedAt: row.lastScan.startedAt.toISOString() }])))
      .toEqual(Object.fromEntries(ids.map(id => [id, expected[id] ?? null])));
  });
});
