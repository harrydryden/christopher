/** Synthetic, isolated two-claim HTML scan for browser evidence. No site or model is contacted. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createUser, enqueueTask, schema, subscribeToCompany } from "../../../../../packages/db/src/index.ts";
import { runMigrations } from "../../../../../packages/db/src/migrate.ts";
import { eq } from "../../../../../apps/worker/node_modules/drizzle-orm/index.js";
import { createDeps } from "../../../../../apps/worker/src/context.ts";
import { readEnv } from "../../../../../apps/worker/src/env.ts";
import { handleScanCompany } from "../../../../../apps/worker/src/handlers/scan.ts";
import { TaskDeferred } from "../../../../../apps/worker/src/queue.ts";

const base = dirname(fileURLToPath(import.meta.url));
const databaseUrl = "postgres://postgres:postgres@127.0.0.1:55439/ava_partial_browser";
const statePath = join(base, "fixture-state.json");
const mode = process.argv[2];
if (mode !== "partial" && mode !== "terminal") throw new Error("Pass partial or terminal");
if (process.env.ANTHROPIC_API_KEY || process.env.RESEND_API_KEY) throw new Error("Remove paid-provider keys before fixture run");
process.env.DATABASE_URL = databaseUrl;
process.env.AVA_DISABLE_BROWSER = "1";
process.env.SCRAPER_CONTACT_EMAIL = "fixture@example.invalid";

const listing = (page: number) => `<html><body><main><p>${page + 1} - ${page + 1} of 25 results</p><ul class="jobs"><li><a href="/jobs/role-${page + 1}">Operations Role ${page + 1}</a></li></ul>${page < 24 ? `<a rel="next" href="/listing?page=${page + 1}">Next page</a>` : ""}</main></body></html>`;
const fetched: string[] = [];
const bootstrap = createDb(databaseUrl, { max: 1 });
await runMigrations(bootstrap.db);
await bootstrap.pool.end();
const deps = await createDeps(readEnv(), { settingsTtlMs: 0 });
const db = deps.db;
const fetchText = async (url: string) => {
  const parsed = new URL(url);
  if (parsed.hostname !== "pager.example" || parsed.pathname !== "/listing") throw new Error(`Unexpected fixture URL: ${url}`);
  const page = Number(parsed.searchParams.get("page") ?? "0");
  if (!Number.isInteger(page) || page < 0 || page > 24) throw new Error(`Unexpected fixture page: ${page}`);
  fetched.push(url);
  const body = listing(page);
  return { url, status: 200, headers: {}, body, contentHash: createHash("sha1").update(body).digest("hex") };
};
const fakeDeps = { ...deps, fetcher: { fetchText, fetchBytes: async () => { throw new Error("Unexpected byte fetch"); } } as typeof deps.fetcher };

try {
  let state: { userId: string; companyId: string; sourceId: string; taskId: string };
  if (mode === "partial") {
    const { user } = await createUser(db, { email: "partial-browser@example.invalid", name: "Fixture reviewer", role: "member", emailVerified: true });
    await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: {
      includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true,
    } });
    const [company] = await db.insert(schema.companies).values({ name: "Pager fixture", domain: "pager.example", homepageUrl: "https://pager.example/", logoFetchedAt: new Date() }).returning();
    // A local synthetic icon keeps the browser from attempting third-party favicon fallbacks.
    const iconBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9NFCsAAAAASUVORK5CYII=";
    await db.insert(schema.companyLogos).values({ companyId: company!.id, contentType: "image/png", dataBase64: iconBase64,
      byteLength: Buffer.from(iconBase64, "base64").length, source: "site_icon", sourceUrl: "https://pager.example/favicon.png" });
    await subscribeToCompany(db, user.id, company!.id);
    const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "html", url: "https://pager.example/listing?page=0", status: "active" }).returning();
    // An initial company-follow scan has its own task, not a shared daily scan run.
    const taskId = await enqueueTask(db, "scan_company", { companyId: company!.id, trigger: "manual" });
    if (!taskId) throw new Error("Scan task not queued");
    const expiresAt = new Date(Date.now() + 86_400_000);
    const [session] = await db.insert(schema.sessions).values({ userId: user.id, expiresAt }).returning();
    const expiry = Math.floor(expiresAt.getTime() / 1000);
    const secret = randomBytes(32).toString("hex");
    const signature = createHmac("sha256", secret).update(`${session!.id}.${expiry}`).digest("base64url");
    writeFileSync("/tmp/ava-partial-browser-secret", secret, { mode: 0o600 });
    writeFileSync("/tmp/ava-partial-browser-cookie", `v2.${session!.id}.${expiry}.${signature}`, { mode: 0o600 });
    state = { userId: user.id, companyId: company!.id, sourceId: source!.id, taskId };
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } else {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  }
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, state.taskId));
  if (!task) throw new Error("Fixture task missing");
  const result = await handleScanCompany(task, fakeDeps);
  if (mode === "partial" && !(result instanceof TaskDeferred)) throw new Error("Expected the first claim to defer");
  if (mode === "terminal" && result instanceof TaskDeferred) throw new Error("Expected terminal claim to finish");
  if (mode === "partial" && result instanceof TaskDeferred) await db.update(schema.tasks)
    .set({ status: "queued", runAfter: result.until, result: result.result as object }).where(eq(schema.tasks.id, state.taskId));
  if (mode === "terminal") await db.update(schema.tasks).set({ status: "done", finishedAt: new Date(), result: result as object }).where(eq(schema.tasks.id, state.taskId));
  const [generation] = await db.select().from(schema.htmlScanGenerations).where(eq(schema.htmlScanGenerations.taskId, state.taskId));
  const [source] = await db.select().from(schema.careerSources).where(eq(schema.careerSources.id, state.sourceId));
  const jobs = await db.select({ id: schema.jobs.id, title: schema.jobs.title }).from(schema.jobs).where(eq(schema.jobs.companyId, state.companyId));
  const views = await db.select({ jobId: schema.userJobs.jobId, inTable: schema.userJobs.inTable }).from(schema.userJobs).where(eq(schema.userJobs.userId, state.userId));
  const scans = await db.select({ status: schema.scans.status, taskId: schema.scans.taskId }).from(schema.scans).where(eq(schema.scans.sourceId, state.sourceId));
  const report = { fixture: "synthetic mocked 25-page HTML listing", mode, at: new Date().toISOString(), state, fetched,
    result: result instanceof TaskDeferred ? { deferredUntil: result.until.toISOString(), details: result.result } : result,
    generation: generation ? { publishedPageCount: generation.publishedPageCount, publishedNewCount: generation.publishedNewCount, seedFirstScan: generation.seedFirstScan } : null,
    sourceLastOkScanAt: source?.lastOkScanAt ?? null, jobs: jobs.length, matchingViews: views.filter(view => view.inTable).length, scans };
  writeFileSync(join(base, `fixture-${mode}.json`), JSON.stringify(report, null, 2) + "\n");
  if (mode === "partial" && (report.generation?.publishedPageCount !== 20 || report.matchingViews < 1 || report.scans.length !== 0 || report.sourceLastOkScanAt)) throw new Error("Partial publication invariant failed");
  if (mode === "terminal" && (report.generation !== null || report.scans.length !== 1 || report.scans[0]?.status !== "ok" || !report.sourceLastOkScanAt)) throw new Error("Terminal scan invariant failed");
  console.log(JSON.stringify({ mode, fetched: fetched.length, jobs: jobs.length, matchingViews: report.matchingViews, generation: report.generation, scans: report.scans }, null, 2));
} finally {
  await deps.close();
}
