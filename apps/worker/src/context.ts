import { accountAiSpend, createDb, recordAiCall, totalAiSpend, type Db } from "@ava/db";
import { aiBudgetRefusalMessage, aiBudgetWindowStart, aiFeatureLabel, ats, discovery, modelForCallSite, type AppSettings, type DiscoveryContext, type FetchContext, type SystemSettings } from "@ava/core";
import { createAiEngine, type AiClientLike, type AiEngine, type AiUsageRecord, type Ref } from "@ava/ai";
import { sql } from "drizzle-orm";
import { BrowserRenderer } from "./browser";
import type { WorkerEnv } from "./env";
import { HttpTrafficLedger, PoliteFetcher, userAgentFor } from "./fetcher";
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
  /** Per-host traffic counters shared by the fetcher and the browser; flushed on a timer and at close. */
  traffic: HttpTrafficLedger;
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
  // Two connections per slot plus a margin: a handler holds one for its transaction and asks for
  // more from inside it (a lease check, a nested read), and the scheduler, the heartbeat and
  // /healthz all need one at the same time. Sized under the pool the deployment's Postgres allows.
  const { db, pool } = createDb(env.databaseUrl, { max: env.concurrency * 2 + 4 });
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
  const traffic = new HttpTrafficLedger(db);
  const fetcher = new PoliteFetcher({
    traffic,
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
    : new BrowserRenderer({ traffic, beforeNavigate: host => fetcher.waitForHost(host), allowNavigate: url => fetcher.assertRobotsAllowed(url), concurrency: env.browserConcurrency, userAgent: userAgentFor(env.contactEmail), executablePath: env.chromiumExecutablePath, hostMap: env.hostMap });

  // One writer for `ai_calls`, shared with every other engine: a budget read from a ledger one
  // call site writes differently from another is wrong in the direction that spends money.
  const onUsage = async (r: AiUsageRecord) => {
    try {
      await recordAiCall(db, r.userId ?? null, r);
    } catch (err) {
      log.warn("failed to record ai usage", err);
    }
  };
  /**
   * Hold capacity for one call against the budget that can refuse it.
   *
   * A call made for an account is held against that account's own monthly budget, the one budget
   * the product has; work that belongs to nobody (extraction, discovery) is held against the
   * operator's optional day and discovery caps alone, which bound the deployment either way. A
   * refusal throws rather than returning null, so the error the task records names the budget that
   * stopped it instead of leaving the reader to guess which figure to raise.
   */
  const reserve = async (callSite: string, estimate: number, ref: Ref) => {
    // The system settings are read here although no limit comes from them any more: `getModel`
    // below picks a model synchronously from this cache, so something on the path of every call
    // has to keep it warm, or an administrator's per-call-site overrides would never be seen.
    await settings();
    const at = now();
    const account = ref.userId ? await userSettings(ref.userId) : null;
    const hold = await tryReserveAi(db, callSite, estimate, {
      account: ref.userId && account
        ? { userId: ref.userId, budgetUsd: account.aiBudgetUsd, since: aiBudgetWindowStart(at, account.aiBudgetResetAt) }
        : undefined,
      daily: env.dailyAiBudgetUsd ?? 1000000,
      discovery: env.discoveryAiBudgetUsd ?? 1000000,
      workerId: env.workerId,
    }, at);
    if ("refused" in hold)
      // One sentence for a refused hold, wherever it was refused: the CV build and this composed
      // their own, and the two drifted into telling the person different things about one budget.
      throw new Error(`AI budget reserved or exhausted; retry later: ${aiBudgetRefusalMessage(aiFeatureLabel(callSite), estimate, hold.refused)}`);
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
    traffic,
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
      // The last counters have to reach the table while the pool is still open.
      await traffic.close();
      await pool.end();
    },
  };
}

export function makeFetchContext(deps: WorkerDeps): FetchContext {
  return {
    fetchText: (url, init) => deps.fetcher.fetchText(url, init),
    fetchBytes: (url, init) => deps.fetcher.fetchBytes(url, init),
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
 * Every account's AI spend this month, in USD: every call, whoever it was for, since the month
 * began. Budgets are per account, so this is a report of the deployment rather than a limit.
 */
export async function aiSpendThisMonth(db: Db, now: Date): Promise<number> {
  return totalAiSpend(db, aiBudgetWindowStart(now, null));
}

/** Why no model call may be made now. Worded to be returned as a task's `skipped` reason. */
export type AiBudgetStop = "ai unavailable" | "account ai budget exceeded";

/**
 * What stops a model call now, or null when there is room for one.
 *
 * `userId` is the account the work is for; work that belongs to no account, such as extraction and
 * discovery, passes none and only needs a model to be configured. Handlers ask before they begin,
 * so that an account which has spent its month skips its queued work and the task finishes done.
 * Leaving it to the hold instead would refuse the call mid-handler, fail the task and retry it: one
 * exhausted account's near-miss scoring would fill Health's failed-task list with work nothing can
 * complete.
 */
export async function aiBudgetStop(deps: WorkerDeps, userId?: string): Promise<AiBudgetStop | null> {
  if (!deps.ai.enabled) return "ai unavailable";
  if (!userId) return null;
  const account = await deps.userSettings(userId);
  const spent = await accountAiSpend(deps.db, userId, aiBudgetWindowStart(deps.now(), account.aiBudgetResetAt));
  return spent >= account.aiBudgetUsd ? "account ai budget exceeded" : null;
}

/** Whether a model call must not be made: `userId`'s own budget, when the work belongs to an account. */
export async function aiBudgetExceeded(deps: WorkerDeps, userId?: string): Promise<boolean> {
  return (await aiBudgetStop(deps, userId)) !== null;
}

export { discovery as _discoveryNs };
