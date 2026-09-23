/**
 * What the worker records about its own learning: why a role carries the score it carries, what an
 * application's outcome tells the profile, and when a rejected suggestion stops counting.
 *
 * All three are things the interface reads back and the person acts on, so they are tested at the
 * database rather than against a stubbed query: a `score_state` nobody wrote is a blank em dash,
 * and a rejection that never expires is a filter the person can no longer be offered.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { gzipSync } from "node:zlib";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import {
  handleReevaluateGate,
  handleRescoreAll,
  handleScoreJob,
  handleSuggestFilters,
  handleSynthesizeProfile,
  REJECTED_SUGGESTION_TTL_MS,
} from "./handlers/learning";
import { handleSuggestFromScans } from "./handlers/suggest-from-scans";
import { ensureTestUser } from "./test-users";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test";

let deps: WorkerDeps;
let db: Db;
let userId: string;
const now = new Date("2026-09-19T09:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
  userId = (await ensureTestUser(db, "learning-signals@example.com")).id;
}, 60_000);

afterAll(async () => { await deps?.close(); });

beforeEach(async () => {
  await db.execute(sql`truncate tasks, companies, career_sources, jobs, scans, resource_leases, settings, user_settings,
    company_subscriptions, user_jobs, decisions, applications, filter_suggestions, preference_profiles, ai_calls, ai_reservations, cv_libraries, cv_drafts restart identity cascade`);
  deps.invalidateSettings();
});

const task = (payload: Record<string, unknown>) =>
  ({ id: "00000000-0000-0000-0000-000000000000", type: "score_job", payload, attempts: 1 } as never);

/** An engine that answers, so the handlers get past their "is AI available" guard. */
function aiDeps(over: Record<string, unknown>): WorkerDeps {
  return { ...deps, ai: { ...deps.ai, enabled: true, ...over } } as unknown as WorkerDeps;
}

async function setGate(gate: Record<string, unknown>) {
  const value = { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true, ...gate };
  await db.insert(schema.userSettings).values({ userId, key: "gate", value })
    .onConflictDoUpdate({ target: [schema.userSettings.userId, schema.userSettings.key], set: { value } });
  deps.invalidateSettings();
}

/** One followed company with one posting, and this account's view of it when asked for. */
async function seedRole(over: { title?: string; inTable?: boolean; status?: "open" | "closed"; view?: boolean } = {}) {
  const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.test", homepageUrl: "https://acme.test" }).returning();
  await db.insert(schema.companySubscriptions).values({ userId, companyId: company!.id, status: "active" });
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.test/jobs" }).returning();
  const [job] = await db.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: "id:1", title: over.title ?? "Operations Manager",
    normalizedTitle: (over.title ?? "Operations Manager").toLowerCase(), url: "https://acme.test/jobs/1",
    location: "London", locations: ["London"], status: over.status ?? "open",
  }).returning();
  if (over.view !== false) {
    await db.insert(schema.userJobs).values({
      userId, jobId: job!.id, keywordMatched: true, keywordTerms: ["operations"],
      inTable: over.inTable ?? true, createdAt: now, updatedAt: now,
    });
  }
  return { company: company!, source: source!, job: job! };
}

const viewOf = async (jobId: string) =>
  (await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))))[0]!;

// --- 2.7: a blank score says which of its five causes it is ---------------------------------

it("names every outcome of a scoring attempt on the view the table reads", async () => {
  const scoreJob = vi.fn().mockResolvedValue({ score: 80, verdict: "strong", rationale: "Fits." });
  const scored = aiDeps({ scoreJob });

  const { job } = await seedRole();
  expect(await handleScoreJob(task({ userId, jobId: job.id }), scored)).toMatchObject({ score: 80 });
  expect(await viewOf(job.id)).toMatchObject({ scoreState: "scored" });
  expect((await viewOf(job.id)).scoreStateAt).toEqual(now);

  // Asked again with nothing changed: the stored score still stands, so the row still reads scored.
  await db.update(schema.userJobs).set({ scoreState: null, scoreStateAt: null });
  expect(await handleScoreJob(task({ userId, jobId: job.id }), scored)).toEqual({ skipped: "scoring inputs unchanged" });
  expect(scoreJob).toHaveBeenCalledTimes(1);
  expect(await viewOf(job.id)).toMatchObject({ scoreState: "scored" });

  // The vacancy went before its turn came round: never scored, and never "waiting" either.
  await db.update(schema.jobs).set({ status: "closed" }).where(eq(schema.jobs.id, job.id));
  expect(await handleScoreJob(task({ userId, jobId: job.id }), scored)).toEqual({ skipped: "job is closed" });
  expect(await viewOf(job.id)).toMatchObject({ scoreState: "closed" });

  // Neither matched nor shortlisted when the task ran.
  await db.update(schema.jobs).set({ status: "open" }).where(eq(schema.jobs.id, job.id));
  await db.update(schema.userJobs).set({ inTable: false });
  expect(await handleScoreJob(task({ userId, jobId: job.id }), scored)).toEqual({ skipped: "role does not match and is not shortlisted" });
  expect(await viewOf(job.id)).toMatchObject({ scoreState: "ineligible" });

  // This account's month is spent: refused, not queued, and the row says which.
  await db.update(schema.userJobs).set({ inTable: true });
  await db.insert(schema.userSettings).values({ userId, key: "aiBudgetUsd", value: 1 });
  await db.insert(schema.aiCalls).values({ userId, callSite: "A5", model: "fixture", costUsd: 1, at: now });
  deps.invalidateSettings();
  expect(await handleScoreJob(task({ userId, jobId: job.id }), scored)).toEqual({ skipped: "account ai budget exceeded" });
  expect(await viewOf(job.id)).toMatchObject({ scoreState: "budget" });
  expect(scoreJob).toHaveBeenCalledTimes(1);
});

