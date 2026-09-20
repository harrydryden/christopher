/** Local-only 50-company daily-run timing and failure-isolation drill. */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb, enqueueTask, schema } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { handlers } from "./handlers";
import { TaskQueue } from "./queue";

const EXPECTED_DATABASE = "christopher_50_company_release";
const COMPANY_COUNT = 50;
const ROLES_PER_COMPANY = 5;
const HTML_COMPANIES = 10;
const FAILED_INDEX = 17;
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55439/christopher_50_company_release");
if (!["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || databaseUrl.pathname !== `/${EXPECTED_DATABASE}`) {
  throw new Error(`Use only the dedicated local ${EXPECTED_DATABASE} database`);
}
if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) throw new Error("Paid AI credentials must be absent");

const bootstrap = createDb(databaseUrl.href, { max: 2 });
await runMigrations(bootstrap.db);
const occupied = await bootstrap.db.execute<{ n: number }>(sql`select count(*)::int n from companies`);
if (Number(occupied.rows[0]?.n)) throw new Error(`${EXPECTED_DATABASE} is occupied; retained without changes`);
await bootstrap.pool.end();

const deps = await createDeps(readEnv({
  DATABASE_URL: databaseUrl.href,
  CHRISTOPHER_DISABLE_BROWSER: "1",
  WORKER_CONCURRENCY: "3",
  SCAN_SPREAD_MINUTES: "0",
  CHRISTOPHER_HOST_MAP: '{"*":"127.0.0.1:1"}',
}));
let stage: "baseline" | "failure" = "baseline";
let requests = 0;
deps.fetcher.fetchText = async (input: string) => {
  requests++;
  const url = new URL(input);
  const slug = url.pathname.match(/\/boards\/(fixture-\d+)/)?.[1];
  const htmlIndex = url.hostname.match(/^fixture-(\d+)\.example$/)?.[1];
  if (htmlIndex !== undefined && url.pathname === "/jobs") {
    const index = Number(htmlIndex);
    const body = Array.from({ length: ROLES_PER_COMPANY }, (_, role) =>
      `<article class="job"><a href="https://fixture-${index}.example/jobs/role-${role + 1}">Operations Role ${role + 1}</a><span class="location">London, UK</span></article>`,
    ).join("");
    return { status: 200, body: `<html><body><main>${body}</main></body></html>`, headers: {}, url: input };
  }
  if (!slug) return { status: 404, body: "not found", headers: {}, url: input };
  const index = Number(slug.slice("fixture-".length));
  if (stage === "failure" && index === FAILED_INDEX && url.pathname.endsWith("/jobs")) {
    return { status: 500, body: "controlled fixture failure", headers: {}, url: input };
  }
  if (!url.pathname.endsWith("/jobs")) return { status: 200, body: JSON.stringify({ name: `Fixture ${index}` }), headers: {}, url: input };
  return { status: 200, headers: {}, url: input, body: JSON.stringify({ jobs: Array.from({ length: ROLES_PER_COMPANY }, (_, role) => ({
    id: role + 1,
    title: `Operations Role ${role + 1}`,
    absolute_url: `https://job-boards.greenhouse.io/${slug}/jobs/${role + 1}`,
    location: { name: "London, UK" },
    content: "<p>Operate the local synthetic fixture.</p>",
  })) }) };
};

async function drainDaily(runDate: string) {
  const beforeRequests = requests;
  await enqueueTask(deps.db, "run_daily", { trigger: "manual", runDate }, { dedupeKey: `fifty-company:${runDate}`, priority: 5 });
  const started = performance.now();
  const queue = new TaskQueue(deps, handlers, { concurrency: 3, workerId: `fifty-company-${stage}`, pollMs: 25 });
  queue.start();
  let row: Record<string, unknown> | undefined;
  try {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const result = await deps.db.execute<Record<string, unknown>>(sql`select * from scan_runs where run_date=${runDate} and finished_at is not null limit 1`);
      row = result.rows[0];
      if (row) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!row) throw new Error(`daily run ${runDate} exceeded 15 minutes`);
  } finally {
    await queue.stop(10_000);
  }
  return { seconds: +((performance.now() - started) / 1000).toFixed(3), requests: requests - beforeRequests, scanRun: row };
}

