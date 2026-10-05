/** Bounded public Siemens continuation audit. Scratch database and synthetic follower only. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { renamedEnv } from "@col/core";
import { createUser, enqueueTask, schema, subscribeToCompany } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { htmlSourceFingerprint } from "./html-scan-checkpoint";
import { AUDIT_CLAIM_MS, canStartAuditClaim } from "./live-html-audit-budget";
import { handleScanCompany } from "./handlers/scan";
import { assertRunOwnership, claimTask, completeTask, deferTask, failTask, TaskDeferred } from "./queue";

const DATABASE = "ava_source_publication_live";
const SOURCE_URL = "https://jobs.siemens.com/en_US/externaljobs/SearchJobs/";
const FOLLOWER_EMAIL = "siemens-publication-audit@example.invalid";
const MAX_WALL_MS = 10 * 60_000;

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  const url = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "55439" ||
      decodeURIComponent(url.pathname.slice(1)) !== DATABASE) {
    throw new Error(`Refusing any database except local 127.0.0.1:55439/${DATABASE}`);
  }
  return value;
}

function outputPath(): string {
  const index = process.argv.indexOf("--out");
  const path = index < 0 ? undefined : process.argv[index + 1];
  if (!path || !isAbsolute(path)) throw new Error("--out needs an absolute JSON path");
  return path;
}

interface ResponseEvidence {
  requestUrl: string;
  responseUrl: string;
  status: number;
  responseDate: string | null;
  contentHash: string | null;
  transferredBytes: number;
}

async function main(): Promise<void> {
  const url = databaseUrl();
  const initialise = process.argv.includes("--init");
  if (!initialise && !process.env.SCRAPER_CONTACT_EMAIL) throw new Error("SCRAPER_CONTACT_EMAIL is required for the public fetcher");
  if (renamedEnv(process.env, "COL_HOST_MAP", "AVA_HOST_MAP", "CHRISTOPHER_HOST_MAP")) throw new Error("Host mapping is forbidden in this public audit");
  // The caller never starts score/description workers. This process cannot call a paid model or
  // render a browser page even if a credential exists in the invoking shell.
  const env = readEnv({ ...process.env, DATABASE_URL: url, ANTHROPIC_API_KEY: "", COL_DISABLE_BROWSER: "1",
    WORKER_CONCURRENCY: "1", CV_CONCURRENCY: "1", NODE_ENV: "development" });
  const deps = await createDeps(env);
  try {
    if (deps.ai.enabled || deps.browser) throw new Error("AI and browser must be disabled");
    await runMigrations(deps.db);
    if (initialise) {
      const [prior] = await deps.db.select({ id: schema.companies.id }).from(schema.companies).limit(1);
      if (prior) throw new Error("Scratch database is not fresh");
      const { user } = await createUser(deps.db, { email: FOLLOWER_EMAIL, name: "Publication audit", role: "member", emailVerified: true });
      await deps.db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: {
        includeKeywords: [], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true,
      } });
      const [company] = await deps.db.insert(schema.companies).values({ name: "Siemens", domain: "siemens.com",
        homepageUrl: "https://www.siemens.com/" }).returning();
      const [source] = await deps.db.insert(schema.careerSources).values({ companyId: company!.id,
        type: "html", url: SOURCE_URL, status: "active" }).returning();
      await subscribeToCompany(deps.db, user.id, company!.id);
      const taskId = await enqueueTask(deps.db, "scan_company", { companyId: company!.id, trigger: "schedule" },
        { dedupeKey: "siemens-positive-publication-audit" });
      if (!taskId) throw new Error("Scan task was not queued");
      process.stdout.write(JSON.stringify({ database: DATABASE, companyId: company!.id, sourceId: source!.id,
        taskId, followerId: user.id, sourceUrl: SOURCE_URL, aiEnabled: deps.ai.enabled, browserEnabled: !!deps.browser }) + "\n");
      return;
    }

    const out = outputPath();
    const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.domain, "siemens.com"));
    if (!company) throw new Error("Run --init in the fresh database first");
    const [source] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    if (!source || source.type !== "html" || source.url !== SOURCE_URL) throw new Error("Source fixture differs from verified Siemens URL");
    const [follower] = await deps.db.select({ userId: schema.companySubscriptions.userId })
      .from(schema.companySubscriptions).where(eq(schema.companySubscriptions.companyId, company.id));
    const [user] = follower ? await deps.db.select({ email: schema.users.email, verified: schema.users.emailVerifiedAt })
      .from(schema.users).where(eq(schema.users.id, follower.userId)) : [];
    if (!follower || !user || user.email !== FOLLOWER_EMAIL || !user.verified) throw new Error("Synthetic verified follower missing");
    const [taskRow] = await deps.db.select().from(schema.tasks).where(and(eq(schema.tasks.type, "scan_company"),
      sql`${schema.tasks.payload}->>'companyId' = ${company.id}`));
    if (!taskRow) throw new Error("Scan task missing");

    type Claim = Record<string, unknown>;
    const report: { fixture: string; sourceUrl: string; startedAt: string; claims: Claim[]; stop?: string } = {
      fixture: "Fresh isolated Siemens public HTTP listing with one synthetic verified follower", sourceUrl: SOURCE_URL,
      startedAt: new Date().toISOString(), claims: [],
    };
    const persist = () => {
      const temporary = `${out}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n");
      renameSync(temporary, out);
    };
    persist();
    const scriptStarted = Date.now();
    for (let number = 1; number <= 3; number++) {
      if (!canStartAuditClaim(scriptStarted, Date.now(), MAX_WALL_MS)) { report.stop = "Insufficient 180-second claim headroom"; break; }
      const [before] = await deps.db.select({ pages: sql<number>`count(*)::int` }).from(schema.htmlScanPages)
        .innerJoin(schema.htmlScanGenerations, eq(schema.htmlScanPages.generationId, schema.htmlScanGenerations.id))
        .where(eq(schema.htmlScanGenerations.sourceId, source.id));
      if ((before?.pages ?? 0) + 20 > 60) { report.stop = "60-page audit cap"; break; }
      let task = await claimTask(deps.db, `publication-audit-${process.pid}`, "scan");
      if (!task) {
        await new Promise(resolve => setTimeout(resolve, 1100));
        task = await claimTask(deps.db, `publication-audit-${process.pid}`, "scan");
      }
      if (!task || task.id !== taskRow.id) { report.stop = "Expected scan task not claimable"; break; }
      if (!canStartAuditClaim(scriptStarted, Date.now(), MAX_WALL_MS)) {
        await deferTask(deps.db, task, new Date(Date.now() + 1000), task.result);
        report.stop = "Insufficient claim headroom after queue claim";
        break;
      }
      const responses: ResponseEvidence[] = [];
      const originalFetch = deps.fetcher.fetchText.bind(deps.fetcher);
      deps.fetcher.fetchText = async (...args) => {
        const response = await originalFetch(...args);
        responses.push({ requestUrl: args[0], responseUrl: response.url, status: response.status,
          responseDate: response.headers.date ?? response.headers.Date ?? null,
          contentHash: response.contentHash ?? null,
          transferredBytes: response.revalidated ? 0 : Buffer.byteLength(response.body, "utf8") });
        return response;
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("180-second audit claim deadline")), AUDIT_CLAIM_MS);
      const claimStarted = Date.now();
      try {
        const runDeps = { ...deps, signal: controller.signal,
          assertOwnership: (db: typeof deps.db) => assertRunOwnership(db, task!, controller.signal) };
        const result = await handleScanCompany(task, runDeps);
        if (result instanceof TaskDeferred) {
          if (!await deferTask(deps.db, task, result.until, result.result)) throw new Error("Could not defer audit task");
        } else if (!await completeTask(deps.db, task, result)) throw new Error("Could not complete audit task");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure: Claim = { number, failed: true, at: new Date().toISOString(),
          elapsedMs: Date.now() - claimStarted, requestCount: responses.length,
          decodedListingBodyBytes: responses.reduce((sum, response) => sum + response.transferredBytes, 0),
          responses, error: message, failureBookkeepingErrors: [] as string[] };
        const bookkeepingErrors = failure.failureBookkeepingErrors as string[];
        try {
          const [checkpoint] = await deps.db.select({
            publishedPageCount: schema.htmlScanGenerations.publishedPageCount,
            publishedNewCount: schema.htmlScanGenerations.publishedNewCount,
            nextUrl: schema.htmlScanGenerations.nextUrl,
          }).from(schema.htmlScanGenerations)
            .where(and(eq(schema.htmlScanGenerations.taskId, task.id), eq(schema.htmlScanGenerations.sourceId, source.id)));
          failure.checkpoint = checkpoint ?? null;
        } catch (readError) {
          bookkeepingErrors.push(`Checkpoint read: ${readError instanceof Error ? readError.message : String(readError)}`);
        }
        report.claims.push(failure);
        report.stop = `Claim ${number} failed: ${message}`;
        try { persist(); } catch (persistError) {
          process.stderr.write(`Could not persist failed-claim evidence: ${String(persistError)}\n`);
        }
        try { await failTask(deps.db, task, error); } catch (failError) {
          bookkeepingErrors.push(`Task failure bookkeeping: ${failError instanceof Error ? failError.message : String(failError)}`);
          try { persist(); } catch (persistError) {
            process.stderr.write(`Could not persist failure-bookkeeping error: ${String(persistError)}\n`);
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
        deps.fetcher.fetchText = originalFetch;
      }
      const [generation] = await deps.db.select().from(schema.htmlScanGenerations)
        .where(and(eq(schema.htmlScanGenerations.taskId, task.id), eq(schema.htmlScanGenerations.sourceId, source.id)));
      const [pages] = generation ? await deps.db.select({ count: sql<number>`count(distinct ${schema.htmlScanPages.pageIndex})::int`, roles: sql<number>`count(distinct item.posting->>'url')::int` })
        .from(schema.htmlScanPages).leftJoin(sql`lateral jsonb_array_elements(${schema.htmlScanPages.postings}) item(posting)`, sql`true`)
        .where(eq(schema.htmlScanPages.generationId, generation.id)) : [];
      const [jobs] = await deps.db.select({ count: sql<number>`count(*)::int` }).from(schema.jobs).where(eq(schema.jobs.sourceId, source.id));
      const [views] = await deps.db.select({ count: sql<number>`count(*)::int` }).from(schema.userJobs)
        .innerJoin(schema.jobs, eq(schema.userJobs.jobId, schema.jobs.id))
        .where(and(eq(schema.userJobs.userId, follower.userId), eq(schema.jobs.sourceId, source.id), eq(schema.userJobs.inTable, true)));
      const [scanCount] = await deps.db.select({ count: sql<number>`count(*)::int` }).from(schema.scans).where(eq(schema.scans.sourceId, source.id));
      const [aiCount] = await deps.db.select({ count: sql<number>`count(*)::int` }).from(schema.aiCalls);
      const [currentSource] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.id, source.id));
      const [currentTask] = await deps.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
      const queued = await deps.db.select({ type: schema.tasks.type, count: sql<number>`count(*)::int` })
        .from(schema.tasks).where(eq(schema.tasks.status, "queued")).groupBy(schema.tasks.type);
      const claim: Claim = { number, at: new Date().toISOString(), elapsedMs: Date.now() - claimStarted,
        requestCount: responses.length, transferredBytes: responses.reduce((sum, response) => sum + response.transferredBytes, 0),
        responses, stagedPages: pages?.count ?? 0, stagedDistinctRoles: pages?.roles ?? 0,
        publishedPageCount: generation?.publishedPageCount ?? null, publishedNewCount: generation?.publishedNewCount ?? null,
        generationRestarts: generation?.restarts ?? null, generationStartedAt: generation?.startedAt ?? null,
        generationExpiresAt: generation?.expiresAt ?? null, generationNextUrl: generation?.nextUrl ?? null,
        jobs: jobs?.count ?? 0, matchingViews: views?.count ?? 0, scans: scanCount?.count ?? 0, aiCalls: aiCount?.count ?? 0,
        taskStatus: currentTask?.status ?? null, taskRunAfter: currentTask?.runAfter ?? null,
        queuedTasksByType: queued, sourceStatus: currentSource?.status ?? null,
        sourceLastOkScanAt: currentSource?.lastOkScanAt ?? null,
        sourceLastPostingsCount: currentSource?.lastPostingsCount ?? null,
        sourceConsecutiveFailures: currentSource?.consecutiveFailures ?? null,
        sourceNextScanAt: currentSource?.nextScanAt ?? null,
        sourceFingerprint: currentSource ? htmlSourceFingerprint(currentSource) : null };
      report.claims.push(claim);
      persist();
      process.stdout.write(JSON.stringify({ number, elapsedMs: claim.elapsedMs, requests: claim.requestCount,
        stagedPages: claim.stagedPages, jobs: claim.jobs, matchingViews: claim.matchingViews,
        publishedPageCount: claim.publishedPageCount, scans: claim.scans, aiCalls: claim.aiCalls }) + "\n");
      if (currentTask?.status === "done" || currentTask?.status === "failed") { report.stop = "Task completed or failed"; break; }
      if (number >= 2 && (jobs?.count ?? 0) > 0) { report.stop = "Two successful claims with useful positives"; break; }
    }
    report.stop ??= "Three-claim audit cap";
    persist();
  } finally {
    await deps.close();
  }
}

main().catch(error => { process.stderr.write(`${(error as Error).stack ?? error}\n`); process.exitCode = 1; });
