/**
 * What the review panel is handed when a row expands.
 *
 * The panel offers the build where the shortlist was made (3.5), so the price of that build comes
 * back with the description rather than on a second request — and only for the roles the offer
 * applies to. Everything here reads through this account's own view of a role: another account's
 * shortlist, spend and Library are none of its business.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { aiBudgetWindowStart } from "@ava/core";
import { eq, sql } from "drizzle-orm";
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

import { roleDetails } from "./decisions";

const DESCRIPTION = [
  "Head of Operations at a community health provider.",
  "You will own service delivery for twelve sites and lead four operations managers.",
  "Candidates need five years of operations leadership in a regulated environment.",
].join("\n");

const LIBRARY = {
  name: "Rowan Mercer",
  contact: "Manchester",
  profile: "Operations leader.",
  structuredExperience: true as const,
  employment: [
    { id: "emp-1", company: "Northwind", jobTitle: "Head of Operations", startDate: "2020-01", endDate: "", current: true },
  ],
  entries: [
    {
      id: "ev-1",
      kind: "experience" as const,
      status: "active" as const,
      employmentId: "emp-1",
      heading: "Head of Operations · Northwind",
      details: "Owned the operating plan for eleven clinics.\nLed four operations managers.",
      confirmedResponsibilities: ["Owned the operating plan for eleven clinics.", "Led four operations managers."],
    },
  ],
};

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "decisions-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate ai_calls, ai_reservations, cv_libraries, cv_drafts, companies, decisions, tasks, user_settings, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});

let postings = 0;

/** A posting this account follows and has in its table, with the description the panel shows. */
async function role(decision: "apply" | null = "apply") {
  const nth = ++postings;
  const [company] = await database.insert(schema.companies)
    .values({ name: "Meridian", domain: `meridian-${nth}.example`, homepageUrl: `https://meridian-${nth}.example` }).returning();
  const [source] = await database.insert(schema.careerSources)
    .values({ companyId: company!.id, type: "html", url: "https://meridian.example/jobs" }).returning();
  const [job] = await database.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: `one-${nth}`, title: "Head of Operations",
    normalizedTitle: "head of operations", url: `https://meridian.example/jobs/${nth}`,
    location: "Manchester", locations: ["Manchester"], descriptionText: DESCRIPTION, descriptionSource: "direct",
  }).returning();
  await subscribeToCompany(database, user.id, company!.id);
  await database.insert(schema.userJobs).values({
    userId: user.id, jobId: job!.id, inTable: true, keywordMatched: true, keywordTerms: ["operations"],
  });
  if (decision) {
    await database.insert(schema.decisions).values({
      userId: user.id, jobId: job!.id, decision, jobTitle: job!.title, companyName: company!.name,
    });
  }
  return job!;
}

const saveLibrary = () => database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: LIBRARY });

async function detailsFor(jobId: string) {
  const result = await roleDetails(jobId);
  if (!result.ok) throw new Error(result.error);
  return result.details;
}

describe("what the review panel loads on expand", () => {
  it("prices the build beside the shortlist it was made from", async () => {
    const job = await role();
    await saveLibrary();

    const details = await detailsFor(job.id);
    expect(details.description).toBe(DESCRIPTION);
    expect(details.keywordTerms).toEqual(["operations"]);
    expect(details.cvQuote).not.toBeNull();
    // "Build a CV for this role · about $3.10 of $18.40 left"
    expect(details.cvQuote!.line).toMatch(/^about .{0,3}\$\d+\.\d\d of .{0,3}\$\d+\.\d\d left$/);
    expect(details.cvQuote!.refusal).toBeNull();
    expect(details.cvBlocked).toBeNull();
  });

  it("sends an account with nothing to write from to its Library instead of a price", async () => {
    const job = await role();
    expect(await database.select().from(schema.cvLibraries)).toHaveLength(0);
    expect((await detailsFor(job.id)).cvQuote).toBeNull();
  });

  it("quotes nothing for a role that is not a shortlist waiting for its CV", async () => {
    await saveLibrary();
    // Undecided: the panel offers a decision, not a build.
    const matched = await role(null);
    expect((await detailsFor(matched.id)).cvQuote).toBeNull();

    // Shortlisted, but a CV already exists for it, so the role is being applied for: the panel
    // keeps its link to the application rather than offering a second build.
    const applying = await role();
    await database.insert(schema.cvDrafts).values({
      userId: user.id, revision: 1, jobId: applying.id, jobTitle: applying.title, companyName: "Meridian",
      jobDescription: DESCRIPTION, libraryVersion: 1, librarySnapshot: LIBRARY, model: "test", status: "ready",
    });
    expect((await detailsFor(applying.id)).cvQuote).toBeNull();
  });

  it("refuses at the button, in the words the worker would refuse with", async () => {
    const job = await role();
    await saveLibrary();
    await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 4 });
    await database.insert(schema.aiCalls).values({
      userId: user.id, callSite: "CV", model: "test", costUsd: 3.9, at: aiBudgetWindowStart(new Date(), null),
    });

    const details = await detailsFor(job.id);
    expect(details.cvQuote!.refusal).toContain("needs about");
    expect(details.cvQuote!.refusal).toContain("left this month");
  });

  it("holds the build back until the address is confirmed", async () => {
    const job = await role();
    await saveLibrary();
    await database.update(schema.users).set({ role: "member", emailVerifiedAt: null }).where(eq(schema.users.id, user.id));

    const details = await detailsFor(job.id);
    expect(details.cvBlocked).toBe("Confirm your email address to add companies, run discovery and build CVs.");
    expect(details.cvQuote).not.toBeNull();
  });

  it("answers nothing for a role this account cannot see", async () => {
    const stranger = await signInTestUser(database, process.env.SESSION_SECRET!, "stranger@example.com", "member");
    const job = await role();
    session = stranger.cookie;
    expect(await roleDetails(job.id)).toEqual({ ok: false, error: "Role not found." });
  });
});
