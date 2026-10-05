import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { appendProfile, createDb, enqueueStandard, lockAccountScoreInput, schema, syncCompanyStatus, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { checkScorePublication, prepareScoreJob, writeScore } from "./handlers/learning";
import { ensureTestUser, TEST_DATABASE_URL } from "./test-users";

const url = TEST_DATABASE_URL;
const now = new Date("2026-10-01T12:00:00.000Z");
let deps: WorkerDeps;
let writer: ReturnType<typeof createDb>;
let publisher: ReturnType<typeof createDb>;
let observer: ReturnType<typeof createDb>;
let userId: string;
let jobId: string;
let companyId: string;

function barrier() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  return { held, release };
}

async function backendPid(db: Db): Promise<number> {
  const result = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return result.rows[0]!.pid;
}

/** Observe a real PostgreSQL lock wait, rather than using elapsed time to infer one. */
async function waitUntilBlocked(blockedPid: number, blockingPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.db.execute<{ blocked: boolean }>(sql`
      select ${blockingPid}::int = any(pg_blocking_pids(${blockedPid}::int)) as blocked`);
    if (result.rows[0]?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL did not report backend ${blockedPid} blocked by ${blockingPid}`);
}

beforeAll(async () => {
  const bootstrap = createDb(url, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = url;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.COL_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  writer = createDb(url, { max: 1, applicationName: "score-pub-writer" });
  publisher = createDb(url, { max: 1, applicationName: "score-pub-publisher" });
  observer = createDb(url, { max: 1, applicationName: "score-pub-observer" });
}, 60_000);

afterAll(async () => {
  await Promise.all([deps?.close(), writer?.pool.end(), publisher?.pool.end(), observer?.pool.end()]);
});

beforeEach(async () => {
  await deps.db.execute(sql`truncate tasks, companies, career_sources, jobs, user_jobs, decisions,
    preference_profiles, cv_libraries, settings, user_settings, ai_calls, ai_reservations restart identity cascade`);
  deps.invalidateSettings();
  const user = await ensureTestUser(deps.db, "score-publication-concurrency@example.com");
  userId = user.id;
  const [company] = await deps.db.insert(schema.companies).values({
    name: "Acme", domain: "score-pub.example", homepageUrl: "https://score-pub.example",
  }).returning();
  companyId = company!.id;
  const [source] = await deps.db.insert(schema.careerSources).values({
    companyId, type: "html", url: "https://score-pub.example/jobs",
  }).returning();
  const [job] = await deps.db.insert(schema.jobs).values({
    companyId, sourceId: source!.id, externalKey: "id:1", title: "Operations Manager",
    normalizedTitle: "operations manager", url: "https://score-pub.example/jobs/1",
    location: "London", locations: ["London"],
  }).returning();
  jobId = job!.id;
  await deps.db.insert(schema.userJobs).values({ userId, jobId, inTable: true, keywordMatched: true });
});

async function prepared() {
  const result = await prepareScoreJob(deps, userId, jobId);
  if (!("prepared" in result)) throw new Error(`Score was not prepared: ${JSON.stringify(result)}`);
  return result.prepared;
}

it("waits for an in-flight profile change, then refuses to publish the old inputs", async () => {
  const score = await prepared();
  const writerHeld = barrier();
  const writerLocked = barrier();
  const publisherStarted = barrier();
  let writerPid = 0;
  let publisherPid = 0;
  const write = writer.db.transaction(async tx => {
    writerPid = await backendPid(tx as unknown as Db);
    await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
    await appendProfile(tx as unknown as Db, userId, 0, { markdown: "Experienced operations leader", pinnedStatements: [], openQuestions: [], sourceDecisionCount: 0, model: "user" });
    writerLocked.release();
    await writerHeld.held;
  });
  try {
    await writerLocked.held;
    const publish = publisher.db.transaction(async tx => {
      publisherPid = await backendPid(tx as unknown as Db);
      publisherStarted.release();
      return checkScorePublication(deps, tx as unknown as Db, score);
    });
    await publisherStarted.held;
    await waitUntilBlocked(publisherPid, writerPid);
    writerHeld.release();
    await write;
    expect(await publish).toBe(false);
    const [view] = await deps.db.select().from(schema.userJobs)
      .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
    expect(view!.fitScore).toBeNull();
  } finally {
    writerHeld.release();
    await write.catch(() => undefined);
  }
});

it("rejects a score when a decision on another role changes its account digest", async () => {
  const score = await prepared();
  const [first] = await deps.db.select({ sourceId: schema.jobs.sourceId }).from(schema.jobs)
    .where(eq(schema.jobs.id, jobId));
  const [other] = await deps.db.insert(schema.jobs).values({
    companyId, sourceId: first!.sourceId, externalKey: "id:2", title: "Head of Operations",
    normalizedTitle: "head of operations", url: "https://score-pub.example/jobs/2",
    location: "London", locations: ["London"],
  }).returning();
  await deps.db.insert(schema.userJobs).values({ userId, jobId: other!.id, inTable: true });
  const writerHeld = barrier();
  const writerLocked = barrier();
  const publisherStarted = barrier();
  let writerPid = 0;
  let publisherPid = 0;
  const write = writer.db.transaction(async tx => {
    writerPid = await backendPid(tx as unknown as Db);
    await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
    await tx.insert(schema.decisions).values({ userId, jobId: other!.id, decision: "skip",
      reason: "Wrong sector", jobTitle: other!.title, companyName: "Acme", jobLocation: "London" });
    writerLocked.release();
    await writerHeld.held;
  });
  try {
    await writerLocked.held;
    const publish = publisher.db.transaction(async tx => {
      publisherPid = await backendPid(tx as unknown as Db);
      publisherStarted.release();
      return checkScorePublication(deps, tx as unknown as Db, score);
    });
    await publisherStarted.held;
    await waitUntilBlocked(publisherPid, writerPid);
    writerHeld.release();
    await write;
    expect(await publish).toBe(false);
  } finally {
    writerHeld.release();
    await write.catch(() => undefined);
  }
});

it("makes a later profile writer wait until the checked score commits", async () => {
  const score = await prepared();
  const publishHeld = barrier();
  const publisherLocked = barrier();
  const writerStarted = barrier();
  let publisherPid = 0;
  let writerPid = 0;
  const publish = publisher.db.transaction(async tx => {
    publisherPid = await backendPid(tx as unknown as Db);
    expect(await checkScorePublication(deps, tx as unknown as Db, score)).toBe(true);
    publisherLocked.release();
    await publishHeld.held;
    return writeScore(tx as unknown as Db, now, score, { score: 81, verdict: "strong", rationale: "A match.", flags: [] });
  });
  try {
    await publisherLocked.held;
    const write = writer.db.transaction(async tx => {
      writerPid = await backendPid(tx as unknown as Db);
      writerStarted.release();
      await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
      await appendProfile(tx as unknown as Db, userId, 0, { markdown: "New operations profile", pinnedStatements: [], openQuestions: [], sourceDecisionCount: 0, model: "user" });
      await enqueueStandard(tx as unknown as Db, "rescore_all", { userId, onlyInTable: true });
    });
    await writerStarted.held;
    await waitUntilBlocked(writerPid, publisherPid);
    publishHeld.release();
    expect(await publish).toBe(true);
    await write;
    const [view] = await deps.db.select().from(schema.userJobs)
      .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
    expect(view!.fitScore).toBe(81);
    expect(await deps.db.select().from(schema.tasks).where(eq(schema.tasks.type, "rescore_all"))).toHaveLength(1);
  } finally {
    publishHeld.release();
    await publish.catch(() => undefined);
  }
});

it("lets a company deletion finish while publication checks the same role", async () => {
  const score = await prepared();
  const companyLocked = barrier();
  const deleteAllowed = barrier();
  const publisherStarted = barrier();
  let writerPid = 0;
  let publisherPid = 0;
  const deletion = writer.db.transaction(async tx => {
    writerPid = await backendPid(tx as unknown as Db);
    await tx.update(schema.companies).set({ name: "Acme renamed" }).where(eq(schema.companies.id, companyId));
    companyLocked.release();
    await deleteAllowed.held;
    await tx.delete(schema.companies).where(eq(schema.companies.id, companyId));
  });
  try {
    await companyLocked.held;
    const publish = publisher.db.transaction(async tx => {
      publisherPid = await backendPid(tx as unknown as Db);
      publisherStarted.release();
      return checkScorePublication(deps, tx as unknown as Db, score);
    });
    await publisherStarted.held;
    await waitUntilBlocked(publisherPid, writerPid);
    deleteAllowed.release();
    await deletion;
    expect(await publish).toBe(false);
  } finally {
    deleteAllowed.release();
    await deletion.catch(() => undefined);
  }
});

it("serialises unfollow's view deletion and company status update behind publication", async () => {
  await deps.db.insert(schema.companySubscriptions).values({ userId, companyId, status: "active" });
  const score = await prepared();
  const publishHeld = barrier();
  const publisherLocked = barrier();
  const unfollowStarted = barrier();
  let publisherPid = 0;
  let unfollowPid = 0;
  const publish = publisher.db.transaction(async tx => {
    publisherPid = await backendPid(tx as unknown as Db);
    expect(await checkScorePublication(deps, tx as unknown as Db, score)).toBe(true);
    publisherLocked.release();
    await publishHeld.held;
    return writeScore(tx as unknown as Db, now, score,
      { score: 81, verdict: "strong", rationale: "A match.", flags: [] });
  });
  try {
    await publisherLocked.held;
    // Same SQL order as unfollowCompany: remove subscription and views, then update company.
    const unfollow = writer.db.transaction(async tx => {
      unfollowPid = await backendPid(tx as unknown as Db);
      unfollowStarted.release();
      await lockAccountScoreInput(tx as unknown as Db, userId, "exclusive");
      await tx.delete(schema.companySubscriptions).where(and(
        eq(schema.companySubscriptions.userId, userId), eq(schema.companySubscriptions.companyId, companyId)));
      await tx.execute(sql`delete from user_jobs uj using jobs j
        where j.id = uj.job_id and uj.user_id = ${userId}::uuid and j.company_id = ${companyId}::uuid`);
      await syncCompanyStatus(tx as unknown as Db, companyId);
    });
    await unfollowStarted.held;
    await waitUntilBlocked(unfollowPid, publisherPid);
    publishHeld.release();
    expect(await publish).toBe(true);
    await unfollow;
    expect(await deps.db.select().from(schema.userJobs).where(and(
      eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)))).toHaveLength(0);
    const [company] = await deps.db.select({ status: schema.companies.status })
      .from(schema.companies).where(eq(schema.companies.id, companyId));
    expect(company!.status).toBe("archived");
  } finally {
    publishHeld.release();
    await publish.catch(() => undefined);
  }
});

it("uses a request number when two scores are prepared at the same clock instant", async () => {
  const older = await prepared();
  const newer = await prepared();
  expect(newer.preparedAt).toEqual(older.preparedAt);
  expect(newer.attemptVersion).toBe(older.attemptVersion + 1);
  expect(await publisher.db.transaction(tx => checkScorePublication(deps, tx as unknown as Db, older))).toBe(false);
  expect(await publisher.db.transaction(async tx => {
    if (!await checkScorePublication(deps, tx as unknown as Db, newer)) return false;
    return writeScore(tx as unknown as Db, now, newer, { score: 77, verdict: "strong", rationale: "A match.", flags: [] });
  })).toBe(true);
  const [view] = await deps.db.select().from(schema.userJobs)
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
  expect(view!.fitScore).toBe(77);
});