try {
  const companies = await deps.db.insert(schema.companies).values(Array.from({ length: COMPANY_COUNT }, (_, index) => ({
    name: `Fixture ${index}`, domain: `fixture-${index}.example`, homepageUrl: `https://fixture-${index}.example`,
    logoNextAttemptAt: new Date("2100-01-01T00:00:00Z"),
  }))).returning({ id: schema.companies.id });
  await deps.db.insert(schema.careerSources).values(companies.map((company, index) => index >= COMPANY_COUNT - HTML_COMPANIES ? {
    companyId: company.id, type: "html" as const, url: `https://fixture-${index}.example/jobs`,
    status: "active" as const, confidence: 0.85,
  } : {
    companyId: company.id, type: "greenhouse" as const, url: `https://job-boards.greenhouse.io/fixture-${index}`,
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/fixture-${index}/jobs`, atsSlug: `fixture-${index}`,
    status: "active" as const, confidence: 0.95,
  }));

  const baseline = await drainDaily("2026-09-19");
  const baselineCounts = await deps.db.execute<{ jobs: number; openJobs: number }>(sql`select count(*)::int jobs, count(*) filter (where status='open')::int as "openJobs" from jobs`);
  if (Number(baselineCounts.rows[0]?.jobs) !== COMPANY_COUNT * ROLES_PER_COMPANY) throw new Error("baseline did not create every fixture role");

  stage = "failure";
  const measured = await drainDaily("2026-09-20");
  const evidence = await deps.db.execute<Record<string, unknown>>(sql`select
    (select count(*)::int from scans s join career_sources cs on cs.id=s.source_id join companies c on c.id=cs.company_id where s.scan_run_id=${String(measured.scanRun!.id)} and s.status='ok') as ok_scans,
    (select count(*)::int from scans s join career_sources cs on cs.id=s.source_id join companies c on c.id=cs.company_id where s.scan_run_id=${String(measured.scanRun!.id)} and s.status='failed') as failed_scans,
    (select count(*)::int from jobs j join companies c on c.id=j.company_id where c.domain=${`fixture-${FAILED_INDEX}.example`}) as failed_company_roles,
    (select count(*)::int from jobs j join companies c on c.id=j.company_id where c.domain=${`fixture-${FAILED_INDEX}.example`} and j.status='open') as failed_company_open_roles,
    (select consecutive_failures::int from career_sources cs join companies c on c.id=cs.company_id where c.domain=${`fixture-${FAILED_INDEX}.example`}) as source_consecutive_failures,
    (select error from scans s join career_sources cs on cs.id=s.source_id join companies c on c.id=cs.company_id where s.scan_run_id=${String(measured.scanRun!.id)} and c.domain=${`fixture-${FAILED_INDEX}.example`} limit 1) as failed_scan_error`);
  const facts = evidence.rows[0]!;
  const passed = measured.seconds < 900
    && Number(measured.scanRun!.companies_total) === COMPANY_COUNT
    && Number(measured.scanRun!.companies_ok) === COMPANY_COUNT - 1
    && Number(measured.scanRun!.companies_failed) === 1
    && Number(facts.ok_scans) === COMPANY_COUNT - 1
    && Number(facts.failed_scans) === 1
    && Number(facts.failed_company_roles) === ROLES_PER_COMPANY
    && Number(facts.failed_company_open_roles) === ROLES_PER_COMPANY
    && Number(facts.source_consecutive_failures) === 1;
  const report = {
    at: new Date().toISOString(), passed,
    environment: { database: EXPECTED_DATABASE, localPostgres: true, workerConcurrency: 3, browserEnabled: false, paidAiEnabled: false },
    workload: { companies: COMPANY_COUNT, sourceMix: { greenhouse: COMPANY_COUNT - HTML_COMPANIES, html: HTML_COMPANIES }, rolesPerCompany: ROLES_PER_COMPANY, controlledFailedCompanyIndex: FAILED_INDEX },
    setupRun: { ...baseline, jobs: baselineCounts.rows[0] },
    measuredDailyRun: measured,
    failureIsolation: facts,
    healthEvidence: "The failed scan row, its recorded error and the source consecutive-failure counter are the database evidence consumed by Health; the finalised scan run records 49 successful and 1 failed company.",
    limitations: [
      "Local deterministic queue and adapter evidence only; excludes public-provider pacing, hosted scheduling, Chromium memory, paid model latency and remote PostgreSQL/PgBouncer latency.",
      "The 40 Greenhouse and 10 HTML private fixtures prove daily-run timing and failure isolation for this bounded mix, not source accuracy or public-provider throughput.",
      "The initial successful run seeds retained roles and is excluded from the measured daily-run duration.",
    ],
  };
  const output = process.env.FIFTY_COMPANY_REPORT_PATH ?? resolve(process.cwd(), "../../docs/benchmarks/fifty-company-daily-run-2026-09-20.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, passed, seconds: measured.seconds, scanRun: measured.scanRun, failureIsolation: facts }));
  if (!passed) process.exitCode = 1;
} finally {
  await deps.close();
}
