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
import { createTestDb } from "@/test/db";
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

import { revalidatePath } from "next/cache";
import { archiveRoles, decide, decideRoles, decideWithUndoToken, decideRolesWithUndoTokens, undoDecisionIfCurrent, undoDecisionsIfCurrent, roleDetails } from "./decisions";

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
  const client = createTestDb();
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

async function currentToken(jobId: string): Promise<{ jobId: string; decisionId: string }> {
  const rows = await database.select({ id: schema.decisions.id, superseded: schema.decisions.superseded })
    .from(schema.decisions).where(eq(schema.decisions.jobId, jobId));
  const standing = rows.find(row => !row.superseded);
  if (!standing) throw new Error(`No standing decision for ${jobId}`);
  return { jobId, decisionId: standing.id };
}

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

  it("brings the role's archive notes, this account's and shared ones only, newest first", async () => {
    const job = await role(null);
    const stranger = await signInTestUser(database, process.env.SESSION_SECRET!, "other-reader@example.com", "member");
    const at = (minutes: number) => new Date(Date.now() - minutes * 60000);
    await database.insert(schema.jobEvents).values([
      { jobId: job.id, userId: user.id, type: "updated", payload: { action: "archived", actor: "system", reason: "No longer matches your criteria" }, at: at(30) },
      { jobId: job.id, userId: user.id, type: "updated", payload: { action: "restored", actor: "user" }, at: at(20) },
      { jobId: job.id, userId: user.id, type: "updated", payload: { action: "archived", actor: "user" }, at: at(10) },
      { jobId: job.id, userId: null, type: "updated", payload: { action: "archived", actor: "system", reason: "Its careers source is no longer checked" }, at: at(5) },
      { jobId: job.id, userId: null, type: "discovered", payload: {}, at: at(60) },
      // Another account's archive of the same shared posting is theirs alone.
      { jobId: job.id, userId: stranger.user.id, type: "updated", payload: { action: "archived", actor: "user", reason: "Theirs" }, at: at(1) },
    ]);
    expect((await detailsFor(job.id)).archiveNotes).toEqual([
      "Archived: Its careers source is no longer checked",
      "Archived: Put away by you",
      "Archived: No longer matches your criteria",
    ]);
    expect((await detailsFor((await role(null)).id)).archiveNotes).toEqual([]);
  });

  it("answers nothing for a role this account cannot see", async () => {
    const stranger = await signInTestUser(database, process.env.SESSION_SECRET!, "stranger@example.com", "member");
    const job = await role();
    session = stranger.cookie;
    expect(await roleDetails(job.id)).toEqual({ ok: false, error: "Role not found." });
  });
});

/**
 * The roles table no longer calls `router.refresh()` after a decision: it relies on the action's
 * own response carrying the re-rendered page, which Next does only when the action revalidates.
 * So every success path must revalidate, and the pages that show a decision must be among them.
 */
describe("what a decision revalidates", () => {
  const revalidated = vi.mocked(revalidatePath);
  const DECIDED_PAGES = [["/"], ["/applications"], ["/companies"], ["/companies/[id]", "page"]];

  it("revalidates the pages that show a decision on every success path of decide", async () => {
    const job = await role(null);
    for (const [decision, reason] of [["apply", ""], ["skip", "Wrong location"]] as const) {
      revalidated.mockClear();
      expect(await decide(job.id, decision, reason)).toEqual({ ok: true });
      expect(revalidated.mock.calls).toEqual(DECIDED_PAGES);
    }
    revalidated.mockClear();
    expect(await undoDecisionIfCurrent(job.id, (await currentToken(job.id)).decisionId)).toEqual({ ok: true });
    expect(revalidated.mock.calls).toEqual(DECIDED_PAGES);
  });

  it("revalidates nothing when decide refuses, so the table knows to put the row back", async () => {
    const job = await role(null);
    revalidated.mockClear();
    expect(await decide(job.id, "skip", "  ")).toMatchObject({ ok: false });
    expect(revalidated).not.toHaveBeenCalled();
  });

  it("revalidates the same pages for a group decision, a group undo and the archive", async () => {
    const ids = [(await role(null)).id, (await role(null)).id];
    const runs = [
      () => decideRoles(ids, "skip", "Not interested"),
      async () => undoDecisionsIfCurrent(await Promise.all(ids.map(currentToken))),
      () => archiveRoles(ids, true),
      () => archiveRoles(ids, false),
    ];
    for (const run of runs) {
      revalidated.mockClear();
      expect(await run()).toEqual({ ok: true });
      expect(revalidated.mock.calls).toEqual(DECIDED_PAGES);
    }
    revalidated.mockClear();
    expect(await decideRoles(ids, "skip", "")).toMatchObject({ ok: false });
    expect(revalidated).not.toHaveBeenCalled();
  });
});

