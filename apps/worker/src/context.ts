import { createDb, totalAiSpend, type Db } from "@ava/db";
import { aiBudgetRefusalMessage, aiBudgetWindowStart, aiFeatureLabel, ats, discovery, modelForCallSite, type AppSettings, type DiscoveryAiHooks, type DiscoveryContext, type FetchContext, type SystemSettings } from "@ava/core";
import { createAiEngine, type AiClientLike, type AiEngine, type AiUsageRecord, type Ref, type ReserveHint } from "@ava/ai";
import { sql } from "drizzle-orm";
import { BrowserRenderer } from "./browser";
import type { WorkerEnv } from "./env";
import { HttpTrafficLedger, PoliteFetcher, userAgentFor } from "./fetcher";
import { accountAiStanding, BudgetRefusedError, recordAiUsage, tryReserveAi } from "./budget";
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
  /**
   * The run's own signal, when these are the deps the queue handed one task (`RunDeps`). Fetch and
   * discovery contexts built from them stop with the run without being told again.
   */
  signal?: AbortSignal;
  /** A stand-in for the Anthropic client, so a test can drive the real CV engine with scripted answers. */
  aiClient?: AiClientLike;
  /** System settings from the database; cached for a few seconds to avoid hammering the table. */
  settings(): Promise<SystemSettings>;
  /** One account's settings merged onto the system ones, cached the same way. */
  userSettings(userId: string): Promise<AppSettings>;
  /**
   * Drop cached settings so the next read hits the database: one account's, with the shared
   * settings they are merged onto, or with no account, everyone's.
   */
  invalidateSettings(userId?: string): void;
  now(): Date;
  close(): Promise<void>;
}

/** Accounts whose merged settings stay cached at once; past it the least recently used goes. */
export const USER_SETTINGS_CACHE_MAX = 2_000;

export interface DepsOverrides {
  now?: () => Date;
  /** How long a settings read stays cached. Tests set 0 so a change takes effect at once. */
  settingsTtlMs?: number;
  /** A stand-in for the Anthropic client behind every engine, so a test can drive the shared one too. */
  aiClient?: AiClientLike;
}

