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
import { createTestDb } from "@/test/db";
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
import { cvBuildQuote, cvEditCosts, cvQuoteButtonLine, cvQuoteLine, generatingDraftRemainingUsd, queuedDraftParts } from "./cv-quote";

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
  const client = createTestDb();
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

it("prices a pasted description, not the stored one it replaces", async () => {
  const job = await visibleRole();
  await saveLibrary();
  const pasted = `${DESCRIPTION}\n${"Own the finance operating model end to end. ".repeat(80)}`;
  const quote = await cvBuildQuote(user.id, job.id, new Date(), { description: pasted });
  expect(quote.estimateUsd).toBeCloseTo(
    estimateCvBuildUsd("claude-fable-5-1", { libraryBytes: quote.libraryBytes, descriptionBytes: Buffer.byteLength(pasted.trim()) }, "tailored"),
    6,
  );
  expect(quote.estimateUsd).toBeGreaterThan((await cvBuildQuote(user.id, job.id)).estimateUsd);
  // A blank paste is no paste: the stored description is what the build would use.
  expect((await cvBuildQuote(user.id, job.id, new Date(), { description: "   " })).estimateUsd).toBe((await cvBuildQuote(user.id, job.id)).estimateUsd);
});

it("counts the builds this account has waiting in the queue, which hold nothing yet", async () => {
  const job = await visibleRole();
  await saveLibrary();
  const alone = await cvBuildQuote(user.id, job.id);
  expect(alone.queuedUsd).toBe(0);
  const snapshot = { name: "Example", contact: "", profile: "Leader", entries: [] };
  const draft = (status: "queued" | "generating" | "ready") => ({
    userId: user.id, jobTitle: "Role", companyName: "Co", jobDescription: DESCRIPTION, libraryVersion: 1,
    librarySnapshot: snapshot, model: "claude-fable-5-1", status, buildCheckpoint: { tailoringEnabled: true },
  });
  // Only the queued one here: the generating build is counted by its remaining stages, below.
  await database.insert(schema.cvDrafts).values([draft("queued"), draft("generating"), draft("ready")]);
  const quote = await cvBuildQuote(user.id, job.id);
  expect(quote.inFlightUsd).toBeGreaterThan(0);
  const expected = estimateCvBuildUsd("claude-fable-5-1", { libraryBytes: Buffer.byteLength(JSON.stringify(snapshot)), descriptionBytes: Buffer.byteLength(DESCRIPTION) }, "tailored");
  // Measured in the database, as jsonb text, which spaces its separators: within a cent.
  expect(quote.queuedUsd).toBeCloseTo(expected, 2);
  expect(quote.leftUsd).toBeCloseTo(alone.leftUsd - quote.queuedUsd - quote.inFlightUsd, 6);
});

it("counts what a running build will still admit, beyond the one stage it holds", async () => {
  const job = await visibleRole();
  await saveLibrary();
  const now = new Date();
  const snapshot = { name: "Example", contact: "", profile: "Leader", entries: [] };
  const requirements = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}` }));
  // Tailored, rubric and plan paid for, one of three audit batches saved: writing is running now.
  const [running] = await database.insert(schema.cvDrafts).values({
    userId: user.id, jobTitle: "Role", companyName: "Co", jobDescription: DESCRIPTION, libraryVersion: 1,
    librarySnapshot: snapshot, model: "test-model", status: "generating",
    buildCheckpoint: {
      v: 2, promptSetVersion: "p", tailoringEnabled: true, rubric: { requirements }, tailoringPlan: {},
      stages: { rubric: { key: "k", at: "t", value: {} }, plan: { key: "k", at: "t", value: {} }, "audit[0]": { key: "k", at: "t", value: {} } },
    } as never,
  }).returning();
  await database.insert(schema.aiReservations).values({
    userId: user.id, callSite: "CV", amount: 0.05, refId: running!.id, expiresAt: new Date(now.getTime() + 600_000),
  });
  const quote = await cvBuildQuote(user.id, job.id, now);
  const size = { libraryBytes: Buffer.byteLength(JSON.stringify(snapshot)), descriptionBytes: Buffer.byteLength(DESCRIPTION) };
  const base = { model: "test-model", ...size, hasRubric: true, hasPlan: true, hasContent: false, requirements: 20, tailoringEnabled: true, mode: null, improvementAttempted: false };
  const expected = generatingDraftRemainingUsd({ ...base, stageKeys: ["rubric", "plan", "audit[0]"], heldUsd: 0.05 });
  // Measured in the database, as jsonb text, which spaces its separators: within a cent.
  expect(quote.inFlightUsd).toBeCloseTo(expected, 2);
  expect(quote.heldUsd).toBeCloseTo(0.05, 6);
  // Writing, two audit batches, the improvement and its re-check are still to come; the rubric and
  // the plan are not, and neither is the batch already saved.
  const whole = generatingDraftRemainingUsd({ ...base, hasRubric: false, hasPlan: false, stageKeys: [], heldUsd: 0 });
  expect(expected).toBeGreaterThan(0);
  expect(expected).toBeLessThan(whole);
  // A build assessing saved wording pays for no writing and no improvement.
  expect(generatingDraftRemainingUsd({ ...base, mode: "assess", stageKeys: ["rubric"], heldUsd: 0 })).toBeLessThan(expected);

  // Committed to that build, the month cannot afford another: the refusal names both kinds of hold.
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: quote.estimateUsd + 0.05 + expected / 2 });
  const refused = await cvBuildQuote(user.id, job.id, now);
  expect(refused.refusal).toContain("held by builds queued or in flight");
  expect(refused.refusal).not.toContain("held by calls in flight");
});

it("chooses what a queued build will pay for the way the worker does", () => {
  expect(queuedDraftParts({ hasContent: false, checkpoint: { tailoringEnabled: true } })).toBe("tailored");
  expect(queuedDraftParts({ hasContent: false, checkpoint: { tailoringEnabled: true, quizCompleted: true } })).toBe("tailored_completion");
  expect(queuedDraftParts({ hasContent: false, checkpoint: { mode: "improve" } })).toBe("tailored");
  expect(queuedDraftParts({ hasContent: false, checkpoint: null })).toBe("all");
  // Typed wording is assessed; the build's own wording still has its optional revision to come.
  expect(queuedDraftParts({ hasContent: true, checkpoint: {} })).toBe("assessment");
  expect(queuedDraftParts({ hasContent: true, checkpoint: { tailoringEnabled: true, contentAt: "x" } })).toBe("tailored_assessment");
  expect(queuedDraftParts({ hasContent: true, checkpoint: { tailoringEnabled: true, contentAt: "x", improvementAttempted: true } })).toBe("assessment");
});
