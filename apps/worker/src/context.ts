import { createDb, schema, type Db } from "@christopher/db";
import { ats, discovery, modelForCallSite, type AppSettings, type DiscoveryContext, type FetchContext } from "@christopher/core";
import { createAiEngine, type AiEngine, type AiUsageRecord } from "@christopher/ai";
import { sql } from "drizzle-orm";
import { BrowserRenderer } from "./browser";
import type { WorkerEnv } from "./env";
import { PoliteFetcher, userAgentFor } from "./fetcher";
import { log } from "./log";
import { loadSettings } from "./settings";

export interface WorkerDeps {
  db: Db;
  pool: { end(): Promise<void> };
  env: WorkerEnv;
  fetcher: PoliteFetcher;
  browser: BrowserRenderer | null;
  ai: AiEngine;
  /** Fresh settings from the database; cached for a few seconds to avoid hammering the table. */
  settings(): Promise<AppSettings>;
  /** Drop the cached settings so the next read hits the database. */
  invalidateSettings(): void;
  now(): Date;
  close(): Promise<void>;
}

export interface DepsOverrides {
  now?: () => Date;
  /** How long a settings read stays cached. Tests set 0 so a change takes effect at once. */
  settingsTtlMs?: number;
}

export async function createDeps(env: WorkerEnv, overrides: DepsOverrides = {}): Promise<WorkerDeps> {
  const { db, pool } = createDb(env.databaseUrl, { max: Math.max(4, env.concurrency + 2) });
  const settingsTtlMs = overrides.settingsTtlMs ?? 5000;
  let cached: { at: number; value: AppSettings } | null = null;
  const settings = async () => {
    if (cached && Date.now() - cached.at < settingsTtlMs) return cached.value;
    const value = await loadSettings(db);
    cached = { at: Date.now(), value };
    return value;
  };
  const fetcher = new PoliteFetcher({
    userAgent: userAgentFor(env.contactEmail),
    hostMap: env.hostMap,
    respectRobots: async () => (await settings()).respectRobotsTxt,
    perHostDelayMs: Object.keys(env.hostMap).length ? 50 : 2000,
  });
  const browser = env.disableBrowser
    ? null
    : new BrowserRenderer({ userAgent: userAgentFor(env.contactEmail), executablePath: env.chromiumExecutablePath, hostMap: env.hostMap });

  const onUsage = async (r: AiUsageRecord) => {
    try {
      await db.insert(schema.aiCalls).values({
        callSite: r.callSite,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        ok: r.ok,
        error: r.error ?? null,
        refType: r.refType ?? null,
        refId: r.refId ?? null,
      });
    } catch (err) {
      log.warn("failed to record ai usage", err);
    }
  };
  const ai = createAiEngine({
    apiKey: env.anthropicApiKey,
    getModel: (callSite) => modelForCallSite(cached?.value ?? ({ defaultModel: "claude-opus-5", modelOverrides: {} } as AppSettings), callSite),
    onUsage,
    logger: (msg, data) => log.debug(`ai ${msg}`, data),
  });

  return {
    db,
    pool,
    env,
    fetcher,
    browser,
    ai,
    settings,
    invalidateSettings() {
      cached = null;
    },
    now: overrides.now ?? (() => new Date()),
    async close() {
      await browser?.close();
      await pool.end();
    },
  };
}

export function makeFetchContext(deps: WorkerDeps): FetchContext {
  return {
    fetchText: (url, init) => deps.fetcher.fetchText(url, init),
    render: deps.browser ? (url, opts) => deps.browser!.render(url, opts) : undefined,
    log: (msg, data) => log.debug(msg, data),
    now: deps.now,
  };
}

export function makeDiscoveryContext(deps: WorkerDeps, opts: { maxFetches?: number; useAi?: boolean } = {}): DiscoveryContext {
  const fetchCtx = makeFetchContext(deps);
  const useAi = opts.useAi ?? true;
  return {
    ...fetchCtx,
    resolveSpec: (url) => ats.specFromAnyUrl(url),
    findSpecsInText: (text, baseUrl) => ats.findAtsSpecsInText(text, baseUrl),
    verifySpec: (spec) => ats.getAdapter(spec.type).verify(spec, fetchCtx),
    extractFromHtml: (html, pageUrl) => ats.extractPostingsFromHtml(html, pageUrl),
    ai:
      useAi && deps.ai.enabled
        ? {
            chooseCareersLinks: async (input) => (await deps.ai.chooseCareersLinks(input)) ?? [],
            classifyPage: async (input) => (await deps.ai.classifyPage(input)) ?? { kind: "other", confidence: 0 },
          }
        : undefined,
    maxFetches: opts.maxFetches ?? 40,
  };
}

/** Month-to-date AI spend in USD. */
export async function aiSpendThisMonth(db: Db, now: Date): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db.execute<{ total: string | null }>(sql`select coalesce(sum(cost_usd), 0)::text as total from ai_calls where at >= ${start}`);
  const first = rows.rows[0];
  return Number(first?.total ?? 0);
}

export async function aiBudgetExceeded(deps: WorkerDeps): Promise<boolean> {
  const settings = await deps.settings();
  if (!deps.ai.enabled) return true;
  const spend = await aiSpendThisMonth(deps.db, deps.now());
  return spend >= settings.monthlyAiBudgetUsd;
}

export { discovery as _discoveryNs };
