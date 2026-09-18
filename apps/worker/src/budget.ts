import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@christopher/db";

const discoverySites = ["A7", "A8", "A10"];

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
 * Reservations share one short lock across processes; no lock survives a model request.
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
  /** Optional operator caps on the whole deployment for today, unlimited unless the environment sets them. */
  daily: number;
  discovery: number;
  /**
   * The worker taking the hold. A shutting-down worker releases its own holds by this id, so a
   * killed build does not leave its estimate held against the account until the reservation
   * expires on its own.
   */
  workerId?: string;
};

/** Which limit refused a hold, and the figures it was measured against. */
export interface AiBudgetRefusal {
  limit: "account" | "day" | "discovery";
  limitUsd: number;
  /** Recorded spend within the limit's window. */
  spent: number;
  /** Held by calls in flight. */
  held: number;
}

/** Hold capacity for one call, or say exactly which limit refused it, so the refusal can be explained. */
export async function tryReserveAi(db: Db, callSite: string, amount: number, limits: AiBudgetLimits, now = new Date(), ttlMinutes = 15): Promise<{ release: () => Promise<void>; renew: () => Promise<void> } | { refused: AiBudgetRefusal }> {
  const account = limits.account;
  const dayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const id = randomUUID();
  const isDiscovery = discoverySites.includes(callSite);
  const refusal = await db.transaction(async (tx): Promise<AiBudgetRefusal | null> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:ai-budget'))`);
    await tx.execute(sql`delete from ai_reservations where expires_at <= now()`);
    if (account) {
      // This account's own month: what it has spent, plus what its calls in flight are holding.
      // Its holds alone, so one account's build can never be refused by another's.
      const own = await tx.execute<{ spent: number; held: number }>(sql`select
        (select coalesce(sum(cost_usd), 0) from ai_calls where user_id = ${account.userId} and at >= ${account.since}) as spent,
        (select coalesce(sum(amount), 0) from ai_reservations where user_id = ${account.userId}) as held`);
      const spent = Number(own.rows[0]?.spent ?? 0);
      const held = Number(own.rows[0]?.held ?? 0);
      if (spent + held + amount > account.budgetUsd) return { limit: "account", limitUsd: account.budgetUsd, spent, held };
    }
    // The operator's caps, which keep their own day whatever an account's window is, and count
    // every account's calls together with the work that belongs to none.
    const spent = await tx.execute<{ day: number; discovery: number }>(sql`select
      coalesce(sum(cost_usd), 0) as day,
      coalesce(sum(cost_usd) filter (where call_site in ('A7','A8','A10')), 0) as discovery
      from ai_calls where at >= ${dayStart}`);
    const held = await tx.execute<{ total: number; discovery: number }>(sql`select coalesce(sum(amount), 0) as total,
      coalesce(sum(amount) filter (where call_site in ('A7','A8','A10')), 0) as discovery from ai_reservations`);
    const day = Number(spent.rows[0]?.day ?? 0);
    const pending = Number(held.rows[0]?.total ?? 0);
    const discovery = Number(spent.rows[0]?.discovery ?? 0);
    const discoveryHeld = Number(held.rows[0]?.discovery ?? 0);
    if (day + pending + amount > limits.daily) return { limit: "day", limitUsd: limits.daily, spent: day, held: pending };
    if (isDiscovery && discovery + discoveryHeld + amount > limits.discovery) return { limit: "discovery", limitUsd: limits.discovery, spent: discovery, held: discoveryHeld };
    await tx.execute(sql`insert into ai_reservations (id, user_id, call_site, amount, expires_at, worker_id)
      values (${id}, ${account?.userId ?? null}, ${callSite}, ${amount}, now() + make_interval(mins => ${ttlMinutes}::int), ${limits.workerId ?? null})`);
    return null;
  });
  if (refusal) return { refused: refusal };
  return {
    /** Release the hold. The call's real cost is already in `ai_calls`, so nothing is charged here. */
    release: async () => { await db.execute(sql`delete from ai_reservations where id = ${id}`); },
    /** Keep a hold alive through a long build; one whose process died still expires on its own. */
    renew: async () => { await db.execute(sql`update ai_reservations set expires_at = now() + make_interval(mins => ${ttlMinutes}::int) where id = ${id}`); },
  };
}
