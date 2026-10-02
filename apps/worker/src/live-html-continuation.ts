/**
 * Guarded, read-only public Siemens listing audit. This script is intentionally separate from
 * production scheduling: it runs only against the named local scratch database, has no followers,
 * disables paid AI and the browser, and executes an explicit number of real queue claims.
 *
 * Prepare a local database named ava_source_live on port 55439, then:
 *   DATABASE_URL=postgres://...@127.0.0.1:55439/ava_source_live pnpm --filter @ava/worker exec tsx src/live-html-continuation.ts --init
 *   SCRAPER_CONTACT_EMAIL=you@example.org DATABASE_URL=... pnpm --filter @ava/worker exec tsx src/live-html-continuation.ts --claims 2 --out /absolute/report.json
 * Repeat the second command in a fresh process with `--max-pages 80` to prove persistence:
 * the page ceiling is cumulative across processes, while each claim stages at most twenty pages.
 * `--finish --claims 30` permits a longer, still bounded follow-up once the short audit is reviewed.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { schema, enqueueTask } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { and, desc, eq, sql } from "drizzle-orm";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { htmlSourceFingerprint } from "./html-scan-checkpoint";
import { AUDIT_CLAIM_MS, canStartAuditClaim } from "./live-html-audit-budget";
import { handleScanCompany } from "./handlers/scan";
import { assertRunOwnership, claimTask, completeTask, deferTask, failTask, TaskDeferred } from "./queue";

const SOURCE_URL = "https://jobs.siemens.com/en_US/externaljobs/SearchJobs/";
const SCRATCH_DB = "ava_source_live";
const MAX_CLAIMS = 30;
const MAX_WALL_MS = 15 * 60_000;
const MAX_PAGES = 600;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

function boundedInt(name: string, fallback: number, max: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be an integer from 1 to ${max}`);
  return value;
}

function scratchUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  const url = new URL(value);
  if (!(["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "55439" && decodeURIComponent(url.pathname.slice(1)) === SCRATCH_DB)) {
    throw new Error(`Refusing any database except local 127.0.0.1:55439/${SCRATCH_DB}`);
  }
  return value;
}

interface ClaimEvidence {
  at: string;
  durationMs: number;
  listingFetchCalls: number;
  listingResponseBytes: number;
  pagesStaged: number;
  stagedPostings: number;
  publishedJobs: number;
  taskStatus: string;
  scanStatus: string | null;
  scanPostings: number | null;
  sourceFingerprint: string;
}

async function main() {
  const databaseUrl = scratchUrl();
  const initialise = process.argv.includes("--init");
  const finish = process.argv.includes("--finish");
  const claims = boundedInt("claims", initialise ? 1 : 2, finish ? MAX_CLAIMS : 2);
  const maxMinutes = boundedInt("max-minutes", finish ? 15 : 6, 15);
  // This is a cumulative ceiling over the durable generation, including earlier invocations.
  const maxPages = boundedInt("max-pages", finish ? MAX_PAGES : 40, MAX_PAGES);
  const outPath = option("out");
  if (!initialise && !outPath) throw new Error("--out needs an absolute JSON path for resumable evidence");
  if (outPath && !isAbsolute(outPath)) throw new Error("--out must be an absolute path");
  if (!initialise && !process.env.SCRAPER_CONTACT_EMAIL) throw new Error("Set SCRAPER_CONTACT_EMAIL for the public site's user agent");
  if (process.env.AVA_HOST_MAP || process.env.CHRISTOPHER_HOST_MAP) throw new Error("Host mapping is forbidden in the public audit");
  // A local scratch audit never receives provider credentials or starts Chromium, regardless of
  // what the invoking shell has configured for other work.
  const env = readEnv({ ...process.env, DATABASE_URL: databaseUrl, ANTHROPIC_API_KEY: "", AVA_DISABLE_BROWSER: "1",
    WORKER_CONCURRENCY: "1", CV_CONCURRENCY: "1", NODE_ENV: "development" });
  const deps = await createDeps(env);
  try {
    if (deps.ai.enabled || deps.browser) throw new Error("Public audit must have AI and browser disabled");
    await runMigrations(deps.db);
    let [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.domain, "siemens.com")).limit(1);
    if (initialise) {
      if (!company) [company] = await deps.db.insert(schema.companies).values({ name: "Siemens", domain: "siemens.com", homepageUrl: "https://www.siemens.com/" }).returning();
      let [source] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company!.id)).limit(1);
      if (!source) [source] = await deps.db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: SOURCE_URL, status: "active" }).returning();
      if (source!.type !== "html" || source!.url !== SOURCE_URL) throw new Error("Scratch source differs from the audited first-party URL");
      const [existing] = await deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.type, "scan_company"), sql`${schema.tasks.payload}->>'companyId' = ${company!.id}`)).limit(1);
      if (!existing) await enqueueTask(deps.db, "scan_company", { companyId: company!.id, trigger: "schedule" }, { dedupeKey: "siemens-source-continuation-audit" });
      process.stdout.write(JSON.stringify({ prepared: true, database: SCRATCH_DB, source: SOURCE_URL, taskId: existing?.id ?? "queued" }) + "\n");
      return;
    }
    if (!company) throw new Error("No scratch company; run --init first");
    const [source] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id)).limit(1);
    if (!source || source.type !== "html" || source.url !== SOURCE_URL) throw new Error("Scratch source is absent or changed; refusing to fetch");
    const followers = await deps.db.select({ id: schema.companySubscriptions.id }).from(schema.companySubscriptions).where(eq(schema.companySubscriptions.companyId, company.id));
    if (followers.length) throw new Error("Scratch company has followers; refusing an audit that could notify people");
    const otherSources = await deps.db.select({ id: schema.careerSources.id }).from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    if (otherSources.length !== 1) throw new Error("Scratch company must have exactly one source");

    let report: { source: string; database: string; claims: ClaimEvidence[]; stop?: { reason: string; at: string } } = { source: SOURCE_URL, database: SCRATCH_DB, claims: [] };
    try { if (outPath) report = JSON.parse(readFileSync(outPath, "utf8")) as typeof report; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (report.source !== SOURCE_URL || report.database !== SCRATCH_DB || !Array.isArray(report.claims)) throw new Error("Existing evidence file names a different audit");
    const scriptStarted = Date.now();
    const wallBudgetMs = Math.min(maxMinutes * 60_000, MAX_WALL_MS);
    const persist = () => {
      if (!outPath) return;
      const pending = `${outPath}.${process.pid}.tmp`;
      writeFileSync(pending, JSON.stringify(report, null, 2) + "\n");
      renameSync(pending, outPath);
    };
    // A previous invocation's stop does not describe this invocation.
    delete report.stop;
    for (let i = 0; i < claims; i++) {
      if (!canStartAuditClaim(scriptStarted, Date.now(), wallBudgetMs)) {
        report.stop = { reason: "insufficient_claim_headroom", at: new Date().toISOString() };
        persist();
        process.stdout.write(JSON.stringify(report.stop) + "\n");
        break;
      }
      const [progress] = await deps.db.select({ pages: sql<number>`count(*)::int` }).from(schema.htmlScanPages)
        .innerJoin(schema.htmlScanGenerations, eq(schema.htmlScanPages.generationId, schema.htmlScanGenerations.id))
        .where(eq(schema.htmlScanGenerations.sourceId, source.id));
      // A claim may add twenty pages. Refuse it before exceeding the caller's ceiling.
      if ((progress?.pages ?? 0) + 20 > maxPages) break;
      // The database query can consume significant wall time. Check again immediately before claiming.
      if (!canStartAuditClaim(scriptStarted, Date.now(), wallBudgetMs)) {
        report.stop = { reason: "insufficient_claim_headroom", at: new Date().toISOString() };
        persist();
        process.stdout.write(JSON.stringify(report.stop) + "\n");
        break;
      }
      let task = await claimTask(deps.db, `source-audit-${process.pid}`, "scan");
      if (!task) {
        await new Promise(resolve => setTimeout(resolve, 1100));
        task = await claimTask(deps.db, `source-audit-${process.pid}`, "scan");
      }
      if (!task) break;
      if (task.type !== "scan_company" || (task.payload as { companyId?: string }).companyId !== company.id) throw new Error("Scratch queue contains unexpected work");
      if (!canStartAuditClaim(scriptStarted, Date.now(), wallBudgetMs)) {
        // Claiming (including its retry wait) consumed the headroom. Release the untouched task.
        if (!await deferTask(deps.db, task, new Date(Date.now() + 1000), task.result)) throw new Error("Lost task lease while releasing untouched audit claim");
        report.stop = { reason: "insufficient_claim_headroom", at: new Date().toISOString() };
        persist();
        process.stdout.write(JSON.stringify(report.stop) + "\n");
        break;
      }
      const claimStarted = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("audit claim deadline")), AUDIT_CLAIM_MS);
      let listingFetchCalls = 0;
      let listingResponseBytes = 0;
      const fetchText = deps.fetcher.fetchText.bind(deps.fetcher);
      deps.fetcher.fetchText = async (...args) => {
        const response = await fetchText(...args);
        listingFetchCalls++;
        if (!response.revalidated) listingResponseBytes += Buffer.byteLength(response.body, "utf8");
        return response;
      };
      try {
        const runDeps = { ...deps, signal: controller.signal, assertOwnership: (db: typeof deps.db) => assertRunOwnership(db, task!, controller.signal) };
        const result = await handleScanCompany(task, runDeps);
        if (result instanceof TaskDeferred) {
          if (!await deferTask(deps.db, task, result.until, result.result)) throw new Error("Lost task lease during deferral");
        } else if (!await completeTask(deps.db, task, result)) throw new Error("Lost task lease during completion");
      } catch (error) {
        await failTask(deps.db, task, error);
        throw error;
      } finally {
        clearTimeout(timer);
        deps.fetcher.fetchText = fetchText;
      }
      const stagedRows = await deps.db.execute<{ pages: number; postings: number }>(sql`
        select count(distinct p.page_index)::int as pages,
          count(distinct item.posting->>'url')::int as postings
        from html_scan_pages p join html_scan_generations g on g.id=p.generation_id
        left join lateral jsonb_array_elements(p.postings) item(posting) on true
        where g.source_id=${source.id}`);
      const staged = stagedRows.rows[0];
      const [published] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.jobs).where(eq(schema.jobs.sourceId, source.id));
      const [latest] = await deps.db.select({ status: schema.scans.status, postingsFound: schema.scans.postingsFound }).from(schema.scans)
        .where(eq(schema.scans.sourceId, source.id)).orderBy(desc(schema.scans.startedAt)).limit(1);
      const [currentTask] = await deps.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, task.id));
      const [currentSource] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id));
      const evidence: ClaimEvidence = { at: new Date().toISOString(), durationMs: Date.now() - claimStarted,
        listingFetchCalls, listingResponseBytes, pagesStaged: staged?.pages ?? 0, stagedPostings: staged?.postings ?? 0,
        publishedJobs: published?.n ?? 0, taskStatus: currentTask?.status ?? "missing", scanStatus: latest?.status ?? null,
        scanPostings: latest?.postingsFound ?? null, sourceFingerprint: htmlSourceFingerprint(currentSource ?? source) };
      report.claims.push(evidence);
      persist();
      process.stdout.write(JSON.stringify(evidence) + "\n");
      if (currentTask?.status === "done" || currentTask?.status === "failed") break;
    }
  } finally {
    await deps.close();
  }
}

main().catch(error => { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; });
