/**
 * What the work notice and its poll count as pending for one account: its followed companies'
 * scans and discovery, its own imports and gate re-evaluations, and nothing else. Every open roles
 * or companies tab asks this while work is in flight, so it is also read once rather than per task.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@col/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@col/db/migrate";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@col/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let a: User;
let b: User;
let mine: string;
let theirs: string;
vi.mock("@/lib/db", () => ({ db: () => database }));
import { companyWorkQuery, getCompanyWorkStatus, getRolesWorkStatus } from "./work-status";
import { recordDecisions } from "@/lib/decisions";
import { initialWorkPoll, LONGEST_POLL_MS, stepWorkPoll } from "./polling";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, users restart identity cascade`);
  a = await ensureTestUser(database, "work-a@example.com", "member");
  b = await ensureTestUser(database, "work-b@example.com", "member");
  const [one, two] = await database.insert(schema.companies).values([
    { name: "Mine", domain: "mine.example", homepageUrl: "https://mine.example" },
    { name: "Theirs", domain: "theirs.example", homepageUrl: "https://theirs.example" },
  ]).returning();
  mine = one!.id;
  theirs = two!.id;
  await subscribeToCompany(database, a.id, mine);
  await subscribeToCompany(database, b.id, theirs);
});

async function task(type: typeof schema.tasks.$inferInsert["type"], payload: Record<string, unknown>, status: "queued" | "running" | "done" = "queued") {
  const [row] = await database.insert(schema.tasks).values({ type, payload, status }).returning();
  return row!;
}

const status = (user: User) => getCompanyWorkStatus(user.id);

describe("getCompanyWorkStatus", () => {
  it("is not pending for anyone while only the daily run's fan-out task is queued", async () => {
    await task("run_daily", { trigger: "schedule", runDate: "2026-09-23" });
    expect((await status(a)).active).toBe(false);
    expect((await status(b)).active).toBe(false);
  });

  it("ignores a logo capture for a followed company", async () => {
    await task("discover", { companyId: mine, logoOnly: true, homepageUrl: "https://mine.example" });
    expect((await status(a)).active).toBe(false);
    await task("discover", { companyId: mine, reason: "manual" });
    expect((await status(a)).active).toBe(true);
  });

  it("counts a scan only for the accounts that follow its company", async () => {
    await task("scan_company", { companyId: mine });
    expect((await status(a)).active).toBe(true);
    expect((await status(b)).active).toBe(false);
  });

  it("counts an import only for the account that pasted it, and a gate re-evaluation for its account or all", async () => {
    await task("import_posting", { userId: b.id, companyId: mine, url: "https://mine.example/jobs/1" });
    expect((await status(a)).active).toBe(false);
    expect((await status(b)).active).toBe(true);

    await database.execute(sql`delete from tasks`);
    await task("reevaluate_gate", { userId: a.id });
    expect((await status(a)).active).toBe(true);
    expect((await status(b)).active).toBe(false);
    await task("reevaluate_gate", {});
    expect((await status(b)).active).toBe(true);
  });

  it("changes its version when a followed company's task moves, and only then", async () => {
    const scan = await task("scan_company", { companyId: mine });
    const other = await task("scan_company", { companyId: theirs });
    const before = (await status(a)).version;
    await database.update(schema.tasks).set({ status: "running" }).where(sql`id = ${other.id}`);
    expect((await status(a)).version).toBe(before);
    await database.update(schema.tasks).set({ status: "running" }).where(sql`id = ${scan.id}`);
    expect((await status(a)).version).not.toBe(before);
    await database.update(schema.tasks).set({ status: "done" }).where(sql`id = ${scan.id}`);
    expect(await status(a)).toMatchObject({ active: false });
  });

  it("gives the Roles page the same pending flag, and a version that no task alone moves", async () => {
    const roles = await getRolesWorkStatus(a.id);
    expect(roles.active).toBe(false);
    const scan = await task("scan_company", { companyId: mine });
    const pending = await getRolesWorkStatus(a.id);
    expect(pending.active).toBe(true);
    expect((await getRolesWorkStatus(b.id)).active).toBe(false);
    // A task arriving, starting and finishing changes nothing the table shows.
    expect(pending.version).toBe(roles.version);
    const companies = (await status(a)).version;
    await database.update(schema.tasks).set({ status: "running" }).where(sql`id = ${scan.id}`);
    expect((await getRolesWorkStatus(a.id)).version).toBe(roles.version);
    expect((await status(a)).version).not.toBe(companies);
    await task("discover", { companyId: mine, homepageUrl: "https://mine.example" });
    await database.update(schema.tasks).set({ status: "done" }).where(sql`id = ${scan.id}`);
    expect(await getRolesWorkStatus(a.id)).toEqual({ active: true, version: roles.version });
    await database.execute(sql`update tasks set status = 'done'`);
    expect(await getRolesWorkStatus(a.id)).toEqual({ active: false, version: roles.version });
  });

  it("keeps Roles watching this account's late score after its company scan has finished", async () => {
    const [source] = await database.insert(schema.careerSources).values({ companyId: mine, type: "html", url: "https://mine.example/jobs" }).returning();
    const [job] = await database.insert(schema.jobs).values({ companyId: mine, sourceId: source!.id,
      externalKey: "score-later", title: "Engineer", normalizedTitle: "engineer", url: "https://mine.example/jobs/score-later" }).returning();
    await database.insert(schema.userJobs).values({ userId: a.id, jobId: job!.id, keywordMatched: true, locationOk: true, inTable: true,
      scoreState: "queued", scoreStateAt: new Date() });
    await task("scan_company", { companyId: mine }, "done");
    const score = await task("score_job", { userId: a.id, jobId: job!.id });
    const before = await getRolesWorkStatus(a.id);
    expect(before.active).toBe(true);
    expect((await getRolesWorkStatus(b.id)).active).toBe(false);
    expect((await status(a)).active).toBe(false); // Companies does not wait for personal scores.

    await database.update(schema.userJobs).set({ fitScore: 81, scoreState: "scored", scoreStateAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(Date.now() + 60_000) }).where(eq(schema.userJobs.jobId, job!.id));
    expect((await getRolesWorkStatus(a.id)).version).not.toBe(before.version);
    await database.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.id, score.id));
    expect((await getRolesWorkStatus(a.id)).active).toBe(false);
  });

  it("keeps Roles watching only its account through score admission and a terminal no-AI answer", async () => {
    const [source] = await database.insert(schema.careerSources).values({ companyId: mine, type: "html", url: "https://mine.example/jobs" }).returning();
    const [job] = await database.insert(schema.jobs).values({ companyId: mine, sourceId: source!.id,
      externalKey: "admit-score", title: "Engineer", normalizedTitle: "engineer", url: "https://mine.example/jobs/admit-score" }).returning();
    await database.insert(schema.userJobs).values({ userId: a.id, jobId: job!.id, keywordMatched: true, locationOk: true, inTable: true,
      scoreState: "requested", scoreStateAt: new Date() });
    const admission = await task("admit_scores", { userId: a.id, jobIds: [job!.id] });
    const pending = await getRolesWorkStatus(a.id);
    expect(pending.active).toBe(true);
    expect((await getRolesWorkStatus(b.id)).active).toBe(false);

    await database.transaction(async tx => {
      await tx.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.id, admission.id));
      await tx.update(schema.userJobs).set({ scoreState: "unavailable", scoreStateAt: new Date(Date.now() + 60_000) })
        .where(eq(schema.userJobs.jobId, job!.id));
    });
    const finished = await getRolesWorkStatus(a.id);
    expect(finished.active).toBe(false);
    expect(finished.version).not.toBe(pending.version);
  });

  it("continues watching after admission hands the role to a score task", async () => {
    const admission = await task("admit_scores", { userId: a.id, jobIds: ["role-1"] });
    expect((await getRolesWorkStatus(a.id)).active).toBe(true);
    await database.transaction(async tx => {
      await tx.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.id, admission.id));
      await tx.insert(schema.tasks).values({ type: "score_job", payload: { userId: a.id, jobId: "role-1" } });
    });
    expect((await getRolesWorkStatus(a.id)).active).toBe(true);
    expect((await getRolesWorkStatus(b.id)).active).toBe(false);
  });

  it("watches a future batch hand-off for its member without a fast unchanged poll", async () => {
    const score = await task("score_job", { userId: a.id, jobId: "role-1" });
    const baseline = await getRolesWorkStatus(a.id);
    expect(baseline.active).toBe(true);
    // Batch hand-off finishes the individual task and leaves the provider poll task pending.
    await database.transaction(async tx => {
      await tx.update(schema.tasks).set({ status: "done" }).where(eq(schema.tasks.id, score.id));
      await tx.insert(schema.tasks).values({ type: "poll_score_batch", status: "queued",
        runAfter: new Date(Date.now() + 60 * 60_000), payload: { items: [{ userId: a.id, jobId: "role-1" }] } });
    });
    expect(await getRolesWorkStatus(a.id)).toEqual({ active: true, version: baseline.version });
    expect((await getRolesWorkStatus(b.id)).active).toBe(false);
    let poll = initialWorkPoll(baseline.version);
    for (let i = 0; i < 8; i++) poll = stepWorkPoll(poll, { active: true, version: baseline.version }).state;
    expect(poll.wait).toBe(LONGEST_POLL_MS);
    await database.execute(sql`update tasks set status = 'done' where type = 'poll_score_batch'`);
    expect((await getRolesWorkStatus(a.id)).active).toBe(false);
  });

  it("watches only the account named by a queued rescore pass", async () => {
    await task("rescore_all", { userId: b.id, onlyInTable: true });
    expect((await getRolesWorkStatus(a.id)).active).toBe(false);
    expect((await getRolesWorkStatus(b.id)).active).toBe(true);
    await task("rescore_all", {}, "queued"); // Handler skips a legacy task with no account.
    expect((await getRolesWorkStatus(a.id)).active).toBe(false);
  });
});

/**
 * The Roles page's version is a fingerprint of what its table shows. Each writer that changes a
 * column the table renders is replayed here as the statement it runs (worker handlers named
 * beside each), and must move this account's version and no other account's.
 */
