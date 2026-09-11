import { sql } from "drizzle-orm";
import type { Db } from "./client";
export async function workloadMetrics(db: Db) {
  const [queue, scans, discovery, reservations] = await Promise.all([
    db.execute<{ ready: number; running: number; oldest_seconds: number; p95_seconds: number }>(sql`select
      count(*) filter (where status='queued' and run_after <= now())::int as ready,
      count(*) filter (where status='running')::int as running,
      coalesce(max(extract(epoch from now()-run_after)) filter (where status='queued' and run_after <= now()),0)::float as oldest_seconds,
      coalesce(percentile_cont(0.95) within group (order by extract(epoch from finished_at-started_at)) filter (where status='done' and finished_at > now()-interval '1 day'),0)::float as p95_seconds from tasks`),
    db.execute<{ overdue: number }>(sql`select count(*)::int as overdue from companies c where status='active' and c.added_at < now()-interval '1 day'
      and not exists (select 1 from career_sources cs where cs.company_id=c.id and cs.last_ok_scan_at > now()-interval '1 day')`),
    db.execute<{ overdue: number }>(sql`select count(*)::int as overdue from discovery_sources where enabled=true and next_run_at < now()-interval '1 day'`),
    db.execute<{ held: number }>(sql`select coalesce(sum(amount),0)::float as held from ai_reservations where expires_at > now()`),
  ]);
  return { ...queue.rows[0]!, overdueCompanies: scans.rows[0]?.overdue ?? 0, overdueDiscovery: discovery.rows[0]?.overdue ?? 0, reservedUsd: reservations.rows[0]?.held ?? 0 };
}
