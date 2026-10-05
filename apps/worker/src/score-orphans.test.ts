import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDb, requestScores, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { ensureTestUser } from "./test-users";
import { reconcileOrphanScores } from "./score-orphans";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test";
const { db, pool } = createDb(url);
const old = new Date("2026-09-28T09:00:00Z");

beforeAll(() => runMigrations(db));
afterAll(() => pool.end());
beforeEach(async () => {
  await db.execute(sql`truncate tasks, companies, career_sources, jobs, user_jobs, decisions, settings restart identity cascade`);
});

async function roles(count: number, email = "orphan@example.com") {
  const user = await ensureTestUser(db, email);
  const [company] = await db.insert(schema.companies).values({ name: email, domain: `${email.split("@")[0]}.example`, homepageUrl: "https://acme.example" }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://acme.example/jobs" }).returning();
  const jobs = await db.insert(schema.jobs).values(Array.from({ length: count }, (_, n) => ({
    companyId: company!.id, sourceId: source!.id, externalKey: `id:${n}`, title: `Role ${n}`, normalizedTitle: `role ${n}`,
    url: `https://acme.example/jobs/${n}`,
  }))).returning({ id: schema.jobs.id });
  await db.insert(schema.userJobs).values(jobs.map(job => ({ userId: user.id, jobId: job.id, inTable: true, scoreState: "queued" as const,
    scoreStateAt: old, fitScore: 73, scoredAt: old })));
  return { userId: user.id, jobIds: jobs.map(job => job.id) };
}

async function state(userId: string, jobId: string) {
  return (await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId))))[0]!;
}

it("repairs legacy requested and queued views with done, failed or missing tasks, preserving scores", async () => {
  const { userId, jobIds } = await roles(3);
  await db.update(schema.userJobs).set({ scoreState: "requested", scoreStateAt: null }).where(eq(schema.userJobs.jobId, jobIds[0]!));
  await db.insert(schema.tasks).values([
    { type: "admit_scores", status: "done", payload: { userId, jobIds: [jobIds[0]] } },
    { type: "score_job", status: "failed", payload: { userId, jobId: jobIds[1] } },
  ]);
  expect(await reconcileOrphanScores(db)).toMatchObject({ rows: 3, examined: 3, backlog: false });
  for (const jobId of jobIds) expect(await state(userId, jobId)).toMatchObject({ scoreState: "failed", fitScore: 73, scoredAt: old });
  expect(await reconcileOrphanScores(db)).toMatchObject({ rows: 0, examined: 0 });
});

it("retains arbitrarily old views owned by active admission, scoring or provider polling", async () => {
  const { userId, jobIds } = await roles(5);
  await db.insert(schema.tasks).values([
    { type: "admit_scores", status: "queued", payload: { userId, jobIds: [jobIds[0]] } },
    { type: "score_job", status: "running", payload: { userId, jobId: jobIds[1] } },
    { type: "poll_score_batch", status: "queued", payload: { items: [{ userId, jobId: jobIds[2] }] } },
    { type: "poll_score_batch", status: "running", payload: { items: { malformed: true } } },
  ]);
  const another = await roles(1, "other-orphan@example.com");
  // Ownership of the same role ID by another account is not ownership of this account's view.
  await db.insert(schema.userJobs).values({ userId: another.userId, jobId: jobIds[3]!, inTable: true,
    scoreState: "requested", scoreStateAt: old });
  await db.insert(schema.tasks).values({ type: "admit_scores", status: "queued",
    payload: { userId: another.userId, jobIds: [jobIds[3]] } });
  const outcome = await reconcileOrphanScores(db);
  expect(outcome).toMatchObject({ rows: 3, examined: 3 });
  for (const jobId of jobIds.slice(0, 3)) expect((await state(userId, jobId)).scoreState).toBe("queued");
  for (const jobId of jobIds.slice(3)) expect((await state(userId, jobId)).scoreState).toBe("failed");
  expect((await state(another.userId, jobIds[3]!)).scoreState).toBe("requested");
});