describe("getRolesWorkStatus's fingerprint", () => {
  let source: string;
  let mineJob: string;
  let sharedJob: string;
  let theirsJob: string;

  async function posting(companyId: string, key: string) {
    const [row] = await database.insert(schema.jobs).values({
      companyId, sourceId: source, externalKey: key, title: `Role ${key}`, normalizedTitle: `role ${key}`, url: `https://example.test/${key}`,
    }).returning();
    return row!.id;
  }
  async function view(user: User, jobId: string) {
    await database.insert(schema.userJobs).values({ userId: user.id, jobId, keywordMatched: true, locationOk: true, inTable: true });
  }
  const version = async (user: User) => (await getRolesWorkStatus(user.id)).version;

  beforeEach(async () => {
    const [row] = await database.insert(schema.careerSources).values({ companyId: mine, type: "html", url: "https://mine.example/jobs" }).returning();
    source = row!.id;
    mineJob = await posting(mine, "mine");
    sharedJob = await posting(mine, "shared");
    theirsJob = await posting(theirs, "theirs");
    await view(a, mineJob);
    await view(a, sharedJob);
    await view(b, sharedJob);
    await view(b, theirsJob);
  });

  /** The writer runs, and this account's version moves while the other's stays put. */
  async function moves(write: () => Promise<unknown>, reader: User = a, bystander: User = b) {
    const [mineBefore, theirsBefore] = [await version(reader), await version(bystander)];
    await write();
    expect(await version(reader)).not.toBe(mineBefore);
    expect(await version(bystander)).toBe(theirsBefore);
  }
  /** The writer runs, and nobody's version moves. */
  async function stays(write: () => Promise<unknown>) {
    const [one, two] = [await version(a), await version(b)];
    await write();
    expect([await version(a), await version(b)]).toEqual([one, two]);
  }
  const later = () => new Date(Date.now() + 60_000);

  it("stays put for a scan that finds nothing new", async () => {
    // handlers/scan.ts: the seen rows' bookkeeping, and a first miss, neither of which the table shows.
    await stays(() => database.execute(sql`update jobs set last_seen_at = now(), missing_scans = 0, first_missed_at = null`));
    await stays(() => database.execute(sql`update jobs set missing_scans = missing_scans + 1, first_missed_at = now() where id = ${mineJob}`));
  });

  it("moves for a scan that changes a posting, admits a role, or re-gates a view", async () => {
    // handlers/scan.ts: changed fields, and the description, stamp `updated_at`.
    await moves(() => database.execute(sql`update jobs set title = 'Head of Operations', updated_at = ${later()} where id = ${mineJob}`));
    // A new posting that passes the gate: a view is inserted.
    await moves(async () => view(a, await posting(mine, "new")));
    // The gate's verdict on an existing view (handlers/scan.ts, packages/db gate.ts).
    await moves(() => database.execute(sql`update user_jobs set in_table = false, updated_at = ${later()} where user_id = ${a.id} and job_id = ${mineJob}`));
    // A shared posting's own change moves both tables that show it.
    const [one, two] = [await version(a), await version(b)];
    await database.execute(sql`update jobs set location = 'Leeds', updated_at = ${later()} where id = ${sharedJob}`);
    expect(await version(a)).not.toBe(one);
    expect(await version(b)).not.toBe(two);
  });

  it("moves for a closure and a reopening, which a scan writes without touching updated_at", async () => {
    // handlers/scan.ts: `status = 'closed', closed_at = …, missing_scans + 1`, and the reverse.
    await moves(() => database.execute(sql`update jobs set status = 'closed', closed_at = now(), missing_scans = missing_scans + 1 where id = ${mineJob}`));
    await moves(() => database.execute(sql`update jobs set status = 'open', closed_at = null, missing_scans = 0, reopened_count = reopened_count + 1 where id = ${mineJob}`));
  });

  it("moves for a score, and for a blank score's reason, which moves without updated_at", async () => {
    // handlers/learning.ts: a score stamps `updated_at`; a state (queued, budget, closed) only `score_state_at`.
    await moves(() => database.execute(sql`update user_jobs set fit_score = 72, fit_verdict = 'strong', score_state = 'scored', score_state_at = ${later()}, updated_at = ${later()} where user_id = ${a.id} and job_id = ${sharedJob}`));
    await moves(() => database.execute(sql`update user_jobs set score_state = 'budget', score_state_at = ${new Date(Date.now() + 120_000)} where user_id = ${a.id} and job_id = ${mineJob}`));
    // Another account's score on the posting both follow is theirs alone.
    await moves(() => database.execute(sql`update user_jobs set fit_score = 10, updated_at = ${new Date(Date.now() + 180_000)} where user_id = ${b.id} and job_id = ${sharedJob}`), b, a);
  });

  it("moves for a decision, an undo and an archive", async () => {
    await moves(() => database.transaction((tx) => recordDecisions(tx as never, a.id, [mineJob], "skip", "Not interested")));
    await moves(() => database.transaction((tx) => recordDecisions(tx as never, a.id, [mineJob], null, "")));
    await moves(() => database.execute(sql`update user_jobs set archived_at = now(), updated_at = ${later()} where user_id = ${a.id} and job_id = ${sharedJob}`));
    await moves(() => database.transaction((tx) => recordDecisions(tx as never, b.id, [sharedJob], "apply", "")), b, a);
  });

  it("moves for a filter suggestion arriving or being answered, the strip above the table", async () => {
    let suggestion = "";
    await moves(async () => {
      const [row] = await database.insert(schema.filterSuggestions).values({ userId: b.id, type: "keyword_include", value: { term: "ops" } }).returning();
      suggestion = row!.id;
    }, b, a);
    await moves(() => database.insert(schema.filterSuggestions).values({ userId: a.id, type: "keyword_include", value: { term: "operations" } }));
    await moves(() => database.update(schema.filterSuggestions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(schema.filterSuggestions.id, suggestion)), b, a);
  });
});

describe("the companies work query", () => {
  it("reads the account's followed companies once per query, not once per queued task", async () => {
    const query = companyWorkQuery(a.id).toSQL();
    const plan = await pool.query(`explain ${query.sql}`, query.params);
    const text = plan.rows.map((row: { "QUERY PLAN": string }) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("hashed SubPlan");
    expect(text).not.toMatch(/company_id\)::text = \(tasks\.payload/);
  });
});
