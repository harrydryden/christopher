import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@ava/db";
import type { AiBudgetRefusal } from "@ava/core";

export type { AiBudgetRefusal };

const discoverySites = ["A7", "A8", "A10"];

/**
 * A deployment cap at or above this is no cap. It is what the environment reads when an operator
 * sets neither DAILY_AI_BUDGET_USD nor DISCOVERY_AI_BUDGET_USD, so it is the ordinary case, and
 * summing every account's calls for the day to compare against a million dollars was work — under
 * a lock every model call in the deployment queued behind — that could never refuse anything.
 */
export const UNLIMITED_AI_BUDGET_USD = 1_000_000;

const capped = (limit: number | undefined): limit is number => limit !== undefined && limit < UNLIMITED_AI_BUDGET_USD;

/**
 * A hold refused mid-handler, with the limit that refused it.
 *
 * Typed so a handler can tell "this account has no room" — work to skip, finishing done — from a
 * fault worth a retry. Before, it was a plain Error thrown out of the engine, so every task an
 * account near its month's end queued failed three times and filled Health's failed list.
 */
export class BudgetRefusedError extends Error {
  constructor(readonly refusal: AiBudgetRefusal, message: string) {
    super(message);
    this.name = "BudgetRefusedError";
  }
}

/** True when `err` is a hold the account's own budget refused, which a handler skips rather than retries. */
export function isAccountBudgetRefusal(err: unknown): err is BudgetRefusedError {
  return err instanceof BudgetRefusedError && err.refusal.limit === "account";
}

/**
 * What an account has spent in its window, and what its calls in flight are holding: the two
 * figures every admission reads. One statement, so the pre-check a handler makes before it starts
 * and the hold the engine takes for each call do the same arithmetic on the same numbers.
 */
export async function accountAiStanding(db: Pick<Db, "execute">, userId: string, since: Date): Promise<{ spent: number; held: number }> {
  // cost_usd and amount are real: summed as they are, a month of small calls drifts in single
  // precision. Each value is widened before it is added, as the reports do.
  const rows = await db.execute<{ spent: number; held: number }>(sql`select
    (select coalesce(sum(cost_usd::float8), 0) from ai_calls where user_id = ${userId} and at >= ${since}) as spent,
    (select coalesce(sum(amount::float8), 0) from ai_reservations where user_id = ${userId} and expires_at > now()) as held`);
  return { spent: Number(rows.rows[0]?.spent ?? 0), held: Number(rows.rows[0]?.held ?? 0) };
}

/**
 * Hold capacity against an account's AI budget for one model call, then release it.
 *
 * `ai_calls` is the only record of what was spent: the engine writes a row for every call, with
 * its real cost, before releasing the hold, and a call that failed records nothing to spend. A
 * live reservation covers the gap between taking the capacity and that row landing, and expires on
 * its own if the process dies mid-call. A budget is therefore always that account's recorded spend
 * plus what its own calls have genuinely in flight.
 *
 * An earlier version kept a running total alongside `ai_calls` and charged an abandoned or failed
 * call its estimate. Nothing ever reconciled the two, so every timeout quietly ate budget that was
 * never spent, until the worker refused work while Health still reported the month almost unused.
 *
 * An account's reservations share one short lock per account across processes, and the
 * deployment's caps, when an operator has set one, one more; no lock survives a model request.
 */
export async function reserveAi(db: Db, callSite: string, amount: number, limits: AiBudgetLimits, now = new Date(), ttlMinutes = 15) {
  const hold = await tryReserveAi(db, callSite, amount, limits, now, ttlMinutes);
  return "release" in hold ? hold.release : null;
}

export type AiBudgetLimits = {
  /**
   * The account this call is for and its monthly budget, counted from `since` (the later of the
   * month and that account's reset marker). The one budget the product shows; work that belongs to
   * no account — extraction, discovery — passes none and is bounded by the caps below alone.
   */
  account?: { userId: string; budgetUsd: number; since: Date };
  /**
   * Optional operator caps on the whole deployment for today. Unset, or at or above
   * UNLIMITED_AI_BUDGET_USD, is no cap, and then no day total is read at all.
   */
  daily?: number;
  discovery?: number;
  /**
   * The worker taking the hold. A shutting-down worker releases its own holds by this id, so a
   * killed build does not leave its estimate held against the account until the reservation
   * expires on its own.
   */
  workerId?: string;
  /**
   * What the hold is for: a CV build's draft id. An account may have two builds running at once,
   * each holding its own share of the month; recorded here, giving up on one gives back that one's
   * hold instead of every hold the account has.
   */
  refId?: string;
};

/** A hold taken, with the figures it was measured against — read inside the lock that took it. */
export interface AiHold {
  /** Release the hold. The call's real cost is already in `ai_calls`, so nothing is charged here. */
  release: () => Promise<void>;
  /**
   * Keep a hold alive through a long build. False when the row is no longer there — it expired, or
   * something released it — which means the budget has forgotten this work and the caller must
   * stop rather than spend against capacity nothing is holding.
   */
  renew: () => Promise<boolean>;
  /** Recorded spend in the window this hold was judged against, before this hold. */
  spent: number;
  /** Held by calls in flight, before this hold. */
  held: number;
  /** The limit it was judged against: the account's month, or the deployment's day cap. */
  limitUsd: number;
}

