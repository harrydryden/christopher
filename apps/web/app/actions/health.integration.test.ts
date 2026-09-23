/**
 * Health's one-click resolutions, against the database (R-9.2).
 *
 * Every control on the attention list posts to an action that already existed, so what is tested
 * here is that each one leaves the rows in the state the item promised: a confirmed candidate
 * becomes the source a scan reads, a pasted URL becomes a discovery task, pausing a company stops
 * it being asked about, and declining a re-discovery proposal ends the run instead of hiding it.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { disableSource, markSourceConfirmed, pasteDiscoveryUrl, pauseCompany, rediscoverCompany, useDiscoveryCandidate } from "./companies";
import { keepCurrentSource } from "./health";
import { countHealthItems, healthItems } from "@/lib/queries/health";

const CANDIDATES = [
  { spec: { type: "greenhouse", url: "https://boards.greenhouse.io/acme" }, confidence: 0.98, method: "ats_guess" },
  { spec: { type: "html", url: "https://acme.example/careers" }, confidence: 0.4, method: "heuristic" },
];

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_b");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, ai_calls, user_settings, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!, "health@example.com"));
});

/** A followed company, optionally with the run and source the item under test needs. */
async function fixture(options: { candidates?: unknown[]; sourceStatus?: "active" | "failing" | "blocked" | "needs_confirmation" } = {}) {
  const [company] = await database.insert(schema.companies)
    .values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  const [source] = options.sourceStatus
    ? await database.insert(schema.careerSources)
        .values({ companyId: company!.id, type: "lever", url: "https://jobs.lever.co/acme", status: options.sourceStatus, consecutiveFailures: options.sourceStatus === "failing" ? 4 : 0 })
        .returning()
    : [];
  const [run] = options.candidates
    ? await database.insert(schema.discoveryRuns)
        .values({ companyId: company!.id, status: "needs_confirmation", candidates: options.candidates })
        .returning()
    : [];
  return { company: company!, source, run };
}

const sourcesOf = (companyId: string) => database.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, companyId));
const tasksOf = (type: "discover" | "scan_company") => database.select().from(schema.tasks).where(eq(schema.tasks.type, type));

it("confirms a candidate into the source a scan reads, and queues that scan", async () => {
  const { company, run } = await fixture({ candidates: CANDIDATES });
  expect((await healthItems(user.id)).map((item) => item.kind)).toEqual(["needs_confirmation"]);

  await useDiscoveryCandidate(run!.id, 0);

  const sources = await sourcesOf(company.id);
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({ type: "greenhouse", url: CANDIDATES[0]!.spec.url, status: "active", confirmedByUser: true });
  const [resolved] = await database.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, run!.id));
  expect(resolved).toMatchObject({ status: "resolved", chosenSourceId: sources[0]!.id });
  expect((await tasksOf("scan_company")).map((task) => task.payload)).toEqual([{ companyId: company.id, trigger: "manual" }]);
  // Resolved is resolved: the item has gone, and so has the sidebar's count of it.
  expect(await healthItems(user.id)).toEqual([]);
  expect(await countHealthItems(user.id)).toBe(0);
});

it("turns a pasted URL into a discovery task for that URL alone", async () => {
  const { company } = await fixture();
  expect((await healthItems(user.id)).map((item) => item.kind)).toEqual(["no_source"]);

  const form = new FormData();
  form.set("url", "https://acme.example/careers");
  await pasteDiscoveryUrl(company.id, form);

  const queued = await tasksOf("discover");
  expect(queued).toHaveLength(1);
  expect(queued[0]!.payload).toEqual({ companyId: company.id, url: "https://acme.example/careers", reason: "pasted" });
  expect(queued[0]!.dedupeKey).toBe(`discover:${company.id}:url:https://acme.example/careers`);
});

it("re-discovers, disables a source and pauses a company from the failing item", async () => {
  const { company, source } = await fixture({ sourceStatus: "failing" });
  const [failing] = await healthItems(user.id);
  expect(failing).toMatchObject({ kind: "failing" });
  expect(failing!.source).toMatchObject({ id: source!.id, consecutiveFailures: 4 });

  await rediscoverCompany(company.id);
  expect((await tasksOf("discover")).map((task) => task.payload)).toEqual([{ companyId: company.id, reason: "manual" }]);

  await disableSource(source!.id);
  expect((await sourcesOf(company.id))[0]!.status).toBe("disabled");
  // With nothing left that a scan can read, the item becomes the other one — still one item.
  expect((await healthItems(user.id)).map((item) => item.kind)).toEqual(["no_source"]);

  // Pausing is the nearest existing state change to "dismiss": the company stops being asked about.
  await pauseCompany(company.id);
  const [subscription] = await database.select().from(schema.companySubscriptions)
    .where(and(eq(schema.companySubscriptions.userId, user.id), eq(schema.companySubscriptions.companyId, company.id)));
  expect(subscription!.status).toBe("paused");
  expect(await healthItems(user.id)).toEqual([]);
  expect(await countHealthItems(user.id)).toBe(0);
});

it("confirms a source nobody had stood behind", async () => {
  const { company, source } = await fixture({ sourceStatus: "needs_confirmation" });
  expect((await healthItems(user.id)).map((item) => item.kind)).toEqual(["needs_confirmation"]);

  await markSourceConfirmed(source!.id);

  expect((await sourcesOf(company.id))[0]).toMatchObject({ status: "active", confirmedByUser: true });
  expect(await healthItems(user.id)).toEqual([]);
});

it("keeps the current source, resolving the proposal onto it rather than inventing a state", async () => {
  const { company, source, run } = await fixture({ candidates: CANDIDATES, sourceStatus: "active" });
  const [proposal] = await healthItems(user.id);
  expect(proposal).toMatchObject({ kind: "rediscovery", runId: run!.id });
  expect(proposal!.candidates).toHaveLength(2);

  await keepCurrentSource(run!.id);

  // The run ends the way accepting a candidate ends it: resolved, onto a source, and the source
  // now carries a follower's confirmation. Nothing new is written anywhere.
  const [resolved] = await database.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, run!.id));
  expect(resolved).toMatchObject({ status: "resolved", chosenSourceId: source!.id });
  expect(resolved!.finishedAt).not.toBeNull();
  expect((await sourcesOf(company.id))[0]).toMatchObject({ id: source!.id, status: "active", confirmedByUser: true });
  expect(await healthItems(user.id)).toEqual([]);
  // A second press is somebody else's answer already recorded, not an error.
  await keepCurrentSource(run!.id);
});

it("refuses to resolve a company this account does not follow", async () => {
  const { run } = await fixture({ candidates: CANDIDATES, sourceStatus: "active" });
  await database.delete(schema.companySubscriptions).where(eq(schema.companySubscriptions.userId, user.id));
  await expect(keepCurrentSource(run!.id)).rejects.toThrow("You do not follow this company.");
  const [untouched] = await database.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, run!.id));
  expect(untouched!.status).toBe("needs_confirmation");
});