describe("a reversed skip", () => {
  it("queues the role's score again, since a skipped role is left out of scoring", async () => {
    const job = await role(null);
    const scores = async () => (await database.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"))).map(task => task.payload);
    const saved = await decideWithUndoToken(job.id, "skip", "Too junior");
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error);
    expect(await scores()).toEqual([]);
    expect(await undoDecisionIfCurrent(job.id, saved.decisionId)).toEqual({ ok: true });
    expect(await scores()).toEqual([{ userId: user.id, jobId: job.id }]);
  });
});

describe("recent Undo tokens", () => {
  it("rejects tokenless Undo through all four public decision actions without touching a newer decision", async () => {
    const ids = [(await role(null)).id, (await role(null)).id];
    const saved = await decideRolesWithUndoTokens(ids, "apply", "");
    if (!saved.ok) throw new Error(saved.error);
    const newer = await decideWithUndoToken(ids[0]!, "skip", "Wrong location");
    if (!newer.ok) throw new Error(newer.error);
    const undecided = (await role(null)).id;

    const beforeDecisions = await database.select().from(schema.decisions);
    const beforeEvents = await database.select().from(schema.jobEvents);
    const beforeTasks = await database.select().from(schema.tasks);
    const singleRefusal = { ok: false, error: "This Undo needs the latest decision. Reload roles and use Undo there." };
    const groupRefusal = { ok: false, error: "This Undo needs the latest decisions. Reload roles and use Undo there." };
    const runtimeNull = null as unknown as "apply";
    expect(await decide(ids[0]!, null, "")).toEqual(singleRefusal);
    expect(await decideRoles(ids, null, "")).toEqual(groupRefusal);
    expect(await decideWithUndoToken(ids[0]!, runtimeNull, "")).toEqual(singleRefusal);
    expect(await decideRolesWithUndoTokens(ids, runtimeNull, "")).toEqual(groupRefusal);
    expect(await decide(undecided, null, "")).toEqual(singleRefusal);
    expect(await decideRoles([undecided], null, "")).toEqual(groupRefusal);
    expect(await decideWithUndoToken(undecided, runtimeNull, "")).toEqual(singleRefusal);
    expect(await decideRolesWithUndoTokens([undecided], runtimeNull, "")).toEqual(groupRefusal);
    expect(await database.select().from(schema.decisions)).toEqual(beforeDecisions);
    expect(await database.select().from(schema.jobEvents)).toEqual(beforeEvents);
    expect(await database.select().from(schema.tasks)).toEqual(beforeTasks);
    const standing = await database.select({ jobId: schema.decisions.jobId, id: schema.decisions.id })
      .from(schema.decisions).where(eq(schema.decisions.superseded, false));
    expect(new Map(standing.map(row => [row.jobId, row.id]))).toEqual(new Map([
      [ids[0], newer.decisionId], [ids[1], saved.decisionIds[ids[1]!]],
    ]));
  });

  it("refuses an older tab's Undo after a newer decision and reverses only the exact standing row", async () => {
    const job = await role(null);
    const first = await decideWithUndoToken(job.id, "apply", "Strong match");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const second = await decideWithUndoToken(job.id, "skip", "Wrong location");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(first.decisionId).not.toBe(second.decisionId);

    expect(await undoDecisionIfCurrent(job.id, first.decisionId)).toEqual({
      ok: false, error: "This decision changed in another tab. Reload roles before trying again.",
    });
    const standing = await database.select().from(schema.decisions)
      .where(eq(schema.decisions.id, second.decisionId));
    expect(standing[0]).toMatchObject({ decision: "skip", superseded: false });

    expect(await undoDecisionIfCurrent(job.id, second.decisionId)).toEqual({ ok: true });
    const after = await database.select().from(schema.decisions).where(eq(schema.decisions.id, second.decisionId));
    expect(after[0]!.superseded).toBe(true);
  });

  it("returns one standing decision token per role from a bulk save", async () => {
    const ids = [(await role(null)).id, (await role(null)).id];
    const saved = await decideRolesWithUndoTokens(ids, "apply", "");
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error);
    expect(Object.keys(saved.decisionIds).sort()).toEqual([...ids].sort());
    expect(new Set(Object.values(saved.decisionIds)).size).toBe(2);
  });

  it("rejects the whole bulk Undo if one of two decisions changed, then undoes both current tokens", async () => {
    const ids = [(await role(null)).id, (await role(null)).id];
    const first = await decideRolesWithUndoTokens(ids, "apply", "");
    if (!first.ok) throw new Error(first.error);
    const changed = await decideWithUndoToken(ids[1]!, "skip", "Wrong location");
    if (!changed.ok) throw new Error(changed.error);
    const old = ids.map(jobId => ({ jobId, decisionId: first.decisionIds[jobId]! }));

    expect(await undoDecisionsIfCurrent(old)).toEqual({
      ok: false, error: "A selected decision changed in another tab. Reload roles before trying again.",
    });
    const standing = await database.select({ jobId: schema.decisions.jobId, id: schema.decisions.id, decision: schema.decisions.decision })
      .from(schema.decisions).where(eq(schema.decisions.superseded, false));
    expect(new Map(standing.map(row => [row.jobId, { id: row.id, decision: row.decision }]))).toEqual(new Map([
      [ids[0], { id: first.decisionIds[ids[0]!], decision: "apply" }],
      [ids[1], { id: changed.decisionId, decision: "skip" }],
    ]));

    expect(await undoDecisionsIfCurrent([{ jobId: ids[0]!, decisionId: first.decisionIds[ids[0]!]! },
      { jobId: ids[1]!, decisionId: changed.decisionId }])).toEqual({ ok: true });
    expect(await database.select().from(schema.decisions).where(eq(schema.decisions.superseded, false))).toEqual([]);
  });
});