/** Hold capacity for one call, or say exactly which limit refused it, so the refusal can be explained. */
export async function tryReserveAi(db: Db, callSite: string, amount: number, limits: AiBudgetLimits, now = new Date(), ttlMinutes = 15): Promise<AiHold | { refused: AiBudgetRefusal }> {
  const account = limits.account;
  const dayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const id = randomUUID();
  const isDiscovery = discoverySites.includes(callSite);
  const daily = capped(limits.daily) ? limits.daily : undefined;
  const discoveryCap = isDiscovery && capped(limits.discovery) ? limits.discovery : undefined;
  const deploymentCapped = daily !== undefined || discoveryCap !== undefined;
  type Measured = { spent: number; held: number; limitUsd: number };
  let measured: Measured | undefined;
  const outcome = await db.transaction(async (tx): Promise<{ refused: AiBudgetRefusal } | { measured: Measured }> => {
    // Always in this order, so two holds can never wait on each other: the deployment's lock, only
    // when a cap applies to this call, then the account's. An account's budget is judged under its
    // own lock whatever the caps are, so two processes configured differently still serialise it.
    if (deploymentCapped) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ava:ai-budget'))`);
      await tx.execute(sql`delete from ai_reservations where expires_at <= now()`);
    }
    if (account) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ava:ai-budget:${account.userId}`}))`);
      await tx.execute(sql`delete from ai_reservations where user_id = ${account.userId} and expires_at <= now()`);
      // This account's own month: what it has spent, plus what its calls in flight are holding.
      // Its holds alone, so one account's build can never be refused by another's.
      const { spent, held } = await accountAiStanding(tx, account.userId, account.since);
      if (spent + held + amount > account.budgetUsd) return { refused: { limit: "account", limitUsd: account.budgetUsd, spent, held } };
      measured = { spent, held, limitUsd: account.budgetUsd };
    }
    // The operator's caps, which keep their own day whatever an account's window is, and count
    // every account's calls together with the work that belongs to none. Read only when one is set.
    let day = 0;
    let pending = 0;
    if (deploymentCapped) {
      const totals = await tx.execute<{ day: number; discovery: number; held: number; discovery_held: number }>(sql`select
        (select coalesce(sum(cost_usd::float8), 0) from ai_calls where at >= ${dayStart}) as day,
        (select coalesce(sum(cost_usd::float8), 0) from ai_calls where at >= ${dayStart} and call_site in (${sql.join(discoverySites.map(site => sql`${site}`), sql`, `)})) as discovery,
        (select coalesce(sum(amount::float8), 0) from ai_reservations where expires_at > now()) as held,
        (select coalesce(sum(amount::float8), 0) from ai_reservations where expires_at > now() and call_site in (${sql.join(discoverySites.map(site => sql`${site}`), sql`, `)})) as discovery_held`);
      day = Number(totals.rows[0]?.day ?? 0);
      pending = Number(totals.rows[0]?.held ?? 0);
      const discovery = Number(totals.rows[0]?.discovery ?? 0);
      const discoveryHeld = Number(totals.rows[0]?.discovery_held ?? 0);
      if (daily !== undefined && day + pending + amount > daily) return { refused: { limit: "day", limitUsd: daily, spent: day, held: pending } };
      if (discoveryCap !== undefined && discovery + discoveryHeld + amount > discoveryCap)
        return { refused: { limit: "discovery", limitUsd: discoveryCap, spent: discovery, held: discoveryHeld } };
    }
    await tx.execute(sql`insert into ai_reservations (id, user_id, call_site, amount, expires_at, worker_id, ref_id)
      values (${id}, ${account?.userId ?? null}, ${callSite}, ${amount}, now() + make_interval(mins => ${ttlMinutes}::int), ${limits.workerId ?? null}, ${limits.refId ?? null})`);
    // Work with no account of its own is judged by the deployment's day cap, so that is what its
    // figures are. Either way they are the ones this hold was actually admitted against: a second
    // reading taken outside the lock could disagree with the decision it is meant to explain.
    return { measured: measured ?? { spent: day, held: pending, limitUsd: daily ?? UNLIMITED_AI_BUDGET_USD } };
  });
  if ("refused" in outcome) return outcome;
  return {
    ...outcome.measured,
    release: async () => { await db.execute(sql`delete from ai_reservations where id = ${id}`); },
    renew: async () => {
      // A hold whose process died still expires on its own; one released by something else is
      // already gone, and this is how its build finds out rather than spending on regardless.
      const rows = await db.execute(sql`update ai_reservations set expires_at = now() + make_interval(mins => ${ttlMinutes}::int) where id = ${id} returning id`);
      return rows.rows.length === 1;
    },
  };
}
