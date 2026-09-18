/**
 * The catalogue is shared and a company is scanned once a day however many accounts follow it.
 * These are the interface's follow paths: adding a URL that is already in the catalogue must
 * subscribe the account and admit what the last scan stored, and must not queue a second scan.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let first: User;
let second: User;
let firstCookie: string;
let secondCookie: string;

vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { addCompanies, rescanCompany, unfollowCompany } from "./companies";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "companies-test-secret";
});
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, settings, users restart identity cascade`);
  ({ user: first, cookie: firstCookie } = await signInTestUser(database, process.env.SESSION_SECRET!, "one@example.com"));
  ({ user: second, cookie: secondCookie } = await signInTestUser(database, process.env.SESSION_SECRET!, "two@example.com", "member"));
  session = firstCookie;
});

const urls = (value: string) => { const form = new FormData(); form.set("urls", value); return form; };
const tasksOfType = (type: "scan_company" | "discover" | "reevaluate_gate") =>
  database.select().from(schema.tasks).where(eq(schema.tasks.type, type));

/** The company one account already added, with a source and a posting a scan stored. */
async function scannedCompany() {
  const [company] = await database.select().from(schema.companies);
  const [source] = await database.insert(schema.careerSources)
    .values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs", status: "active" }).returning();
  const [job] = await database.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: "id:1", title: "Operations Manager",
    normalizedTitle: "operations manager", url: "https://acme.example/jobs/1", location: "London",
  }).returning();
  return { company: company!, job: job! };
}

it("follows a company already in the catalogue instead of adding or scanning a second one", async () => {
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=1");
  expect(await database.select().from(schema.companies)).toHaveLength(1);
  // Adding a company discovers its careers source; it does not scan directly.
  expect(await tasksOfType("discover")).toHaveLength(1);
  expect(await tasksOfType("scan_company")).toHaveLength(0);
  const { company, job } = await scannedCompany();

  // A second account adds the same URL. One catalogue entry, two subscriptions, no second scan.
  session = secondCookie;
  await expect(addCompanies(urls("https://www.acme.example/careers"))).rejects.toThrow("redirect:/companies?added=0&followed=1");
  expect(await database.select().from(schema.companies)).toHaveLength(1);
  expect(await tasksOfType("scan_company")).toHaveLength(0);
  expect(await tasksOfType("discover")).toHaveLength(1);
  const subscriptions = await database.select().from(schema.companySubscriptions);
  expect(subscriptions.map(s => s.userId).sort()).toEqual([first.id, second.id].sort());

  // The new follower's table is filled from what the last scan already stored, per its own gate.
  const views = await database.select().from(schema.userJobs);
  expect(views.map(v => [v.userId, v.jobId, v.inTable, v.seeded])).toEqual([[second.id, job.id, true, true]]);

  // Re-adding it again changes nothing at all.
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=0");
  expect(await tasksOfType("scan_company")).toHaveLength(0);
  expect(await database.select().from(schema.userJobs)).toHaveLength(1);

  // Either follower can ask for a rescan, and both asking queues one shared scan, not two.
  await rescanCompany(company.id);
  session = firstCookie;
  await rescanCompany(company.id);
  const scans = await tasksOfType("scan_company");
  expect(scans).toHaveLength(1);
  expect(scans[0]!.payload).toMatchObject({ companyId: company.id, trigger: "manual" });
});

it("leaves the shared company and the other follower alone when one account stops following", async () => {
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=1");
  const { company, job } = await scannedCompany();
  session = secondCookie;
  await expect(addCompanies(urls("https://acme.example"))).rejects.toThrow("redirect:/companies?added=0&followed=1");
  expect(await database.select().from(schema.userJobs)).toHaveLength(1);

  await expect(unfollowCompany(company.id)).rejects.toThrow("redirect:/companies");
  // The catalogue entry, its source and every observed posting stay; only this account's view goes.
  expect(await database.select().from(schema.companies)).toHaveLength(1);
  expect(await database.select().from(schema.jobs)).toHaveLength(1);
  expect(await database.select().from(schema.userJobs)).toHaveLength(0);
  expect((await database.select().from(schema.companySubscriptions)).map(s => s.userId)).toEqual([first.id]);
  // One active follower is still enough to keep the shared company scanned.
  expect((await database.select().from(schema.companies))[0]!.status).toBe("active");
  expect(job.companyId).toBe(company.id);
});