it("scores a role on the confirmed evidence that bears on it, bounded, never on the whole library", async () => {
  const scoreJob = vi.fn().mockResolvedValue({ score: 70, verdict: "strong", rationale: "Fits." });
  const scored = aiDeps({ scoreJob });
  const { job } = await seedRole();
  const row = (text: string) => `${text} `.repeat(12).trim();
  const library = (hobby: string) => ({
    name: "Candidate", contact: "", profile: "Operations leader",
    entries: [
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `design${index}`, kind: "experience" as const, heading: `Brand designer ${index}`,
        details: row(`Designed identity ${index}`), confirmedResponsibilities: [row(`Designed identity ${index}`)],
      })),
      { id: "ops", kind: "experience" as const, heading: "Operations Manager", details: "Ran operations for a 40-person warehouse\nNot confirmed yet",
        confirmedResponsibilities: ["Ran operations for a 40-person warehouse"] },
      { id: "hobby", kind: "interest" as const, heading: "Interests", details: hobby },
    ],
  });
  await db.insert(schema.cvLibraries).values({ userId, version: 1, content: library("Sailing") });
  await handleScoreJob(task({ userId, jobId: job.id }), scored);
  const input = scoreJob.mock.calls[0]![0] as { profileMarkdown: string; evidence: string };
  // The library no longer rides along inside the profile.
  expect(input.profileMarkdown).not.toContain("Designed identity");
  // The operations evidence leads, confirmed rows only, and the whole of it fits a fixed bound.
  expect(input.evidence.split("\n").slice(0, 2)).toEqual(["Operations Manager (experience)", "- Ran operations for a 40-person warehouse"]);
  expect(input.evidence).not.toContain("Not confirmed yet");
  expect(input.evidence.length).toBeLessThanOrEqual(8_100);
  expect(input.evidence).toContain("(more evidence not shown)");

  // An edit to evidence this role never sees leaves its inputs, and so its score, alone.
  await db.insert(schema.cvLibraries).values({ userId, version: 2, content: library("Sailing and climbing") });
  expect(await handleScoreJob(task({ userId, jobId: job.id }), scored)).toEqual({ skipped: "scoring inputs unchanged" });
  expect(scoreJob).toHaveBeenCalledTimes(1);
});

it("marks a view queued in the statement that queues its score, from the gate and from a rescore", async () => {
  await setGate({});
  const { job } = await seedRole({ view: false });

  // The gate admits the role and queues its score: the view says so from the moment it exists.
  await handleReevaluateGate({ payload: { userId }, type: "reevaluate_gate", attempts: 1 } as never, deps);
  const admitted = await viewOf(job.id);
  expect(admitted.inTable).toBe(true);
  expect(admitted.scoreState).toBe("queued");
  expect(admitted.scoreStateAt).toEqual(now);
  expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"))).toHaveLength(1);

  // A new profile version re-scores everything in the table, and every row says it is waiting.
  await db.update(schema.userJobs).set({ scoreState: "scored", fitScore: 60 });
  await db.execute(sql`truncate tasks`);
  expect(await handleRescoreAll({ payload: { userId }, type: "rescore_all", attempts: 1 } as never, deps)).toEqual({ queued: 1 });
  expect((await viewOf(job.id)).scoreState).toBe("queued");
});

// --- 6.2: outcomes reach the preference profile --------------------------------------------