it("does not infer failure from a recent state or from an already completed score", async () => {
  const { userId, jobIds } = await roles(2);
  await db.update(schema.userJobs).set({ scoreStateAt: new Date() }).where(eq(schema.userJobs.jobId, jobIds[0]!));
  await db.update(schema.userJobs).set({ scoreState: "scored" }).where(eq(schema.userJobs.jobId, jobIds[1]!));
  expect(await reconcileOrphanScores(db)).toMatchObject({ rows: 0, examined: 0 });
  expect((await state(userId, jobIds[0]!)).scoreState).toBe("queued");
  expect((await state(userId, jobIds[1]!)).scoreState).toBe("scored");
  const stop = new AbortController();
  stop.abort();
  expect(await reconcileOrphanScores(db, { signal: stop.signal })).toMatchObject({ rows: 0, backlog: true });
});

it("makes bounded progress past many active rows without scanning them as the batch", async () => {
  const { userId, jobIds } = await roles(230);
  const owned = jobIds.slice(0, 205);
  await db.update(schema.userJobs).set({ scoreStateAt: new Date(old.getTime() + 3600_000) })
    .where(sql`${schema.userJobs.jobId} in (${sql.join(jobIds.slice(205).map(id => sql`${id}::uuid`), sql`, `)})`);
  await db.insert(schema.tasks).values({ type: "admit_scores", status: "queued", payload: { userId, jobIds: owned } });
  const first = await reconcileOrphanScores(db, { batch: 10, budgetMs: 0 });
  expect(first).toMatchObject({ rows: 10, examined: 10, backlog: true });
  const rest = await reconcileOrphanScores(db, { batch: 10 });
  expect(rest).toMatchObject({ rows: 15, examined: 15, backlog: false });
  expect((await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.scoreState, "queued"))))).toHaveLength(205);
  expect((await db.select().from(schema.userJobs).where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.scoreState, "failed"))))).toHaveLength(25);
});

it("skips a locked view while a newer request commits, then honours its active task", async () => {
  const { userId, jobIds } = await roles(1);
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const newer = db.transaction(async tx => {
    await tx.execute(sql`select job_id from user_jobs where user_id = ${userId}::uuid and job_id = ${jobIds[0]}::uuid for update`);
    locked();
    await gate;
    await requestScores(tx as unknown as Db, [{ userId, jobId: jobIds[0]! }], new Date());
  });
  await ready;
  expect(await reconcileOrphanScores(db)).toMatchObject({ rows: 0, examined: 0 });
  release();
  await newer;
  expect(await reconcileOrphanScores(db)).toMatchObject({ rows: 0, examined: 0 });
  expect((await state(userId, jobIds[0]!)).scoreState).toBe("requested");
});

it("rechecks a task inserted after candidate selection using a fresh statement snapshot", async () => {
  const { userId, jobIds } = await roles(1);
  let inserted = false;
  const observed = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return async (work: (writer: Db) => Promise<unknown>) => db.transaction(async tx => work(new Proxy(tx, {
        get(inner, member, innerReceiver) {
          if (member !== "execute") return Reflect.get(inner, member, innerReceiver);
          return async (query: SQL) => {
            const result = await tx.execute(query);
            const statement = (db as unknown as { dialect: { sqlToQuery(query: SQL): { sql: string } } }).dialect.sqlToQuery(query).sql;
            if (!inserted && statement.startsWith("select uj.user_id, uj.job_id from user_jobs uj")) {
              inserted = true;
              // Batch hand-off can create a task without taking the view lock. The next statement
              // must see that committed owner, even though selection used an earlier snapshot.
              await db.insert(schema.tasks).values({ type: "score_job", status: "queued", payload: { userId, jobId: jobIds[0] } });
            }
            return result;
          };
        },
      }) as unknown as Db));
    },
  }) as Db;
  expect(await reconcileOrphanScores(observed)).toMatchObject({ rows: 0, examined: 1 });
  expect(inserted).toBe(true);
  expect((await state(userId, jobIds[0]!)).scoreState).toBe("queued");
});