describe("one decision writer", () => {
  /** What a decision left behind for one role, with its own ids written out of it. */
  async function leftBehind(jobId: string) {
    const rows = await database.select().from(schema.decisions).where(eq(schema.decisions.jobId, jobId)).orderBy(schema.decisions.createdAt);
    const events = await database.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(schema.jobEvents.at, schema.jobEvents.id);
    const tasks = await database.select().from(schema.tasks).orderBy(schema.tasks.type);
    const ids = new Map<string, string>([[jobId, "<job>"], ...rows.map((row, i) => [row.id, `<decision ${i}>`] as [string, string])]);
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value), (_key, v) => (typeof v === "string" ? [...ids].reduce((text, [id, name]) => text.replaceAll(id, name), v) : v));
    return {
      decisions: rows.map(({ decision, reason, jobTitle, companyName, jobLocation, jobDepartment, descriptionSnippet, fitScoreAtDecision, superseded }) =>
        ({ decision, reason, jobTitle, companyName, jobLocation, jobDepartment, descriptionSnippet, fitScoreAtDecision, superseded })),
      events: events.map(({ type, userId, payload }) => ({ type, userId, payload })),
      tasks: plain(tasks.map(({ type, payload, dedupeKey, priority, status }) => ({ type, payload, dedupeKey, priority, status }))),
    };
  }

  it("leaves the same rows deciding a role alone as deciding it as a group of one", async () => {
    const [alone, grouped] = [await role(null), await role(null)];
    for (const [decision, reason] of [["apply", "Strong match"], ["skip", "Too junior"]] as const) {
      await database.execute(sql`truncate tasks`);
      expect(await decide(alone.id, decision, reason)).toEqual({ ok: true });
      const one = await leftBehind(alone.id);
      await database.execute(sql`truncate tasks`);
      expect(await decideRoles([grouped.id], decision, reason)).toEqual({ ok: true });
      expect(await leftBehind(grouped.id)).toEqual(one);
    }
    await database.execute(sql`truncate tasks`);
    expect(await undoDecisionIfCurrent(alone.id, (await currentToken(alone.id)).decisionId)).toEqual({ ok: true });
    const one = await leftBehind(alone.id);
    await database.execute(sql`truncate tasks`);
    expect(await undoDecisionsIfCurrent([await currentToken(grouped.id)])).toEqual({ ok: true });
    expect(await leftBehind(grouped.id)).toEqual(one);
  });
});