it("gives the profile synthesis the outcomes its applications reached, apart from the decisions", async () => {
  const { job } = await seedRole();
  await db.insert(schema.userSettings).values({ userId, key: "seedProfile", value: "Operations leader in London." });
  deps.invalidateSettings();
  await db.insert(schema.decisions).values({
    userId, jobId: job.id, decision: "apply", reason: "Right size of team",
    jobTitle: "Operations Manager", companyName: "Acme", createdAt: daysAgo(30),
  });
  // Two rows for the same role: only the newest says where it ended up.
  await db.insert(schema.applications).values([
    { userId, jobId: job.id, jobTitle: "Operations Manager", companyName: "Acme", appliedOn: "2026-06-01", status: "rejected", history: [], createdAt: daysAgo(40) },
    { userId, jobId: job.id, jobTitle: "Operations Manager", companyName: "Acme", appliedOn: "2026-08-01", status: "accepted", history: [], createdAt: daysAgo(5) },
  ]);

  const synthesizeProfile = vi.fn().mockResolvedValue({ markdown: "## Target roles\nOperations", openQuestions: [] });
  await handleSynthesizeProfile({ payload: { userId }, type: "synthesize_profile", attempts: 1 } as never, aiDeps({ synthesizeProfile }));

  const input = synthesizeProfile.mock.calls[0]![0] as { outcomes: Array<Record<string, string>>; decisions: unknown[] };
  expect(input.outcomes).toEqual([
    { title: "Operations Manager", company: "Acme", status: "accepted", appliedOn: "2026-08-01" },
  ]);
  // The decision the person took is still its own input; the outcome does not replace it.
  expect(input.decisions).toHaveLength(1);
});

// --- 2.6 / R-6.9: a rejection stands for sixty days, and no longer ---------------------------

it("stops counting a filter suggestion's rejection once it is sixty days old", async () => {
  const { job } = await seedRole();
  await db.insert(schema.decisions).values({
    userId, jobId: job.id, decision: "skip", reason: "Too junior", jobTitle: "Operations Manager", companyName: "Acme",
  });
  const suggestion = { type: "keyword_include" as const, value: { term: "logistics" }, evidence: ["two skips"], rationale: "Two skips at logistics firms." };
  const reject = async (resolvedAt: Date) => {
    await db.execute(sql`truncate filter_suggestions`);
    await db.insert(schema.filterSuggestions).values({
      userId, type: "keyword_include", value: { term: "logistics" }, status: "rejected",
      createdAt: resolvedAt, resolvedAt,
    });
  };
  const run = async () => {
    const suggestFilters = vi.fn().mockResolvedValue([suggestion]);
    const result = await handleSuggestFilters({ payload: { userId }, type: "suggest_filters", attempts: 1 } as never, aiDeps({ suggestFilters }));
    const passed = (suggestFilters.mock.calls[0]![0] as { previouslyRejected: unknown[] }).previouslyRejected;
    return { result, passed, pending: await db.select().from(schema.filterSuggestions).where(eq(schema.filterSuggestions.status, "pending")) };
  };

  // Rejected last week: the model is told so, and a repeat proposal is not filed again.
  await reject(daysAgo(7));
  const fresh = await run();
  expect(fresh.passed).toEqual([{ type: "keyword_include", value: { term: "logistics" } }]);
  expect(fresh.result).toEqual({ suggestions: 0 });
  expect(fresh.pending).toHaveLength(0);

  // Rejected before the window: it is no longer evidence of anything, so the term may be offered again.
  await reject(new Date(now.getTime() - REJECTED_SUGGESTION_TTL_MS - 86_400_000));
  const stale = await run();
  expect(stale.passed).toEqual([]);
  expect(stale.result).toEqual({ suggestions: 1 });
  expect(stale.pending.map(row => (row.value as { term: string }).term)).toEqual(["logistics"]);
});

it("offers a term from the scans again once its rejection has expired", async () => {
  await setGate({});
  const { source } = await seedRole({ view: false });
  const postings = Array.from({ length: 4 }, (_, index) => ({ title: `Partnerships Manager ${index}`, location: "London" }));
  await db.insert(schema.scans).values({
    sourceId: source.id, status: "ok", startedAt: daysAgo(1), finishedAt: daysAgo(1), postingsFound: postings.length,
    rawSnapshot: gzipSync(Buffer.from(JSON.stringify({ version: 2, postings }))).toString("base64"),
  });
  const fromScans = { payload: { userId }, type: "suggest_from_scans", attempts: 1 } as never;
  const filed = async () => (await db.select().from(schema.filterSuggestions))
    .map(row => ({ type: row.type, term: (row.value as { term: string }).term }));

  // What the scans propose when nothing has been rejected, so the rest of the test is not
  // pinned to whichever vocabulary term the miner happens to pick.
  await handleSuggestFromScans(fromScans, deps);
  const proposed = await filed();
  expect(proposed.length).toBeGreaterThan(0);
  const taken = proposed[0]!;

  const reject = async (resolvedAt: Date) => {
    await db.execute(sql`truncate filter_suggestions`);
    await db.insert(schema.filterSuggestions).values({
      userId, type: taken.type, value: { term: taken.term, source: "scans" }, status: "rejected",
      createdAt: resolvedAt, resolvedAt,
    });
  };

  await reject(daysAgo(7));
  await handleSuggestFromScans(fromScans, deps);
  expect((await filed()).filter(row => row.term === taken.term)).toHaveLength(1); // only the rejection itself

  await reject(new Date(now.getTime() - REJECTED_SUGGESTION_TTL_MS - 86_400_000));
  await handleSuggestFromScans(fromScans, deps);
  expect((await filed()).filter(row => row.term === taken.term)).toHaveLength(2); // the expired rejection and a fresh proposal
});
