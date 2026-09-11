import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@christopher/db";

const discoverySites = ["A7", "A8", "A10"];
/** Reservations share one short lock across processes; no lock survives a model request. */
export async function reserveAi(db: Db, callSite: string, amount: number, limits: { monthly: number; daily: number; discovery: number }, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const day = now.toISOString().slice(0, 10);
  const monthStart = new Date(`${month}-01T00:00:00Z`);
  const dayStart = new Date(`${day}T00:00:00Z`);
  const id = randomUUID();
  const isDiscovery = discoverySites.includes(callSite);
  const keys = [`month:${month}`, `day:${day}`, `discovery:${day}`];
  const acquired = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:ai-budget'))`);
    const expired = await tx.execute<{ call_site: string; amount: number; created_at: Date }>(sql`delete from ai_reservations where expires_at <= now() returning call_site, amount, created_at`);
    for (const row of expired.rows) {
      const at = new Date(row.created_at).toISOString();
      const abandonedKeys = [`month:${at.slice(0,7)}`, `day:${at.slice(0,10)}`, ...(discoverySites.includes(row.call_site) ? [`discovery:${at.slice(0,10)}`] : [])];
      for (const key of abandonedKeys) await tx.execute(sql`update ai_spend_periods set amount=amount+${row.amount} where key=${key}`);
    }
    // Seed aggregates once from existing usage so upgrades cannot reset the budget.
    const existing = await tx.execute<{ key: string }>(sql`select key from ai_spend_periods where key in (${sql.join(keys.map(k => sql`${k}`), sql`,`)})`);
    const present = new Set(existing.rows.map(r => r.key));
    for (const [index, key] of keys.entries()) if (!present.has(key)) await tx.execute(sql`insert into ai_spend_periods (key, amount)
      select ${key}, coalesce(sum(cost_usd),0) from ai_calls where at >= ${index === 0 ? monthStart : dayStart}
      and (${index !== 2} or call_site in ('A7','A8','A10')) on conflict (key) do nothing`);
    const totals = await tx.execute<{ key: string; amount: number }>(sql`select key, amount from ai_spend_periods where key in (${sql.join(keys.map(k => sql`${k}`), sql`,`)})`);
    const held = await tx.execute<{ total: number; discovery: number }>(sql`select coalesce(sum(amount),0) as total,
      coalesce(sum(amount) filter (where call_site in ('A7','A8','A10')),0) as discovery from ai_reservations where expires_at > now()`);
    const spent = new Map(totals.rows.map(r => [r.key, Number(r.amount)]));
    const pending = Number(held.rows[0]?.total ?? 0);
    if ((spent.get(keys[0]!) ?? 0) + pending + amount > limits.monthly ||
        (spent.get(keys[1]!) ?? 0) + pending + amount > limits.daily ||
        isDiscovery && (spent.get(keys[2]!) ?? 0) + Number(held.rows[0]?.discovery ?? 0) + amount > limits.discovery) return false;
    await tx.execute(sql`insert into ai_reservations (id, call_site, amount, expires_at) values (${id}, ${callSite}, ${amount}, now() + interval '15 minutes')`);
    return true;
  });
  if (!acquired) return null;
  return async (actual: number | null) => {
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('christopher:ai-budget'))`);
      const reservation = await tx.execute(sql`delete from ai_reservations where id = ${id} returning id`);
      if (!reservation.rows.length) return;
      // Unknown usage (timeout/network error) retains the estimate rather than freeing spent capacity.
      for (const key of keys.slice(0, isDiscovery ? 3 : 2)) await tx.execute(sql`update ai_spend_periods set amount = amount + ${actual ?? amount} where key = ${key}`);
    });
  };
}
