import { sql } from "drizzle-orm";
import type { Db } from "./client";

/**
 * The numbers behind `/healthz` and the Health panel, in one round trip.
 *
 * They used to be five concurrent statements, which meant five pooled connections every time
 * something polled health — the one thing a struggling worker is polled hardest for. Each part is
 * an independent aggregate, so they travel together as scalar subqueries against one connection.
 */
export async function workloadMetrics(db: Db) {
  const result = await db.execute<{
    ready: number; running: number; oldest_seconds: number; p95_seconds: number;
    overdue_companies: number; overdue_discovery: number; reserved_usd: number;
  }>(sql`
    with queue as (
      select
        count(*) filter (where status='queued' and run_after <= now())::int as ready,
        count(*) filter (where status='running')::int as running,
        coalesce(max(extract(epoch from now()-run_after)) filter (where status='queued' and run_after <= now()),0)::float as oldest_seconds,
        coalesce(percentile_cont(0.95) within group (order by extract(epoch from finished_at-started_at))
          filter (where status='done' and finished_at > now()-interval '1 day'),0)::float as p95_seconds
      from tasks
    )
    select queue.*,
      (select count(*)::int from companies c where c.status='active' and c.added_at < now()-interval '1 day'
        and not exists (select 1 from career_sources cs where cs.company_id=c.id and cs.last_ok_scan_at > now()-interval '1 day')) as overdue_companies,
      (select count(*)::int from discovery_sources where enabled=true and next_run_at < now()-interval '1 day') as overdue_discovery,
      (select coalesce(sum(amount),0)::float from ai_reservations where expires_at > now()) as reserved_usd
    from queue`);
  const row = result.rows[0]!;
  return {
    ready: row.ready,
    running: row.running,
    oldest_seconds: row.oldest_seconds,
    p95_seconds: row.p95_seconds,
    overdueCompanies: row.overdue_companies ?? 0,
    overdueDiscovery: row.overdue_discovery ?? 0,
    reservedUsd: row.reserved_usd ?? 0,
  };
}
