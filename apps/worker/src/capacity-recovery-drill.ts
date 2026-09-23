/**
 * Production-shaped, local-only worker capacity drill.
 *
 * This deliberately uses the real verification handler, queue and Chromium renderer against a
 * private fixture server. It never needs an AI key or public network access.
 */
import { createDb, enqueueTask, schema } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { readFile, writeFile } from "node:fs/promises";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { handlers } from "./handlers";
import { TaskQueue } from "./queue";
import { startTestServer, type RouteTable } from "./test-server";
// The guard is plain ESM so Node's fast release-gate tests can import it without a TS loader.
// @ts-expect-error the runtime module is intentionally JavaScript
import { CAPACITY_DATABASE as EXPECTED_DB, summariseSamples, validateCapacityDatabase } from "./capacity-drill-guards.mjs";

const REGISTERED_USERS = 100;
const ACTIVE_USERS = 10;
const ITERATIONS = 3;
const TASKS_PER_ITERATION = 3;
const MAX_SECONDS = 180;

async function numberFile(path: string): Promise<number> {
  try { return Number((await readFile(path, "utf8")).trim()); } catch { return 0; }
}

async function resourceSample() {
  const memory = await numberFile("/sys/fs/cgroup/memory.current");
  let cpuUsec = 0;
  try {
    const cpu = await readFile("/sys/fs/cgroup/cpu.stat", "utf8");
    cpuUsec = Number(cpu.match(/^usage_usec\s+(\d+)/m)?.[1] ?? 0);
  } catch { /* outside a cgroup */ }
  const pairs = async (path: string) => {
    try { return Object.fromEntries((await readFile(path, "utf8")).trim().split("\n").map(line => { const [key, value] = line.split(/\s+/); return [key!, Number(value)]; })); }
    catch { return {} as Record<string, number>; }
  };
  const memoryStat = await pairs("/sys/fs/cgroup/memory.stat");
  const memoryEvents = await pairs("/sys/fs/cgroup/memory.events");
  const memoryMax = await numberFile("/sys/fs/cgroup/memory.max");
  let cpuQuota = 0, cpuPeriod = 0;
  try { [cpuQuota, cpuPeriod] = (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim().split(/\s+/).map(Number) as [number, number]; } catch {}
  return {
    at: new Date().toISOString(), rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    cgroupMiB: +(memory / 1048576).toFixed(1), anonMiB: +((memoryStat.anon ?? 0) / 1048576).toFixed(1),
    fileMiB: +((memoryStat.file ?? 0) / 1048576).toFixed(1), memoryEvents, memoryMaxMiB: +(memoryMax / 1048576).toFixed(1),
    cpuLimit: cpuQuota > 0 && cpuPeriod > 0 ? +(cpuQuota / cpuPeriod).toFixed(3) : 0, cpuUsec,
  };
}

function fixtureRoutes(hosts: string[]): RouteTable {
  const filler = "x".repeat(1_250_000);
  const jobs = { jobs: [
    { id: 1, title: "Strategy Director", absolute_url: "https://job-boards.greenhouse.io/local/jobs/1", location: { name: "London, UK" } },
    { id: 2, title: "Operations Lead", absolute_url: "https://job-boards.greenhouse.io/local/jobs/2", location: { name: "London, UK" } },
  ] };
  const routes: RouteTable = {
    "boards-api.greenhouse.io": { "/v1/boards/local/jobs": { body: jobs }, "/v1/boards/local": { body: { name: "Local Fixture" } } },
    "job-boards.greenhouse.io": { "/local": { body: "<html><body>Local Fixture jobs</body></html>" } },
  };
  for (const host of hosts) routes[host] = {
    "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
    "/": { body: `<!doctype html><html><head><title>Local Fixture</title></head><body><div id="root">Loading…</div>
      <script>/*${filler}*/fetch("https://boards-api.greenhouse.io/v1/boards/local/jobs").then(r=>r.json()).then(data=>{root.innerHTML=data.jobs.map(j=>'<a href="'+j.absolute_url+'">'+j.title+'</a>').join('')})</script></body></html>` },
    "/careers": { body: `<html><body><a href="https://boards-api.greenhouse.io/v1/boards/local/jobs">Open roles</a></body></html>` },
  };
  return routes;
}

async function main() {
  const databaseUrl = validateCapacityDatabase(process.env.DATABASE_URL ?? "").href;
  const memoryLimitMiB = Number(process.env.CAPACITY_MEMORY_LIMIT_MIB ?? 512);
  if (![512, 1024].includes(memoryLimitMiB)) throw new Error("CAPACITY_MEMORY_LIMIT_MIB must be 512 or 1024");
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) throw new Error("paid AI credentials must be absent");
  const { db, pool } = createDb(databaseUrl, { max: 4 });
  await runMigrations(db);
  const existing = await db.execute<{ n: number }>(sql`select count(*)::int n from users`);
  if (Number(existing.rows[0]?.n)) throw new Error(`${EXPECTED_DB} is occupied; retained without changes`);

  const hosts = Array.from({ length: ITERATIONS * TASKS_PER_ITERATION }, (_, i) => `capacity-${i}.example`);
  const server = await startTestServer({}, [...hosts, "boards-api.greenhouse.io", "job-boards.greenhouse.io"]);
  server.setRoutes(fixtureRoutes(hosts));
  const deps = await createDeps(readEnv({ DATABASE_URL: databaseUrl, WORKER_CONCURRENCY: "3", BROWSER_CONCURRENCY: "1",
    SCAN_SPREAD_MINUTES: "0", AVA_HOST_MAP: JSON.stringify(server.hostMap), RENDER_INSTANCE_ID: "local-capacity-drill" }));
  const samples: Awaited<ReturnType<typeof resourceSample>>[] = [];
  const timer = setInterval(() => void resourceSample().then(s => samples.push(s)), 250);
  const started = Date.now();
  const failures: string[] = [];
  try {
    const users = await db.insert(schema.users).values(Array.from({ length: REGISTERED_USERS }, (_, i) => ({
      email: `capacity-${i}@example.test`, name: `Capacity ${i}`, claimedAt: new Date(), emailVerifiedAt: new Date(),
    }))).returning({ id: schema.users.id });
    const iterations = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const batchStarted = Date.now();
      const candidates = await db.insert(schema.discoveryCandidates).values(Array.from({ length: TASKS_PER_ITERATION }, (_, offset) => {
        const index = iteration * TASKS_PER_ITERATION + offset;
        return { userId: users[index % ACTIVE_USERS]!.id, domain: hosts[index]!, name: `Fixture ${index}`,
          homepageUrl: `https://${hosts[index]}/`, rationale: "Synthetic capacity fixture", quote: "", batchKey: `capacity-${iteration}` };
      })).returning({ id: schema.discoveryCandidates.id });
      for (const candidate of candidates) await enqueueTask(db, "verify_company", { candidateId: candidate.id }, { dedupeKey: `capacity:${candidate.id}`, priority: 1 });
      const queue = new TaskQueue(deps, handlers, { concurrency: 3, workerId: `capacity-${iteration}`, pollMs: 50 });
      queue.start();
      let statuses: Record<string, number> = {};
      while (Date.now() - batchStarted < MAX_SECONDS * 1000) {
        const rows = await db.execute<{ status: string; n: number }>(sql`select status, count(*)::int n from tasks where dedupe_key like 'capacity:%' group by status`);
        statuses = Object.fromEntries(rows.rows.map(r => [r.status, Number(r.n)]));
        if ((statuses.done ?? 0) + (statuses.failed ?? 0) === (iteration + 1) * TASKS_PER_ITERATION) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await queue.stop(10_000);
      if ((statuses.done ?? 0) !== (iteration + 1) * TASKS_PER_ITERATION) failures.push(`iteration ${iteration + 1}: ${JSON.stringify(statuses)}`);
      iterations.push({ iteration: iteration + 1, seconds: +((Date.now() - batchStarted) / 1000).toFixed(2), statuses });
    }
    samples.push(await resourceSample());
    const taskRows = await db.execute<{ startedAt: string; finishedAt: string }>(sql`select started_at as "startedAt", finished_at as "finishedAt" from tasks where dedupe_key like 'capacity:%' order by started_at`);
    const overlaps = taskRows.rows.slice(1).filter((row, i) => new Date(row.startedAt) < new Date(taskRows.rows[i]!.finishedAt)).length;
    if (overlaps) failures.push(`${overlaps} verification task intervals overlapped`);
    const resources = summariseSamples(samples);
    const headroomLimitMiB = memoryLimitMiB * 0.70;
    const workloadCompleted = failures.length === 0;
    const actualMemoryLimit = samples[0]?.memoryMaxMiB ?? 0;
    const actualCpuLimit = samples[0]?.cpuLimit ?? 0;
    if (actualMemoryLimit !== memoryLimitMiB || actualCpuLimit !== 0.5) failures.push(`cgroup limits not proven: memory ${actualMemoryLimit} MiB, CPU ${actualCpuLimit}`);
    if (resources.peakCgroupMiB >= headroomLimitMiB) failures.push(`peak cgroup memory ${resources.peakCgroupMiB} MiB >= 70% headroom gate ${headroomLimitMiB} MiB`);
    const report = {
      at: new Date().toISOString(), passed: failures.length === 0, workloadCompleted, capacityGatePassed: failures.length === 0, failures,
      environment: { requestedMemoryLimitMiB: memoryLimitMiB, actualMemoryLimitMiB: actualMemoryLimit, actualCpuLimit, workerConcurrency: 3, browserConcurrency: 1, paidAiEnabled: false },
      target: { registeredUsers: REGISTERED_USERS, simultaneouslyActiveUsers: ACTIVE_USERS },
      workload: { iterations: ITERATIONS, verifyTasksPerIteration: TASKS_PER_ITERATION, fixtureHtmlMiB: 1.19, browserCapable: true },
      elapsedSeconds: +((Date.now() - started) / 1000).toFixed(2), iterations, verificationIntervalOverlaps: overlaps,
      resources, samples,
      limitations: ["Local Docker evidence only; it does not pass the hosted capacity gate.", "Synthetic private pages exercise browser-capable discovery without public providers or paid AI.", "The local PostgreSQL server is outside the worker cgroup and does not model Render network latency or PgBouncer."],
    };
    await writeFile(process.env.CAPACITY_REPORT_PATH ?? "/tmp/ava-worker-capacity.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ passed: report.passed, elapsedSeconds: report.elapsedSeconds, resources, failures }));
    if (!report.passed) process.exitCode = 1;
  } finally {
    clearInterval(timer);
    await deps.close();
    await server.close();
    await pool.end();
  }
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) await main();
