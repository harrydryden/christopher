/**
 * Hourly history maintenance against a real database: what each rule removes, what it must never
 * remove, and that the work keeps up with any backlog inside its budget.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local ava_test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, pruneWorkerEvents, schema } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql, type SQL } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { maintainHistory } from "./maintenance";
import { ensureTestUser } from "./test-users";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
const deps = { db } as unknown as WorkerDeps;

beforeAll(() => runMigrations(db));
afterAll(() => pool.end());
beforeEach(async () => {
  await db.execute(sql`truncate tasks, companies, career_sources, jobs, job_events, scans, discovery_runs, sessions, login_attempts,
    auth_tokens, ai_reservations, verification_cache, worker_events restart identity cascade`);
  await db.execute(sql`delete from settings where key = 'internal:lastMaintenance'`);
});

const count = async (query: SQL) => Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from (${query}) rows`)).rows[0]?.n);
/** Make the hour pass without waiting for it. */
const nextHour = () => db.execute(sql`update settings set updated_at = now() - interval '2 hours' where key = 'internal:lastMaintenance'`);

async function postingFixture() {
  const [company] = await db.insert(schema.companies).values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "greenhouse", url: "https://acme.example/jobs" }).returning();
  const [job] = await db.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: "1", title: "Operations Manager", normalizedTitle: "operations manager", url: "https://acme.example/jobs/1",
  }).returning();
  return { company: company!, source: source!, job: job! };
}

