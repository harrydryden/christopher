/**
 * The rows the company setup timeline is drawn from.
 *
 * The catalogue half is shared — the discovery run, the source, the scan — and the last figure is
 * not: what a board came to is the reading account's own `user_jobs`, so the same company read by
 * two accounts must not hand either of them the other's table.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { companySetupRows } from "./companies";
import { companySetupLine, narrateCompanySetup } from "@/lib/company-timeline";

const CONTEXT = { nextScan: "next scheduled scan at 06:00 Europe/London" };

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, users restart identity cascade`);
  user = await ensureTestUser(database, "setup@example.com");
  other = await ensureTestUser(database, "neighbour@example.com", "member");
});

it("gathers the catalogue's rows and this account's own table, and nobody else's", async () => {
  const [company] = await database.insert(schema.companies)
    .values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  await subscribeToCompany(database, other.id, company!.id);

  const [disabled, source] = await database.insert(schema.careerSources).values([
    // A guess that was superseded: it is not the source a scan reads, so it is not the timeline's.
    { companyId: company!.id, type: "html", url: "https://acme.example/jobs", status: "disabled" },
    { companyId: company!.id, type: "greenhouse", url: "https://boards.greenhouse.io/acme", status: "active", confidence: 0.9 },
  ]).returning();
  const [run] = await database.insert(schema.discoveryRuns).values({
    companyId: company!.id,
    status: "resolved",
    chosenSourceId: source!.id,
    candidates: [{ spec: { type: "greenhouse", url: "https://boards.greenhouse.io/acme" }, confidence: 0.98, method: "ats_guess" }],
    startedAt: new Date(Date.now() - 120_000),
    finishedAt: new Date(Date.now() - 80_000),
  }).returning();
  await database.insert(schema.scans).values([
    { sourceId: source!.id, status: "ok", postingsFound: 2_331, durationMs: 42_000, startedAt: new Date(Date.now() - 70_000) },
    // An older scan of the same source, and one of the source nobody reads any more.
    { sourceId: source!.id, status: "failed", error: "older", startedAt: new Date(Date.now() - 600_000) },
    { sourceId: disabled!.id, status: "ok", postingsFound: 9, startedAt: new Date(Date.now() - 10_000) },
  ]);

  const jobs = await database.insert(schema.jobs).values([0, 1, 2].map((n) => ({
    companyId: company!.id, sourceId: source!.id, title: `Role ${n}`, normalizedTitle: `role ${n}`,
    externalKey: `key-${n}`, url: `https://boards.greenhouse.io/acme/${n}`,
  }))).returning();
  await database.insert(schema.userJobs).values([
    { userId: user.id, jobId: jobs[0]!.id, inTable: true, keywordMatched: true, fitScore: 80 },
    { userId: user.id, jobId: jobs[1]!.id, inTable: true, keywordMatched: true, scoreState: "queued" },
    // Outside this account's gate: stored, not in its table, and not counted as a match.
    { userId: user.id, jobId: jobs[2]!.id, inTable: false, keywordMatched: false },
    // The neighbour's table is wider. None of it is this account's business.
    { userId: other.id, jobId: jobs[0]!.id, inTable: true, keywordMatched: true, fitScore: 40 },
    { userId: other.id, jobId: jobs[2]!.id, inTable: true, keywordMatched: true, fitScore: 30 },
  ]);

  const rows = await companySetupRows(user.id, company!.id);
  expect(rows.run).toMatchObject({ status: "resolved", chosenSourceId: source!.id });
  expect(rows.run!.candidates).toEqual([{ type: "greenhouse", url: "https://boards.greenhouse.io/acme", confidence: 0.98 }]);
  expect(rows.source).toMatchObject({ id: source!.id, type: "greenhouse", status: "active" });
  expect(rows.scan).toMatchObject({ status: "ok", postingsFound: 2_331, durationMs: 42_000 });
  expect(rows.table).toEqual({ inTable: 2, scoring: 1, scored: 1 });
  expect(rows.discoveryTask).toBeNull();
  expect(rows.scanTask).toBeNull();
  expect(run!.id).toBeTruthy();

  const steps = narrateCompanySetup(rows, new Date(), CONTEXT);
  expect(steps.map((step) => step.text)).toEqual([
    "Found the careers page",
    "Found a Greenhouse board (98%)",
    "Scanned 2,331 postings · 2 match your filters",
    "Scoring 1 role",
  ]);
  expect(companySetupLine(steps)).toBe("Scanned 2,331 postings · 2 match your filters · scoring");

  // The neighbour sees the same board and its own four figures.
  const theirs = await companySetupRows(other.id, company!.id);
  expect(theirs.table).toEqual({ inTable: 2, scoring: 0, scored: 2 });
  expect(companySetupLine(narrateCompanySetup(theirs, new Date(), CONTEXT))).toBe("Scored · next scheduled scan at 06:00 Europe/London");
});

it("reads the work in flight, and leaves a logo capture out of it", async () => {
  const [company] = await database.insert(schema.companies)
    .values({ name: "Fresh", domain: "fresh.example", homepageUrl: "https://fresh.example" }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  const claimed = new Date(Date.now() - 40_000);
  await database.insert(schema.tasks).values([
    { type: "discover", payload: { companyId: company!.id, reason: "added" }, status: "running", startedAt: claimed, dedupeKey: `discover:${company!.id}` },
    // A logo capture rides the same task type and says nothing about a careers page.
    { type: "discover", payload: { companyId: company!.id, logoOnly: "true", homepageUrl: "https://fresh.example" }, status: "queued", dedupeKey: `company_logo:${company!.id}` },
    { type: "scan_company", payload: { companyId: company!.id, trigger: "manual" }, status: "queued", dedupeKey: `scan_company:${company!.id}` },
  ]);

  const rows = await companySetupRows(user.id, company!.id);
  expect(rows.run).toBeNull();
  expect(rows.discoveryTask).toEqual({ state: "running", startedAt: claimed });
  expect(rows.scanTask).toEqual({ state: "queued", startedAt: null });
  expect(rows.table).toEqual({ inTable: 0, scoring: 0, scored: 0 });

  const steps = narrateCompanySetup(rows, new Date(), CONTEXT);
  expect(steps[0]).toMatchObject({ status: "running", text: "Finding the careers page" });
  expect(steps[0]!.elapsedMs).toBeGreaterThanOrEqual(40_000);
  expect(steps[2]).toMatchObject({ status: "running", text: "Scanning the board", elapsedMs: null });
});
