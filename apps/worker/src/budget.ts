import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { aiBudgetWindowStart } from "@christopher/core";
import type { Db } from "@christopher/db";

const discoverySites = ["A7", "A8", "A10"];

/**
 * Hold capacity against the AI budget for one model call, then release it.
 *
 * `ai_calls` is the only record of what was spent: the engine writes a row for every call, with
 * its real cost, before releasing the hold, and a call that failed records nothing to spend. A
 * live reservation covers the gap between taking the capacity and that row landing, and expires on
 * its own if the process dies mid-call. Budgets are therefore always recorded spend plus what is
 * genuinely in flight, which is what Health shows too.
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
  /** The shared ceiling over everything, including work with no account behind it. */
  monthly: number;
  daily: number;
  discovery: number;
  /**
   * When the shared counter was last zeroed (ISO). The monthly window starts at the later of this
   * and the month; the daily and discovery allowances keep their own day, which a reset never moves.
   */
  resetAt?: string | null;
};

/** Which limit refused a hold, and the figures it was measured against. */
export interface AiBudgetRefusal {
  limit: "month" | "day" | "discovery";
  limitUsd: number;
  /** Recorded spend within the limit's window. */
  spent: number;
  /** Held by calls in flight. */
  held: number;
}

/** Hold capacity for one call, or say exactly which limit refused it, so the refusal can be explained. */
export async function tryReserveAi(db: Db, callSite: string, amount: number, limits: AiBudgetLimits, now = new Date(), ttlMinutes = 15): Promise<{ release: () => Promise<void>; renew: () => Promise<void> } | { refused: AiBudgetRefusal }> {
  const monthStart = aiBudgetWindowStart(now, limits.resetAt);
  const dayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  // One scan of the rows any of the three limits can see: a reset can put the month's window after
  // today's midnight, and the day and discovery allowances must still count the whole day.
  const earliest = monthStart < dayStart ? monthStart : dayStart;
  const id = randomUUID();
  const isDiscovery = discoverySites.includes(callSite);
  const refusal = await db.transaction(async (tx): Promise<AiBudgetRefusal | null> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:ai-budget'))`);
    await tx.execute(sql`delete from ai_reservations where expires_at <= now()`);
    const spent = await tx.execute<{ month: number; day: number; discovery: number }>(sql`select
      coalesce(sum(cost_usd) filter (where at >= ${monthStart}), 0) as month,
      coalesce(sum(cost_usd) filter (where at >= ${dayStart}), 0) as day,
      coalesce(sum(cost_usd) filter (where at >= ${dayStart} and call_site in ('A7','A8','A10')), 0) as discovery
      from ai_calls where at >= ${earliest}`);
    const held = await tx.execute<{ total: number; discovery: number }>(sql`select coalesce(sum(amount), 0) as total,
      coalesce(sum(amount) filter (where call_site in ('A7','A8','A10')), 0) as discovery from ai_reservations`);
    const month = Number(spent.rows[0]?.month ?? 0);
    const day = Number(spent.rows[0]?.day ?? 0);
    const pending = Number(held.rows[0]?.total ?? 0);
    const discovery = Number(spent.rows[0]?.discovery ?? 0);
    const discoveryHeld = Number(held.rows[0]?.discovery ?? 0);
    if (month + pending + amount > limits.monthly) return { limit: "month", limitUsd: limits.monthly, spent: month, held: pending };
    if (day + pending + amount > limits.daily) return { limit: "day", limitUsd: limits.daily, spent: day, held: pending };
    if (isDiscovery && discovery + discoveryHeld + amount > limits.discovery) return { limit: "discovery", limitUsd: limits.discovery, spent: discovery, held: discoveryHeld };
    await tx.execute(sql`insert into ai_reservations (id, call_site, amount, expires_at) values (${id}, ${callSite}, ${amount}, now() + make_interval(mins => ${ttlMinutes}::int))`);
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
