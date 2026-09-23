/**
 * What a build is quoted at before it is asked for, and when that quote is a refusal.
 *
 * The figures must be the ones the worker would admit the build against: the same estimator over
 * the same measured inputs, the same monthly window, and the account's own spend and holds — never
 * another account's. The refusal is the sentence the worker would fail the draft with, so a person
 * reads the same words whichever side answered first.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { aiBudgetWindowStart, DEFAULT_ACCOUNT_AI_BUDGET_USD } from "@ava/core";
import { estimateCvBuildUsd } from "../../../packages/ai/src/pricing";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { cvBuildQuote, cvEditCosts, cvQuoteButtonLine, cvQuoteLine } from "./cv-quote";

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
      confirmedResponsibilities: [
        "Owned the operating plan for eleven clinics.",
        "Led four operations managers.",
      ],
    },
  ],
};

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(
    sql`truncate ai_calls, ai_reservations, cv_libraries, companies, user_settings, users restart identity cascade`,
  );
  user = await ensureTestUser(database, "quoted@example.com");
  other = await ensureTestUser(database, "quiet-quote@example.com", "member");
});

/** A role this account can see, with a stored description, as `requestCv` requires. */
async function visibleRole(description: string | null = DESCRIPTION) {
  const [company] = await database
    .insert(schema.companies)
    .values({ name: "Meridian", domain: `meridian-${Date.now()}.example`, homepageUrl: "https://meridian.example" })
    .returning();
  const [source] = await database
    .insert(schema.careerSources)
    .values({ companyId: company!.id, type: "html", url: "https://meridian.example/jobs" })
    .returning();
  const [job] = await database
    .insert(schema.jobs)
    .values({
      companyId: company!.id,
      sourceId: source!.id,
      title: "Head of Operations",
      normalizedTitle: "head of operations",
      externalKey: `meridian-${Date.now()}`,
      url: "https://meridian.example/jobs/head",
      ...(description ? { descriptionText: description, descriptionSource: "direct" as const } : {}),
    })
    .returning();
  await subscribeToCompany(database, user.id, company!.id);
  await database.insert(schema.userJobs).values({ userId: user.id, jobId: job!.id, inTable: true, keywordMatched: true });
  return job!;
}

const saveLibrary = () =>
  database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: LIBRARY });

it("quotes the build this account would pay for, from the same estimator the worker admits with", async () => {
  const job = await visibleRole();
  await saveLibrary();
  const quote = await cvBuildQuote(user.id, job.id);

  // The size it measured is the evidence and the advert, not zero and not somebody's default.
  expect(quote.libraryBytes).toBeGreaterThan(200);
  expect(quote.estimateUsd).toBeCloseTo(
    estimateCvBuildUsd("claude-fable-5-1", { libraryBytes: quote.libraryBytes, descriptionBytes: Buffer.byteLength(DESCRIPTION) }, "tailored"),
    6,
  );
  expect(quote.estimateUsd).toBeGreaterThan(0);
  expect(quote.limitUsd).toBe(DEFAULT_ACCOUNT_AI_BUDGET_USD);
  expect(quote).toMatchObject({ spentUsd: 0, heldUsd: 0, refusal: null });
  expect(quote.leftUsd).toBe(DEFAULT_ACCOUNT_AI_BUDGET_USD);
  expect(cvQuoteLine(quote)).toMatch(/^about .{0,3}\$\d+\.\d\d of your .{0,3}\$\d+\.\d\d left this month$/);
  // The same figures inside a button's own label, where the sentence has to be short.
  expect(cvQuoteButtonLine(quote)).toMatch(/^about .{0,3}\$\d+\.\d\d of .{0,3}\$\d+\.\d\d left$/);
  // There is a Library to write from, which is a different answer from "this build is free".
  expect(quote.hasLibrary).toBe(true);
});

it("counts this account's own spend and its own live holds, and nobody else's", async () => {
  const job = await visibleRole();
  await saveLibrary();
  const now = new Date();
  const since = aiBudgetWindowStart(now, null);
  await database.insert(schema.aiCalls).values([
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 5, at: since },
    // Last month, shared work and another account never touch this account's window.
    { userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 9, at: new Date(since.getTime() - 1000) },
    { userId: null, callSite: "A3", model: "claude-sonnet-5", costUsd: 7, at: since },
    { userId: other.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 6, at: since },
  ]);
  await database.insert(schema.aiReservations).values([
    { userId: user.id, callSite: "CV", amount: 3, expiresAt: new Date(now.getTime() + 600_000) },
    // An expired hold is capacity nothing can still be spending.
    { userId: user.id, callSite: "CV", amount: 4, expiresAt: new Date(now.getTime() - 1_000) },
    { userId: other.id, callSite: "CV", amount: 8, expiresAt: new Date(now.getTime() + 600_000) },
  ]);

  const quote = await cvBuildQuote(user.id, job.id, now);
  expect(quote.spentUsd).toBe(5);
  expect(quote.heldUsd).toBe(3);
  expect(quote.leftUsd).toBeCloseTo(DEFAULT_ACCOUNT_AI_BUDGET_USD - 8, 6);
  expect(quote.refusal).toBeNull();
});

it("refuses in the worker's own words when the estimate does not fit, and never below zero left", async () => {
  const job = await visibleRole();
  await saveLibrary();
  const now = new Date();
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 4 });
  await database.insert(schema.aiCalls).values({
    userId: user.id, callSite: "CV", model: "claude-fable-5-1", costUsd: 3.5, at: aiBudgetWindowStart(now, null),
  });
  await database.insert(schema.aiReservations).values({
    userId: user.id, callSite: "CV", amount: 1, expiresAt: new Date(now.getTime() + 600_000),
  });

  const quote = await cvBuildQuote(user.id, job.id, now);
  expect(quote.limitUsd).toBe(4);
  expect(quote.leftUsd).toBe(0);
  expect(quote.refusal).toMatch(/needs about \$\d+\.\d\d of AI budget/);
  expect(quote.refusal).toContain("your budget of $4 has $0.00 left this month after $1.00 held by calls in flight");
  expect(quote.refusal).toContain("Raise it on Settings, or ask an administrator.");
});

it("still answers when there is no Library and no stored description", async () => {
  const job = await visibleRole(null);
  const quote = await cvBuildQuote(user.id, job.id);
  expect(quote.libraryBytes).toBe(0);
  expect(quote.estimateUsd).toBeGreaterThan(0);
  expect(quote.refusal).toBeNull();
  // Nothing saved to write from: the caller that offers a build sends them to the Library.
  expect(quote.hasLibrary).toBe(false);

  // A role outside this account's table is quoted on the Library alone rather than read from the
  // shared catalogue without an account behind the read.
  await saveLibrary();
  const unseen = await cvBuildQuote(user.id, "00000000-0000-4000-8000-000000000000");
  expect(unseen.libraryBytes).toBeGreaterThan(200);
  expect(unseen.estimateUsd).toBeLessThan((await cvBuildQuote(user.id, job.id)).estimateUsd + 1);
});

it("prices Save Direct Edits below Rebuild from Library, because the wording is already written", () => {
  const size = { libraryBytes: 45_000, descriptionBytes: 9_000 };
  const costs = cvEditCosts("claude-fable-5-1", size);
  expect(costs.assessmentUsd).toBeCloseTo(estimateCvBuildUsd("claude-fable-5-1", size, "assessment"), 6);
  expect(costs.allUsd).toBeCloseTo(estimateCvBuildUsd("claude-fable-5-1", size, "tailored_completion"), 6);
  expect(costs.assessmentUsd).toBeLessThan(costs.allUsd);
});
