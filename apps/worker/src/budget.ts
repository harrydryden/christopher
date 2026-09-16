import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
export async function reserveAi(db: Db, callSite: string, amount: number, limits: { monthly: number; daily: number; discovery: number }, now = new Date()) {
  const monthStart = new Date(`${now.toISOString().slice(0, 7)}-01T00:00:00Z`);
  const dayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const id = randomUUID();
  const isDiscovery = discoverySites.includes(callSite);
  const acquired = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:ai-budget'))`);
    await tx.execute(sql`delete from ai_reservations where expires_at <= now()`);
    const spent = await tx.execute<{ month: number; day: number; discovery: number }>(sql`select
      coalesce(sum(cost_usd), 0) as month,
      coalesce(sum(cost_usd) filter (where at >= ${dayStart}), 0) as day,
      coalesce(sum(cost_usd) filter (where at >= ${dayStart} and call_site in ('A7','A8','A10')), 0) as discovery
      from ai_calls where at >= ${monthStart}`);
    const held = await tx.execute<{ total: number; discovery: number }>(sql`select coalesce(sum(amount), 0) as total,
      coalesce(sum(amount) filter (where call_site in ('A7','A8','A10')), 0) as discovery from ai_reservations`);
    const month = Number(spent.rows[0]?.month ?? 0);
    const day = Number(spent.rows[0]?.day ?? 0);
    const pending = Number(held.rows[0]?.total ?? 0);
    if (month + pending + amount > limits.monthly ||
        day + pending + amount > limits.daily ||
        isDiscovery && Number(spent.rows[0]?.discovery ?? 0) + Number(held.rows[0]?.discovery ?? 0) + amount > limits.discovery) return false;
    await tx.execute(sql`insert into ai_reservations (id, call_site, amount, expires_at) values (${id}, ${callSite}, ${amount}, now() + interval '15 minutes')`);
    return true;
  });
  if (!acquired) return null;
  /** Release the hold. The call's real cost is already in `ai_calls`, so nothing is charged here. */
  return async () => {
    await db.execute(sql`delete from ai_reservations where id = ${id}`);
  };
}
