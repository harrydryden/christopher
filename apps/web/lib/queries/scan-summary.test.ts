/**
 * The scan-run summary: what the banner on every page, the poll in every open tab and Health's run
 * history all read. It has to be right per account, cheap for many runs at once, and briefly cached.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, scanRunSummaries, scanRunSummary, subscribeToCompany, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { scanRunReport, scanRunReports, clearScanSummaryCache } from "@/lib/scan-run-report";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate companies, scan_runs, tasks, users restart identity cascade`);
  user = await ensureTestUser(database, "summary@example.com");
  clearScanSummaryCache();
});

/** A company with one careers source; `followed` decides whether this account sees it. */
async function company(name: string, followed: boolean) {
  const [row] = await database.insert(schema.companies).values({ name, domain: `${name}.example`, homepageUrl: `https://${name}.example` }).returning();
  const [source] = await database.insert(schema.careerSources).values({ companyId: row!.id, type: "html", url: `https://${name}.example/jobs` }).returning();
  if (followed) await subscribeToCompany(database, user.id, row!.id);
  return { id: row!.id, sourceId: source!.id };
}

const at = new Date("2026-09-11T06:00:00Z");

it("counts a company only when every latest source scan succeeded and its scan task is done", async () => {
  const mine = await company("acme", true);
  const [other] = await database.insert(schema.careerSources).values({ companyId: mine.id, type: "html", url: "https://acme.example/other" }).returning();
  const [run] = await database.insert(schema.scanRuns).values({ runDate: "2026-09-11", trigger: "manual", companiesTotal: 1 }).returning();
  const [task] = await database.insert(schema.tasks).values({ type: "scan_company", status: "done", payload: { companyId: mine.id, scanRunId: run!.id } }).returning();
  await database.insert(schema.scans).values([
    { sourceId: mine.sourceId, scanRunId: run!.id, status: "ok", startedAt: at, finishedAt: at, newCount: 2 },
    { sourceId: other!.id, scanRunId: run!.id, status: "partial", startedAt: at, finishedAt: at, newCount: 1 },
  ]);
  expect((await scanRunSummary(database, run!.id)).companies_ok).toBe(0);

  // The later attempt on the second source is the one that counts.
  await database.insert(schema.scans).values({ sourceId: other!.id, scanRunId: run!.id, status: "ok", startedAt: new Date(at.getTime() + 1000), finishedAt: new Date(at.getTime() + 2000), newCount: 0 });
  expect(await scanRunSummary(database, run!.id)).toMatchObject({ companies_ok: 1, new_roles: 3, pending: 0, sources: 2 });

  await database.update(schema.tasks).set({ status: "running" }).where(sql`id = ${task!.id}`);
  expect(await scanRunSummary(database, run!.id)).toMatchObject({ companies_ok: 0, pending: 1 });
  await database.update(schema.tasks).set({ status: "failed" }).where(sql`id = ${task!.id}`);
  expect(await scanRunSummary(database, run!.id)).toMatchObject({ companies_ok: 0, pending: 0 });
});

it("summarises many runs in one query, per account, and answers for a run with nothing in it", async () => {
  const mine = await company("acme", true);
  const theirs = await company("nobody", false);
  const runs = await database.insert(schema.scanRuns).values([
    { runDate: "2026-09-10", trigger: "schedule", companiesTotal: 2 },
    { runDate: "2026-09-11", trigger: "schedule", companiesTotal: 2 },
  ]).returning();
  await database.insert(schema.scans).values([
    { sourceId: mine.sourceId, scanRunId: runs[0]!.id, status: "ok", startedAt: at, finishedAt: at, newCount: 2, closedCount: 1 },
    { sourceId: theirs.sourceId, scanRunId: runs[0]!.id, status: "ok", startedAt: at, finishedAt: at, newCount: 7 },
    { sourceId: mine.sourceId, scanRunId: runs[1]!.id, status: "failed", startedAt: at, finishedAt: at, newCount: 0 },
  ]);

  const everyone = await scanRunSummaries(database, runs.map((run) => run.id));
  expect(everyone.size).toBe(2);
  expect(everyone.get(runs[0]!.id)).toEqual({ sources: 2, pending: 0, companies_ok: 2, new_roles: 9, closed_roles: 1 });
  expect(everyone.get(runs[1]!.id)).toEqual({ sources: 1, pending: 0, companies_ok: 0, new_roles: 0, closed_roles: 0 });

  const mineOnly = await scanRunSummaries(database, runs.map((run) => run.id), user.id);
  expect(mineOnly.get(runs[0]!.id)).toEqual({ sources: 1, pending: 0, companies_ok: 1, new_roles: 2, closed_roles: 1 });

  expect(await scanRunSummaries(database, [], user.id)).toEqual(new Map());
  expect(await scanRunSummary(database, crypto.randomUUID(), user.id)).toEqual({ sources: 0, pending: 0, companies_ok: 0, new_roles: 0, closed_roles: 0 });
});

it("holds one account's summary of one run for half a minute, and reports many runs together", async () => {
  const mine = await company("acme", true);
  const [run] = await database.insert(schema.scanRuns).values({ runDate: "2026-09-12", trigger: "manual", companiesTotal: 1 }).returning();
  await database.insert(schema.scans).values({ sourceId: mine.sourceId, scanRunId: run!.id, status: "ok", startedAt: at, finishedAt: at, newCount: 2 });
  expect((await scanRunReport(run!, user.id)).newRoles).toBe(2);

  // A second source reports in, but the banner is not recomputed on every render of every tab.
  const [second] = await database.insert(schema.careerSources).values({ companyId: mine.id, type: "html", url: "https://acme.example/more" }).returning();
  await database.insert(schema.scans).values({ sourceId: second!.id, scanRunId: run!.id, status: "ok", startedAt: at, finishedAt: at, newCount: 5 });
  expect((await scanRunReport(run!, user.id)).newRoles).toBe(2);
  // The whole deployment's view of the same run is a separate entry, so it is read fresh.
  expect((await scanRunReport(run!)).newRoles).toBe(7);

  clearScanSummaryCache();
  expect((await scanRunReport(run!, user.id)).newRoles).toBe(7);

  const [reported] = await scanRunReports([run!], user.id);
  // Per account the total counts the sources scanned plus those still queued, as it always has.
  expect(reported).toMatchObject({ newRoles: 7, companiesTotal: 2, companiesOk: 1 });
  expect(await scanRunReports([], user.id)).toEqual([]);
});
