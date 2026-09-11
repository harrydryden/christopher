/** Destructive ONLY to a separately named, local, empty benchmark database. No external HTTP or AI. */
import { writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { schema, enqueueTask } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { claimTask, TaskQueue } from "./queue";
import { handlers } from "./handlers";
import { finaliseScanRuns } from "./handlers/daily";

const url = new URL(process.env.SCALE_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/christopher_scale_benchmark");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/christopher_scale_benchmark") throw new Error("Use the dedicated local christopher_scale_benchmark database");
const queueMode = process.env.SCALE_QUEUE_MODE ?? "production";
if (!["production", "unrestricted"].includes(queueMode)) throw new Error("SCALE_QUEUE_MODE must be production or unrestricted");
const deps = await createDeps(readEnv({ DATABASE_URL: url.href, CHRISTOPHER_DISABLE_BROWSER: "1", WORKER_CONCURRENCY: "3", SCAN_SPREAD_MINUTES: "0", CHRISTOPHER_HOST_MAP: '{"*":"127.0.0.1:1"}' }));
let stage = "onboarding";
let requests = 0;
const companies = 1000;
const jobsPerCompany = 100;
const consumers = 3;
const queryMs: number[] = [];
let peakRss = 0;
let sampling = false;
let ready = false;
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (sampling || !ready) return;
  sampling = true;
  const started = performance.now();
  void deps.db.execute(sql`select c.id,c.name,(select count(*) from jobs j where j.company_id=c.id) as jobs
    from companies c order by c.name,c.id limit 50`).then(() => { queryMs.push(performance.now() - started); }).finally(() => { sampling = false; });
}, 100);

// Exercise production adapters, discovery, reconciliation and queue against deterministic responses.
// Pacing/network latency and browser/model execution have separate tests; this measures application/database work.
deps.fetcher.fetchText = async (input: string) => {
  requests++;
  const u = new URL(input);
  const slug = u.pathname.match(/\/boards\/(c\d+)/)?.[1];
  if (slug) {
    if (stage === "disruption" && Number(slug.slice(1)) % 50 === 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { status: 500, body: "Temporary fixture outage", headers: {}, url: input };
    }
    const data = u.pathname.endsWith("/jobs") ? { jobs: Array.from({ length: jobsPerCompany }, (_, n) => ({
      id: n + 1, title: `Software Engineer ${n}`, absolute_url: `https://job-boards.greenhouse.io/${slug}/jobs/${n + 1}`,
      location: { name: "London, UK" }, content: `<p>Build useful software with our engineering team. ${"Reliable systems and customer needs. ".repeat(10)}</p>`,
    })) } : { name: `Fixture ${slug}` };
    return { status: 200, body: JSON.stringify(data), headers: {}, url: input };
  }
  if (u.pathname === "/") return { status: 200, body: "<html><title>Fixture company</title><body>Company homepage</body></html>", headers: {}, url: input };
  return { status: 404, body: "Fixture has no other pages", headers: {}, url: input };
};
const results: Array<Record<string, unknown>> = [];
try {
  await runMigrations(deps.db);
  ready = true;
  const occupied = await deps.db.execute(sql`select id from companies limit 1`);
  if (occupied.rows.length) throw new Error("Benchmark database must be empty; recreate it before rerunning");
  await deps.db.insert(schema.settings).values({ key: "gate", value: { includeKeywords: ["Engineer"], excludeKeywords: [], seniorityKeywords: [], matchFields: ["title"], locationTerms: ["London"], includeRemote: false } });
  const seeded = [];
  for (let offset = 0; offset < companies; offset += 100) seeded.push(...await deps.db.insert(schema.companies).values(Array.from({ length: 100 }, (_, i) => {
    const n = offset + i; return { name: `Company ${String(n).padStart(4, "0")}`, domain: `c${n}.example`, homepageUrl: `https://c${n}.example` };
  })).returning());
  for (const [n, company] of seeded.entries()) await enqueueTask(deps.db, "discover", { companyId: company.id, url: `https://job-boards.greenhouse.io/c${n}` }, { dedupeKey: `discover:${company.id}` });
  for (stage of ["onboarding", "steady-state", "disruption", "recovery"]) {
    if (stage !== "onboarding") await enqueueTask(deps.db, "run_daily", { trigger: "manual" });
    const started = performance.now();
    const startRequests = requests;
    if (queueMode === "production") {
      // Use exactly the production lane allocation, polling interval and task lifecycle.
      const queue = new TaskQueue(deps, handlers, { concurrency: consumers, workerId: "benchmark-production" });
      queue.start();
      try {
        const deadline = Date.now() + 300_000;
        while (true) {
          const work = await deps.db.execute<{ pending: number; failed: number }>(sql`select
            count(*) filter (where status in ('queued','running'))::int as pending,
            count(*) filter (where status='failed')::int as failed from tasks`);
          if (work.rows[0]?.failed) throw new Error("Production-lane benchmark has failed tasks");
          if (!work.rows[0]?.pending) break;
          if (Date.now() > deadline) throw new Error("Production-lane benchmark exceeded five minutes");
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally { await queue.stop(); }
    } else {
    await Promise.all(Array.from({ length: consumers }, async (_, n) => {
      const queue = new TaskQueue(deps, handlers, { concurrency: 1, workerId: `benchmark-${n}` });
      while (true) {
        const task = await claimTask(deps.db, `benchmark-${n}`);
        if (!task) break;
        await queue.runTask(task);
      }
    }));
    }
    await finaliseScanRuns(deps);
    const counts = await deps.db.execute<{ jobs: number; sources: number; failed_tasks: number; pending: number }>(sql`select (select count(*)::int from jobs) as jobs,
      (select count(*)::int from career_sources where status='active') as sources,
      (select count(*)::int from tasks where status='failed') as failed_tasks,
      (select count(*)::int from tasks where status in ('queued','running')) as pending`);
    results.push({ stage, seconds: Number(((performance.now()-started)/1000).toFixed(2)), requests: requests-startRequests, ...counts.rows[0] });
    if (counts.rows[0]?.jobs !== companies*jobsPerCompany || counts.rows[0]?.sources !== companies || counts.rows[0]?.failed_tasks || counts.rows[0]?.pending) throw new Error(`Benchmark invariant failed: ${JSON.stringify(counts.rows[0])}`);
    console.log(JSON.stringify(results.at(-1)));
  }
  queryMs.sort((a,b) => a-b);
  const report = { at: new Date().toISOString(), environment: { node: process.version, cpu: cpus()[0]?.model, memoryGiB: Math.round(totalmem()/2**30) },
    companies, jobsPerCompany, consumers, queueMode, aiCalls: 0, syntheticHttp: true, results,
    peakWorkerRssMiB: Math.round(peakRss/2**20), pageQuerySamples: queryMs.length, pageQueryP95Ms: Number((queryMs[Math.floor(queryMs.length*.95)] ?? 0).toFixed(2)),
    limitations: `Local synthetic ATS responses; ${queueMode === "production" ? "production queue with one interactive, one scan and one background slot; default 3-second polling and graceful shutdown included" : "three unrestricted queue consumers"}. Excludes real provider pacing, browser memory, model cost and remote database latency.` };
  await writeFile(process.env.SCALE_REPORT_PATH ?? "/tmp/christopher-scale-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  clearInterval(sample);
  while (sampling) await new Promise(resolve => setTimeout(resolve, 10));
  await deps.close();
}
