/**
 * The interface half of the CV load harness (scripts/cv-load.mjs starts it; do not run it by hand).
 *
 * It seeds N accounts, each with a signed-in session, a realistic Library and a few roles in its
 * table from a shared catalogue, then asks for M CVs per account inside a short window through the
 * product's own server action, `requestCv` — authentication, the Library and description checks,
 * the budget quote, the account's build cap and lock, the role lock, the draft, the application
 * row and the `generate_cv` task are all the interface's code. It then keeps one CV page open per
 * account, polling `/api/work-status?cv=<id>` every ten seconds through the route handler itself, as
 * `AutoRefresh` does, until every draft has finished.
 *
 * Next.js request modules are stubbed by scripts/cv-load-next-stubs.mjs; the session cookie of each
 * simulated request travels in an AsyncLocalStorage. The interface's own pool (`lib/db.ts`, three
 * connections) is the one a single warm serverless instance would hold.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { requestCv } from "../apps/web/app/actions/cv";
import { GET as workStatus } from "../apps/web/app/api/work-status/route";
import { createSessionCookieValue } from "../apps/web/lib/session";
import { loadShape, libraryFixture, descriptionFor, requestSchedule } from "./cv-load.mjs";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
type Pool = { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>; end(): Promise<void> };
// The interface's own copy of pg, by path: the scripts directory has no dependency of its own on it.
const { Pool } = require("pg") as { Pool: new (config: { connectionString: string; max: number }) => Pool };

const als = new AsyncLocalStorage<{ cookie: string }>();
(globalThis as unknown as { __cvLoad: unknown }).__cvLoad = { cookie: () => als.getStore()?.cookie };

const shape = loadShape(process.env);
const secret = process.env.SESSION_SECRET!;
const resultPath = process.env.CV_LOAD_WEB_RESULT ?? "/tmp/cv-load-web.json";
const harnessUrl = new URL(process.env.DATABASE_URL!);
harnessUrl.searchParams.set("application_name", "cvload-harness");
const pool = new Pool({ connectionString: harnessUrl.href, max: 3 });

async function seed() {
  const roles = Math.max(shape.draftsPerAccount, 5);
  const { rows: users } = await pool.query<{ id: string }>(`insert into users(email,name,claimed_at,email_verified_at)
    select 'cvload-'||n||'@load.invalid','Load candidate '||n,now(),now() from generate_series(1,$1::int) n order by n returning id`, [shape.accounts]);
  const { rows: companies } = await pool.query<{ id: string; name: string; homepage_url: string }>(`insert into companies(name,domain,homepage_url)
    select 'Meridian Care '||n,'meridian-'||n||'.invalid','https://meridian-'||n||'.invalid' from generate_series(1,$1::int) n returning id,name,homepage_url`, [roles]);
  const jobs: Array<{ id: string }> = [];
  for (const company of companies) {
    const { rows: [source] } = await pool.query<{ id: string }>(`insert into career_sources(company_id,type,url,status) values ($1,'greenhouse',$2,'active') returning id`, [company.id, `${company.homepage_url}/careers`]);
    const { rows: [job] } = await pool.query<{ id: string }>(`insert into jobs(company_id,source_id,external_key,title,normalized_title,url,location,locations,description_text,description_source)
      values ($1,$2,'head-of-operations','Head of Operations','head of operations',$3,'Manchester, UK','["Manchester, UK"]'::jsonb,$4,'direct') returning id`,
      [company.id, source!.id, `${company.homepage_url}/jobs/1`, descriptionFor(company.name)]);
    jobs.push(job!);
  }
  const expires = new Date(Date.now() + 6 * 3600_000);
  const accounts: Array<{ userId: string; cookie: string; jobIds: string[] }> = [];
  for (const [index, user] of users.entries()) {
    const jobIds = Array.from({ length: shape.draftsPerAccount }, (_, m) => jobs[(index + m) % jobs.length]!.id);
    for (const jobId of new Set(jobs.map(job => job.id)))
      await pool.query(`insert into user_jobs(user_id,job_id,in_table,keyword_matched,location_ok,fit_score,score_state) values ($1,$2,true,true,true,72,'scored')`, [user.id, jobId]);
    await pool.query(`insert into company_subscriptions(user_id,company_id) select $1, id from companies`, [user.id]);
    await pool.query(`insert into cv_libraries(user_id,version,content) values ($1,1,$2)`, [user.id, JSON.stringify(libraryFixture(index + 1))]);
    const { rows: [session] } = await pool.query<{ id: string }>(`insert into sessions(user_id,expires_at) values ($1,$2) returning id`, [user.id, expires]);
    accounts.push({ userId: user.id, cookie: await createSessionCookieValue(secret, session!.id, expires), jobIds });
  }
  await pool.query("analyze");
  return accounts;
}

type RequestResult = { account: number; draft: number; atMs: number; ms: number; ok: boolean; draftId?: string; message?: string };
type PollResult = { ms: number; ok: boolean; status: number; version?: string; active?: boolean };

async function main() {
  const accounts = await seed();
  const startedAt = Date.now();
  process.stdout.write(JSON.stringify({ t: "seeded", accounts: accounts.length, startedAt }) + "\n");
  const requests: RequestResult[] = [];
  const firstDraft = new Map<number, string>();
  const polls: PollResult[] = [];
  let renders = 0;
  const pollers: Promise<void>[] = [];
  let finished = false;

  const poll = (account: number, draftId: string) => pollers.push((async () => {
    let shown: string | undefined;
    while (!finished) {
      await new Promise(resolve => setTimeout(resolve, shape.pollMs));
      if (finished) return;
      const start = performance.now();
      try {
        const response = await als.run({ cookie: accounts[account]!.cookie }, () =>
          workStatus(new Request(`http://127.0.0.1/api/work-status?cv=${draftId}`)));
        const body = await response.json() as { version?: string; active?: boolean };
        polls.push({ ms: performance.now() - start, ok: response.status === 200, status: response.status, version: body.version, active: body.active });
        if (response.status === 200) {
          if (shown !== undefined && body.version !== shown) renders++;
          shown = body.version;
          // The page stops asking once the build has settled; one more reading covers the refresh it triggers.
          if (body.active === false) return;
        }
      } catch (error) {
        polls.push({ ms: performance.now() - start, ok: false, status: 0 });
        process.stderr.write(`poll failed: ${(error as Error).message}\n`);
      }
    }
  })());

  await Promise.all(requestSchedule(shape).map(async ({ account, draft, atMs }) => {
    const delay = atMs - (Date.now() - startedAt);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    const form = new FormData();
    form.set("jobId", accounts[account]!.jobIds[draft]!);
    const start = performance.now();
    const record = (result: Omit<RequestResult, "account" | "draft" | "atMs" | "ms">) =>
      requests.push({ account, draft, atMs: Date.now() - startedAt, ms: Math.round(performance.now() - start), ...result });
    try {
      const outcome = await als.run({ cookie: accounts[account]!.cookie }, () => requestCv({ ok: true }, form));
      record({ ok: false, message: (outcome as { message?: string; error?: string }).error ?? (outcome as { message?: string }).message ?? JSON.stringify(outcome) });
    } catch (error) {
      const url = (error as { url?: string }).url;
      const draftId = url?.match(/^\/cv\/([0-9a-f-]{36})$/)?.[1];
      if (!draftId) { record({ ok: false, message: (error as Error).message }); return; }
      record({ ok: true, draftId });
      if (!firstDraft.has(account)) { firstDraft.set(account, draftId); poll(account, draftId); }
    }
  }));
  process.stdout.write(JSON.stringify({ t: "requested", ok: requests.filter(r => r.ok).length, failed: requests.filter(r => !r.ok).length }) + "\n");

  // Every draft settled (ready, failed, or paused for evidence), or the harness's own ceiling.
  const deadline = startedAt + shape.maxSeconds * 1000;
  for (;;) {
    const { rows: [open] } = await pool.query<{ n: number }>(`select count(*)::int n from cv_drafts where status in ('queued','generating')`);
    if (!open!.n || Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  finished = true;
  await Promise.allSettled(pollers);
  const settledAt = Date.now();
  writeFileSync(resultPath, JSON.stringify({ startedAt, settledAt, timedOut: settledAt > deadline, accounts: accounts.map(a => a.userId), requests, polls, renders }));
  process.stdout.write(JSON.stringify({ t: "settled", seconds: (settledAt - startedAt) / 1000 }) + "\n");
  await pool.end();
  process.exit(0);
}

await main();
