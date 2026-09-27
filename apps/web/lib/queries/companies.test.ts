/**
 * The company page's scan line. It reads the last good scan from `scans`, and the retained history
 * of finished tasks only in the half hour after that scan, when a rescan can have been served from it.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/db", () => ({ db: () => { reads.n++; return database; } }));
import { companyScanTiming, listCataloguePage, listCompanyPage } from "./companies";
import { subscribeToCompany } from "@ava/db";
import { ensureTestUser } from "@/test/auth";
import { scanTimingLine } from "@/app/(app)/companies/scan-line";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks restart identity cascade`);
  reads.n = 0;
});

const now = new Date("2026-09-23T12:00:00Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);

async function companyScannedAt(scannedAt: Date) {
  const [company] = await database.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs" }).returning();
  await database.insert(schema.scans).values({ sourceId: source!.id, status: "ok", startedAt: scannedAt, finishedAt: scannedAt });
  return company!.id;
}

async function skippedRescan(companyId: string, finishedAt: Date) {
  await database.insert(schema.tasks).values({
    type: "scan_company", payload: { companyId, trigger: "manual" }, status: "done",
    result: { skipped: "scanned recently", sources: 1 }, finishedAt,
  });
}

it("reports a skip served from a scan still inside the reuse window", async () => {
  const id = await companyScannedAt(minutesAgo(12));
  await skippedRescan(id, minutesAgo(1));
  reads.n = 0;
  const timing = await companyScanTiming(id, now);
  expect(timing).toEqual({ lastGoodScanAt: minutesAgo(12), rescanSkippedAt: minutesAgo(1) });
  expect(scanTimingLine(timing, "06:00", "Europe/London", now)).toBe("Rescan skipped: scanned 12m ago; a scan made in the last half hour is reused.");
  expect(reads.n).toBe(2);
});

it("reads no tasks once the last good scan is older than the reuse window", async () => {
  const id = await companyScannedAt(minutesAgo(45));
  await skippedRescan(id, minutesAgo(40));
  reads.n = 0;
  const timing = await companyScanTiming(id, now);
  expect(timing).toEqual({ lastGoodScanAt: minutesAgo(45), rescanSkippedAt: null });
  expect(scanTimingLine(timing, "06:00", "Europe/London", now)).toBe("Scanned 45m ago · next scheduled scan at 06:00 Europe/London");
  expect(reads.n).toBe(1);
});

it("ignores a skip that finished before the newest good scan", async () => {
  const id = await companyScannedAt(minutesAgo(5));
  await skippedRescan(id, minutesAgo(20));
  const timing = await companyScanTiming(id, now);
  expect(timing.rescanSkippedAt).toBeNull();
  expect(scanTimingLine(timing, "06:00", "Europe/London", now)).toBe("Scanned 5m ago · next scheduled scan at 06:00 Europe/London");
});

it("reads no tasks for a company never scanned", async () => {
  const [company] = await database.insert(schema.companies).values({ name: "New", domain: "new.example", homepageUrl: "https://new.example" }).returning();
  reads.n = 0;
  expect(await companyScanTiming(company!.id, now)).toEqual({ lastGoodScanAt: null, rescanSkippedAt: null });
  expect(reads.n).toBe(1);
});

async function followed(userId: string, names: string[]) {
  const ids: string[] = [];
  for (const name of names) {
    const slug = name.toLowerCase();
    const [company] = await database.insert(schema.companies).values({ name, domain: `${slug}.example`, homepageUrl: `https://${slug}.example` }).returning();
    await subscribeToCompany(database, userId, company!.id);
    ids.push(company!.id);
  }
  return ids;
}

it("reads the companies page beside its count, and a page past the end at the last one", async () => {
  const user = await ensureTestUser(database, "company-page@example.com");
  await followed(user.id, ["Beta", "Alpha", "Gamma"]);
  const first = await listCompanyPage(user.id, 1);
  expect(first).toMatchObject({ total: 3, page: 1 });
  expect(first.rows.map((row) => row.company.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  // Past the end: the last page, with its rows, rather than an empty table.
  const beyond = await listCompanyPage(user.id, 7);
  expect(beyond).toMatchObject({ total: 3, page: 1 });
  expect(beyond.rows.map((row) => row.company.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  // Another account follows nothing here.
  const other = await ensureTestUser(database, "company-page-other@example.com");
  expect(await listCompanyPage(other.id, 1)).toEqual({ rows: [], total: 0, page: 1 });
});

it("reads the catalogue page with its name proposals, clamping a page past the end", async () => {
  const admin = await ensureTestUser(database, "catalogue-admin@example.com", "admin");
  const member = await ensureTestUser(database, "catalogue-member@example.com");
  const [alpha] = await followed(member.id, ["Alpha", "Beta"]);
  await database.insert(schema.companyNameSuggestions).values({ companyId: alpha!, userId: member.id, name: "Alpha Ltd" });
  const page = await listCataloguePage(admin.id, 9);
  expect(page).toMatchObject({ total: 2, page: 1 });
  expect(page.rows.map((row) => ({ name: row.company.name, followers: row.followers, mine: row.followedByViewer })))
    .toEqual([{ name: "Alpha", followers: 1, mine: false }, { name: "Beta", followers: 1, mine: false }]);
  expect(page.suggestions.map((row) => ({ companyId: row.companyId, name: row.name, email: row.email })))
    .toEqual([{ companyId: alpha, name: "Alpha Ltd", email: "catalogue-member@example.com" }]);
});
