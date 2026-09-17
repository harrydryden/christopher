import { accountAiSpend, createDb, schema, sharedAiSpend, type Db } from "@christopher/db";
import { aiBudgetWindowStart, aiFeatureLabel, ats, discovery, modelForCallSite, type AppSettings, type DiscoveryContext, type FetchContext, type SystemSettings } from "@christopher/core";
import { createAiEngine, type AiClientLike, type AiEngine, type AiUsageRecord, type Ref } from "@christopher/ai";
import { sql } from "drizzle-orm";
import { BrowserRenderer } from "./browser";
import type { WorkerEnv } from "./env";
import { PoliteFetcher, userAgentFor } from "./fetcher";
import { tryReserveAi } from "./budget";
import { log } from "./log";
import { loadSettings, loadUserSettings } from "./settings";

export interface WorkerDeps {
  db: Db;
  /** Called inside write transactions to fence reclaimed work. */
  assertOwnership?(db: Db): Promise<void>;
  pool: { end(): Promise<void> };
  env: WorkerEnv;
  fetcher: PoliteFetcher;
  browser: BrowserRenderer | null;
  ai: AiEngine;
  /** A stand-in for the Anthropic client, so a test can drive the real CV engine with scripted answers. */
  aiClient?: AiClientLike;
  /** System settings from the database; cached for a few seconds to avoid hammering the table. */
  settings(): Promise<SystemSettings>;
  /** One account's settings merged onto the system ones, cached the same way. */
  userSettings(userId: string): Promise<AppSettings>;
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
  const now = overrides.now ?? (() => new Date());
  const settingsTtlMs = overrides.settingsTtlMs ?? 5000;
  let cached: { at: number; value: SystemSettings } | null = null;
  const userCache = new Map<string, { at: number; value: AppSettings }>();
  const settings = async () => {
    if (cached && Date.now() - cached.at < settingsTtlMs) return cached.value;
    const value = await loadSettings(db);
    cached = { at: Date.now(), value };
    return value;
  };
  const userSettings = async (userId: string) => {
    const hit = userCache.get(userId);
    if (hit && Date.now() - hit.at < settingsTtlMs) return hit.value;
    const value = await loadUserSettings(db, userId);
    if (userCache.size > 1000) userCache.clear();
    userCache.set(userId, { at: Date.now(), value });
    return value;
  };
  const fetcher = new PoliteFetcher({
    deferHost: async (host, delayMs) => { await db.execute(sql`insert into host_pacing (host, next_at) values (${host}, now() + ${delayMs} * interval '1 millisecond')
      on conflict (host) do update set next_at=greatest(host_pacing.next_at, excluded.next_at)`); },
    reserveHost: async (host, delayMs) => {
      const result = await db.execute<{ wait: number }>(sql`insert into host_pacing (host, next_at) values (${host}, now() + ${delayMs} * interval '1 millisecond')
        on conflict (host) do update set next_at = greatest(host_pacing.next_at, now()) + ${delayMs} * interval '1 millisecond'
        returning greatest(0, extract(epoch from (next_at - now())) * 1000 - ${delayMs})::float as wait`);
      return Number(result.rows[0]?.wait ?? 0);
    },
    userAgent: userAgentFor(env.contactEmail),
    hostMap: env.hostMap,
    respectRobots: async () => (await settings()).respectRobotsTxt,
    perHostDelayMs: Object.keys(env.hostMap).length ? 50 : 2000,
  });
  const browser = env.disableBrowser
    ? null
    : new BrowserRenderer({ beforeRequest: host => fetcher.waitForHost(host), concurrency: env.browserConcurrency, userAgent: userAgentFor(env.contactEmail), executablePath: env.chromiumExecutablePath, hostMap: env.hostMap });