export async function createDeps(env: WorkerEnv, overrides: DepsOverrides = {}): Promise<WorkerDeps> {
  // Two connections per slot plus a margin: a handler holds one for its transaction and asks for
  // more from inside it (a lease check, a nested read), and the scheduler, the heartbeat and
  // /healthz all need one at the same time. Sized under the pool the deployment's Postgres allows.
  // The environment reads that ceiling once and logs it at boot, so the pool opened is the one logged.
  // Slow queries go through the worker's own log, so each line carries the task it happened in.
  const { db, pool } = createDb(env.databaseUrl, { max: env.databasePoolMax, onSlowQuery: q => log.info("slow database query", q) });
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
  // Bumped by every invalidation, so a read that began before one never writes its stale result
  // back after it: gate re-evaluation right after a settings save must see the saved gate.
  let epoch = 0;
  const userSettings = async (userId: string) => {
    const hit = userCache.get(userId);
    if (hit && Date.now() - hit.at < settingsTtlMs) {
      // Least recently used last out: a hit moves to the back of the map's order.
      userCache.delete(userId);
      userCache.set(userId, hit);
      return hit.value;
    }
    const began = epoch;
    const value = await loadUserSettings(db, userId);
    if (began === epoch) {
      userCache.delete(userId);
      userCache.set(userId, { at: Date.now(), value });
      // The oldest go first. Clearing the whole cache at a thousand entries threw away every
      // account's settings once a deployment had more accounts than that.
      while (userCache.size > USER_SETTINGS_CACHE_MAX) userCache.delete(userCache.keys().next().value!);
    }
    return value;
  };
  const traffic = new HttpTrafficLedger(db);
  const fetcher = new PoliteFetcher({
    traffic,
    deferHost: async (host, delayMs) => { await db.execute(sql`insert into host_pacing (host, next_at) values (${host}, now() + ${delayMs} * interval '1 millisecond')
      on conflict (host) do update set next_at=greatest(host_pacing.next_at, excluded.next_at)`); },
    reserveHost: (host, delayMs, maxWaitMs) => reserveHostTurn(db, host, delayMs, maxWaitMs),
    userAgent: userAgentFor(env.contactEmail),
    hostMap: env.hostMap,
    respectRobots: async () => (await settings()).respectRobotsTxt,
    perHostDelayMs: Object.keys(env.hostMap).length ? 50 : 2000,
  });
  const browser = env.disableBrowser
    ? null
    : new BrowserRenderer({ traffic, beforeNavigate: host => fetcher.waitForHost(host), allowNavigate: url => fetcher.assertRobotsAllowed(url), concurrency: env.browserConcurrency, userAgent: userAgentFor(env.contactEmail), executablePath: env.chromiumExecutablePath, hostMap: env.hostMap,
      // A 429 or 503 the page's own navigation met defers the host for the fetcher as well.
      onRateLimited: (host, headers) => fetcher.backOff(host, headers) });

  // One writer for `ai_calls`, shared with every other engine: a budget read from a ledger one
  // call site writes differently from another is wrong in the direction that spends money. A write
  // that still fails after its retries throws, so the engine keeps the call's hold instead of
  // releasing it and letting the spend vanish from the budget.
  const onUsage = async (r: AiUsageRecord) => {
    await recordAiUsage(db, r.userId ?? null, r);
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
  const reserve = async (callSite: string, estimate: number, ref: Ref, hint?: ReserveHint) => {
    const at = now();
    const account = ref.userId ? await userSettings(ref.userId) : null;
    const hold = await tryReserveAi(db, callSite, estimate, {
      account: ref.userId && account
        ? { userId: ref.userId, budgetUsd: account.aiBudgetUsd, since: aiBudgetWindowStart(at, account.aiBudgetResetAt) }
        : undefined,
      // Unset, or at the environment's unlimited default, is no cap: tryReserveAi reads no day total.
      daily: env.dailyAiBudgetUsd,
      discovery: env.discoveryAiBudgetUsd,
      workerId: env.workerId,
      // Never shorter than the call may run, so a live call's hold is not swept from under it.
    }, at, holdMinutesFor(hint));
    if ("refused" in hold)
      // One sentence for a refused hold, wherever it was refused: the CV build and this composed
      // their own, and the two drifted into telling the person different things about one budget.
      // Typed, so a handler skips work its account has no room for instead of failing and retrying.
      throw new BudgetRefusedError(hold.refused, `AI budget reserved or exhausted; retry later: ${aiBudgetRefusalMessage(aiFeatureLabel(callSite), estimate, hold.refused)}`);
    return hold.release;
  };
  const ai = createAiEngine({
    reserve,
    apiKey: env.anthropicApiKey,
    ...(overrides.aiClient ? { client: overrides.aiClient } : {}),
    // Read through the settings loader, so a cold cache — at boot, or after an invalidation — reads
    // the administrator's choice rather than falling back to a model nobody chose.
    getModel: async (callSite) => modelForCallSite(await settings(), callSite),
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
    ...(overrides.aiClient ? { aiClient: overrides.aiClient } : {}),
    settings,
    userSettings,
    invalidateSettings(userId?: string) {
      epoch++;
      cached = null;
      if (userId) userCache.delete(userId);
      else userCache.clear();
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

/** How long a per-call hold lives: at least the default fifteen minutes, and never less than its call may run. */
export function holdMinutesFor(hint?: ReserveHint): number {
  return Math.max(15, Math.ceil((hint?.maxDurationMs ?? 0) / 60_000));
}

/**
 * Reserve `host`'s next turn in the shared pacing table and say how long until it comes.
 *
 * A turn further off than `maxWaitMs` is one the fetcher will not wait for (it throws
 * `HostBusyError` and the task is requeued), so it is not taken: the host's schedule stays as it
 * was, and only the wait is reported. Taking it anyway pushed every later request back by a turn
 * nobody used. The report is never within the wait unless a turn was actually reserved, so a
 * request can never go out without one.
 */
export async function reserveHostTurn(db: Db, host: string, delayMs: number, maxWaitMs: number): Promise<number> {
  const taken = await db.execute<{ wait: number }>(sql`insert into host_pacing (host, next_at) values (${host}, now() + ${delayMs} * interval '1 millisecond')
    on conflict (host) do update set next_at = greatest(host_pacing.next_at, now()) + ${delayMs} * interval '1 millisecond'
    where host_pacing.next_at <= now() + ${maxWaitMs} * interval '1 millisecond'
    returning greatest(0, extract(epoch from (next_at - now())) * 1000 - ${delayMs})::float as wait`);
  if (taken.rows.length) return Number(taken.rows[0]?.wait ?? 0);
  const busy = await db.execute<{ wait: number }>(sql`select greatest(0, extract(epoch from (next_at - now())) * 1000)::float as wait
    from host_pacing where host = ${host}`);
  // The turn moved inside the wait between the two statements: still report a wait past it, as none was taken.
  return Math.max(Number(busy.rows[0]?.wait ?? 0), maxWaitMs + 1);
}

/**
 * Settle with the run's own stop as soon as `signal` aborts, and start nothing once it has.
 *
 * The request itself is handed the signal too, and a fetcher or renderer that honours it cancels
 * the transfer; this is what makes the caller stop waiting either way, so a task given up on does
 * not keep its handler parked on a slow host until the fetch's own timeout.
 */
function untilStopped<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(signal.reason);
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([work(), stopped]).finally(() => signal.removeEventListener("abort", stop!));
}

/**
 * The fetches and renders a handler makes. With a signal — the one given, else the run's own from
 * `deps` — every one of them is refused once the run has been told to stop, and one in flight is
 * let go at once.
 */
export function makeFetchContext(deps: WorkerDeps, opts: { signal?: AbortSignal } = {}): FetchContext {
  const signal = opts.signal ?? deps.signal;
  // The fetcher and the renderer cancel the transfer themselves when told; a request that carries
  // its own signal keeps it, and every other one carries the run's.
  return {
    fetchText: (url, init) => untilStopped(signal, () => deps.fetcher.fetchText(url, { ...init, signal: init?.signal ?? signal })),
    fetchBytes: (url, init) => untilStopped(signal, () => deps.fetcher.fetchBytes(url, { ...init, signal: init?.signal ?? signal })),
    render: deps.browser ? (url, options) => untilStopped(signal, () => deps.browser!.render(url, { ...options, signal: options?.signal ?? signal })) : undefined,
    log: (msg, data) => log.debug(msg, data),
    now: deps.now,
  };
}

/**
 * What discovery needs for one run. `userId` is the account the run is for, when it is for one:
 * its model calls are then held and recorded against that account's budget, while a run for the
 * shared catalogue alone stays under the deployment's caps. `signal` stops its fetches, renders
 * and model calls together.
 */
export function makeDiscoveryContext(
  deps: WorkerDeps,
  opts: { maxFetches?: number; useAi?: boolean; userId?: string; signal?: AbortSignal } = {},
): DiscoveryContext {
  const signal = opts.signal ?? deps.signal;
  const fetchCtx = makeFetchContext(deps, { signal });
  const useAi = opts.useAi ?? true;
  // What every model call of the run carries; the ref discovery hands each hook (its `aiRef`,
  // naming the company and the account) is laid over it.
  const base = { ...(opts.userId ? { userId: opts.userId } : {}), ...(signal ? { signal } : {}) };
  const refFor = (ref?: Parameters<NonNullable<DiscoveryAiHooks["classifyPage"]>>[1]): Ref => ({ ...base, ...ref });
  return {
    ...fetchCtx,
    resolveSpec: (url) => ats.specFromAnyUrl(url),
    findSpecsInText: (text, baseUrl) => ats.findAtsSpecsInText(text, baseUrl),
    verifySpec: (spec) => ats.getAdapter(spec.type).verify(spec, fetchCtx),
    extractFromHtml: (html, pageUrl) => ats.extractPostingsFromHtml(html, pageUrl),
    ai:
      useAi && deps.ai.enabled
        ? {
            chooseCareersLinks: async (input, ref) => (await deps.ai.chooseCareersLinks(input, refFor(ref))) ?? [],
            classifyPage: async (input, ref) => (await deps.ai.classifyPage(input, refFor(ref))) ?? { kind: "other", confidence: 0 },
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
 * The arithmetic is the hold's: recorded spend plus what the account's calls in flight are holding.
 * Recorded spend alone passed an account whose remaining month a running CV build was holding, and
 * the hold then refused every call it made. A hold can still refuse a call too large for what is
 * left; handlers read that `BudgetRefusedError` as the same skip.
 */
export async function aiBudgetStop(deps: WorkerDeps, userId?: string): Promise<AiBudgetStop | null> {
  if (!deps.ai.enabled) return "ai unavailable";
  if (!userId) return null;
  const account = await deps.userSettings(userId);
  const { spent, held } = await accountAiStanding(deps.db, userId, aiBudgetWindowStart(deps.now(), account.aiBudgetResetAt));
  return spent + held >= account.aiBudgetUsd ? "account ai budget exceeded" : null;
}

/** Whether a model call must not be made: `userId`'s own budget, when the work belongs to an account. */
export async function aiBudgetExceeded(deps: WorkerDeps, userId?: string): Promise<boolean> {
  return (await aiBudgetStop(deps, userId)) !== null;
}

export { discovery as _discoveryNs };