describe("finished tasks", () => {
  it("are all removed after thirty days, however many there are, and nothing unfinished is", async () => {
    await db.execute(sql`insert into tasks (type, status, created_at, finished_at)
      select 'score_job', case when n % 10 = 0 then 'failed' else 'done' end, now() - interval '31 days', now() - interval '31 days' from generate_series(1, 12000) n`);
    await db.execute(sql`insert into tasks (type, status, created_at, finished_at) select 'scan_company', 'done', now() - interval '29 days', now() - interval '29 days' from generate_series(1, 50)`);
    // Old and unfinished: a stuck task is the stale sweep's to deal with, never retention's.
    await db.execute(sql`insert into tasks (type, status, created_at) select 'discover', status, now() - interval '60 days' from unnest(array['queued', 'running']) status`);

    const report = await maintainHistory(deps, { batch: 5000 });

    // The old cap was a thousand an hour; twelve thousand go in one run, in three statements.
    expect(report?.tasks).toEqual({ rows: 12000, backlog: false });
    expect(await count(sql`select 1 from tasks where finished_at < now() - interval '30 days'`)).toBe(0);
    expect(await count(sql`select 1 from tasks where type = 'scan_company'`)).toBe(50);
    expect(await count(sql`select 1 from tasks where status in ('queued', 'running')`)).toBe(2);
  });

  it("stop at the table's budget and say there is a backlog, which the next hour carries on with", async () => {
    await db.execute(sql`insert into tasks (type, status, finished_at) select 'score_job', 'done', now() - interval '31 days' from generate_series(1, 2000)`);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const report = await maintainHistory(deps, { batch: 500, tableBudgetMs: 0 });
      expect(report?.tasks).toEqual({ rows: 500, backlog: true });
      expect(warn.mock.calls.some(([line]) => String(line).includes("retention backlog") && String(line).includes("tasks"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(await count(sql`select 1 from tasks`)).toBe(1500);
    await nextHour();
    expect((await maintainHistory(deps, { batch: 500 }))?.tasks).toEqual({ rows: 1500, backlog: false });
  });

  it("stop between batches when the run is stopped", async () => {
    await db.execute(sql`insert into tasks (type, status, finished_at) select 'score_job', 'done', now() - interval '31 days' from generate_series(1, 2000)`);
    const stop = new AbortController();
    let batches = 0;
    const report = await maintainHistory(deps, { batch: 500, signal: stop.signal, clock: () => { if (++batches > 1) stop.abort(); return 0; } });
    expect(report?.tasks?.rows).toBe(500);
    // Nothing after the stop is started.
    expect(report?.job_events).toBeUndefined();
  });
});

describe("the hourly claim", () => {
  it("lets one run an hour through, whichever worker asks", async () => {
    await db.execute(sql`insert into tasks (type, status, finished_at) select 'score_job', 'done', now() - interval '31 days' from generate_series(1, 10)`);
    expect(await maintainHistory(deps)).not.toBeNull();
    await db.execute(sql`insert into tasks (type, status, finished_at) select 'score_job', 'done', now() - interval '31 days' from generate_series(1, 10)`);
    const [first, second] = await Promise.all([maintainHistory(deps), maintainHistory(deps)]);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(await count(sql`select 1 from tasks`)).toBe(10);
  });
});

describe("job events", () => {
  it("lose their transient observations after ninety days and keep everything a role's history is made of", async () => {
    const { job } = await postingFixture();
    const user = await ensureTestUser(db, "maintenance@example.com");
    const old = sql`now() - interval '91 days'`;
    for (const type of ["updated", "scored", "description_fetched", "discovered", "closed", "reopened", "decided", "hidden", "unhidden"] as const) {
      await db.execute(sql`insert into job_events (job_id, user_id, type, at) select ${job.id}::uuid, ${type === "scored" || type === "decided" ? user.id : null}::uuid, ${type}::text, ${old} from generate_series(1, 3)`);
    }
    await db.execute(sql`insert into job_events (job_id, user_id, type, at) values (${job.id}, ${user.id}, 'scored', now() - interval '89 days')`);

    const report = await maintainHistory(deps, { batch: 4 });

    expect(report?.job_events).toEqual({ rows: 9, backlog: false });
    const left = await db.execute<{ type: string; n: number }>(sql`select type, count(*)::int as n from job_events group by type order by type`);
    expect(Object.fromEntries(left.rows.map(row => [row.type, row.n]))).toEqual({ closed: 3, decided: 3, discovered: 3, hidden: 3, reopened: 3, scored: 1, unhidden: 3 });
  });
});

describe("scans", () => {
  it("keep the last three per source and the last successful one, however old", async () => {
    const { source } = await postingFixture();
    // Six scans a hundred days old or more: the oldest is the only successful one.
    await db.execute(sql`insert into scans (source_id, status, started_at)
      select ${source.id}::uuid, case when n = 6 then 'ok' else 'failed' end, now() - make_interval(days => 100 + n) from generate_series(1, 6) n`);
    await maintainHistory(deps);
    const kept = await db.execute<{ status: string; age: number }>(sql`select status, extract(day from now() - started_at)::int as age from scans order by started_at desc`);
    expect(kept.rows).toEqual([{ status: "failed", age: 101 }, { status: "failed", age: 102 }, { status: "failed", age: 103 }, { status: "ok", age: 106 }]);
  });
});

describe("discovery runs", () => {
  it("are pruned after ninety days, except each company's newest and any run still waiting on someone", async () => {
    const { company } = await postingFixture();
    const run = (status: string, days: number) => db.execute(sql`insert into discovery_runs (company_id, status, started_at, candidates, log)
      values (${company.id}, ${status}, now() - make_interval(days => ${days}), '[{"url":"https://acme.example/careers"}]', '["attempt"]')`);
    await run("failed", 200);
    await run("not_found", 150);
    await run("needs_confirmation", 140);
    await run("running", 130);
    await run("resolved", 120);
    await run("resolved", 95);
    const [other] = await db.insert(schema.companies).values({ name: "Solo", domain: "solo.example", homepageUrl: "https://solo.example" }).returning();
    // A company whose only run is old: it is still the one the interface shows.
    await db.execute(sql`insert into discovery_runs (company_id, status, started_at) values (${other!.id}, 'resolved', now() - interval '300 days')`);

    const report = await maintainHistory(deps);

    expect(report?.discovery_runs?.rows).toBe(3);
    const left = await db.execute<{ status: string; days: number }>(sql`select status, extract(day from now() - started_at)::int as days from discovery_runs order by started_at`);
    expect(left.rows).toEqual([
      { status: "resolved", days: 300 },
      { status: "needs_confirmation", days: 140 },
      { status: "running", days: 130 },
      { status: "resolved", days: 95 },
    ]);
  });
});

describe("sign-in bookkeeping and short-lived caches", () => {
  it("go once they have expired, and stay while they are live", async () => {
    const user = await ensureTestUser(db, "maintenance@example.com");
    await db.execute(sql`insert into sessions (user_id, expires_at) values (${user.id}, now() - interval '1 minute'), (${user.id}, now() + interval '1 day')`);
    await db.execute(sql`insert into login_attempts (key, at) values ('old', now() - interval '25 hours'), ('recent', now() - interval '1 hour')`);
    await db.execute(sql`insert into auth_tokens (user_id, purpose, token_hash, expires_at, used_at) values
      (${user.id}, 'password_reset', 'expired', now() - interval '2 days', null),
      (${user.id}, 'email_verification', 'spent', now() + interval '1 hour', now() - interval '2 days'),
      (${user.id}, 'password_reset', 'live', now() + interval '1 hour', null)`);
    await db.execute(sql`insert into ai_reservations (user_id, call_site, amount, expires_at) values
      (${user.id}, 'A5', 0.1, now() - interval '2 hours'), (${user.id}, 'A5', 0.1, now() - interval '10 minutes'), (${user.id}, 'A5', 0.1, now() + interval '5 minutes')`);
    await db.execute(sql`insert into verification_cache (key, result, expires_at) values ('stale', '{"homepageOk":true}', now() - interval '1 minute'), ('fresh', '{"homepageOk":true}', now() + interval '1 day')`);

    await maintainHistory(deps);

    expect(await count(sql`select 1 from sessions`)).toBe(1);
    expect((await db.execute(sql`select key from login_attempts`)).rows).toEqual([{ key: "recent" }]);
    expect((await db.execute(sql`select token_hash from auth_tokens`)).rows).toEqual([{ token_hash: "live" }]);
    // A hold that expired minutes ago is left for the reservation sweep; only the long-dead one goes.
    expect(await count(sql`select 1 from ai_reservations`)).toBe(2);
    expect((await db.execute(sql`select key from verification_cache`)).rows).toEqual([{ key: "fresh" }]);
  });
});

describe("a table whose statement fails", () => {
  it("is reported, and every other table is still pruned", async () => {
    const { job } = await postingFixture();
    await db.execute(sql`insert into tasks (type, status, finished_at) values ('score_job', 'done', now() - interval '31 days')`);
    await db.execute(sql`insert into job_events (job_id, type, at) values (${job.id}, 'updated', now() - interval '91 days')`);
    await db.execute(sql`insert into login_attempts (key, at) values ('old', now() - interval '25 hours')`);
    // The job events statement fails as a lock timeout or a cancelled query would.
    const failing = {
      db: new Proxy(db, {
        get(target, key, receiver) {
          if (key !== "execute") return Reflect.get(target, key, receiver);
          return (query: SQL) => {
            const text = (target as unknown as { dialect: { sqlToQuery(q: SQL): { sql: string } } }).dialect.sqlToQuery(query).sql;
            if (text.startsWith("delete from job_events")) return Promise.reject(new Error("canceling statement due to lock timeout"));
            return target.execute(query);
          };
        },
      }),
    } as unknown as WorkerDeps;
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let report: Awaited<ReturnType<typeof maintainHistory>>;
    try {
      report = await maintainHistory(failing);
    } finally {
      warn.mockRestore();
    }
    expect(report?.job_events).toMatchObject({ rows: 0, error: "canceling statement due to lock timeout" });
    expect(report?.tasks?.rows).toBe(1);
    expect(report?.login_attempts?.rows).toBe(1);
    expect(await count(sql`select 1 from job_events`)).toBe(1);
  });
});

describe("pruneWorkerEvents", () => {
  it("removes a backlog in batches and keeps the last thirty days", async () => {
    await db.execute(sql`insert into worker_events (worker_id, kind, at) select 'w', 'vitals', now() - interval '31 days' from generate_series(1, 12)`);
    await db.execute(sql`insert into worker_events (worker_id, kind, at) values ('w', 'boot', now() - interval '29 days')`);
    expect(await pruneWorkerEvents(db, undefined, 5)).toBe(12);
    expect((await db.execute(sql`select kind from worker_events`)).rows).toEqual([{ kind: "boot" }]);
  });
});