  const onUsage = async (r: AiUsageRecord) => {
    try {
      await db.insert(schema.aiCalls).values({
        userId: r.userId ?? null,
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
  /**
   * Hold capacity for one call against both budgets that can refuse it.
   *
   * The account's own budget comes first, so an account that has spent its month cannot eat into
   * what is left of the shared ceiling; the shared hold then covers everything, including the work
   * that carries no account at all (extraction, discovery). Either refusal throws rather than
   * returning null, so the error the task records names the budget that stopped it instead of
   * leaving an administrator to guess which figure to raise.
   */
  const reserve = async (callSite: string, estimate: number, ref: Ref) => {
    const system = await settings();
    const at = now();
    if (ref.userId) {
      const account = await userSettings(ref.userId);
      const spent = await accountAiSpend(db, ref.userId, aiBudgetWindowStart(at, account.aiBudgetResetAt));
      if (spent + estimate > account.aiBudgetUsd)
        throw new Error(`AI budget reserved or exhausted; retry later: ${aiFeatureLabel(callSite)} needs about $${estimate.toFixed(2)} and this account's monthly budget of $${account.aiBudgetUsd} has $${Math.max(0, account.aiBudgetUsd - spent).toFixed(2)} left. An administrator can raise it in Admin › Accounts.`);
    }
    const hold = await tryReserveAi(db, callSite, estimate, {
      monthly: system.monthlyAiBudgetUsd,
      daily: env.dailyAiBudgetUsd ?? 1000000,
      discovery: env.discoveryAiBudgetUsd ?? 1000000,
      resetAt: system.aiBudgetResetAt,
    }, at);
    if ("refused" in hold) {
      const { limit, limitUsd, spent, held } = hold.refused;
      const name = limit === "month" ? "shared monthly" : limit === "day" ? "shared daily" : "shared discovery";
      throw new Error(`AI budget reserved or exhausted; retry later: ${aiFeatureLabel(callSite)} needs about $${estimate.toFixed(2)} and the ${name} budget of $${limitUsd} has $${Math.max(0, limitUsd - spent - held).toFixed(2)} left.`);
    }
    return hold.release;
  };
  const ai = createAiEngine({
    reserve,
    apiKey: env.anthropicApiKey,
    getModel: (callSite) => modelForCallSite(cached?.value ?? { defaultModel: "claude-sonnet-5", modelOverrides: {} }, callSite),
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
    userSettings,
    invalidateSettings() {
      cached = null;
      userCache.clear();
    },
    now,
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

/**
 * Shared AI spend for the current budget window, in USD: every call, whoever it was for.
 *
 * "This month" starts at the shared reset marker when there is one later than the month itself, so
 * zeroing the counter at a deploy (or from Admin) is a window move and leaves the call log intact.
 */
export async function aiSpendThisMonth(db: Db, now: Date, resetAt?: string | null): Promise<number> {
  return sharedAiSpend(db, aiBudgetWindowStart(now, resetAt));
}

/** Why no model call may be made now. Worded to be returned as a task's `skipped` reason. */
export type AiBudgetStop = "ai unavailable" | "shared ai budget exceeded" | "account ai budget exceeded";

/**
 * What stops a model call now, or null when there is room for one.
 *
 * `userId` is the account the work is for; shared work such as extraction and discovery passes
 * none and is measured against the ceiling alone. Handlers ask before they begin, so that an
 * account which has spent its month skips its queued work and the task finishes done. Leaving it
 * to the hold instead would refuse the call mid-handler, fail the task and retry it: one exhausted
 * account's near-miss scoring would fill Health's failed-task list with work nothing can complete.
 */
export async function aiBudgetStop(deps: WorkerDeps, userId?: string): Promise<AiBudgetStop | null> {
  if (!deps.ai.enabled) return "ai unavailable";
  const settings = await deps.settings();
  const now = deps.now();
  if ((await aiSpendThisMonth(deps.db, now, settings.aiBudgetResetAt)) >= settings.monthlyAiBudgetUsd) return "shared ai budget exceeded";
  if (!userId) return null;
  const account = await deps.userSettings(userId);
  const spent = await accountAiSpend(deps.db, userId, aiBudgetWindowStart(now, account.aiBudgetResetAt));
  return spent >= account.aiBudgetUsd ? "account ai budget exceeded" : null;
}

/** Whether a model call must not be made: the shared ceiling, and `userId`'s own budget when given. */
export async function aiBudgetExceeded(deps: WorkerDeps, userId?: string): Promise<boolean> {
  return (await aiBudgetStop(deps, userId)) !== null;
}

export { discovery as _discoveryNs };
