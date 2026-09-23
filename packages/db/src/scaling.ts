import { sql } from "drizzle-orm";
import { DEFAULT_ACCOUNT_AI_BUDGET_USD } from "@ava/core";
import type { Db } from "./client";
import { aiProviderFailureSql } from "./ai-budget";

/**
 * The numbers behind `/status` and the Health panel, in one round trip.
 *
 * They used to be five concurrent statements, which meant five pooled connections every time
 * something polled health — the one thing a struggling worker is polled hardest for. Each part is
 * an independent aggregate, so they travel together as scalar subqueries against one connection.
 */
export async function workloadMetrics(db: Db) {
  // One transaction, so a statement timeout can be set for this reading alone: the metrics are a
  // report, never worth holding a connection for more than a few seconds. Each aggregate is a
  // scalar subquery restricted by the status or time column its index leads with, so a table of
  // 20,000 tasks a day and a month of model calls is read through the indexes rather than scanned.
  const result = await db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '10s'`);
    return tx.execute<{
      ready: number; running: number; oldest_seconds: number; p95_seconds: number;
      overdue_companies: number; unscannable_companies: number; overdue_discovery: number; reserved_usd: number;
      crash_recoveries_1h: number; crash_recoveries_24h: number;
      provider_calls_1h: number; provider_successes_1h: number; provider_failures_1h: number;
      provider_outage_groups_1h: number; spend_24h_usd: number; spend_month_usd: number;
      accounts_at_or_over_budget: number;
    }>(sql`
    with month as (
      select (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') as start
    )
    select
      (select count(*)::int from tasks where status='queued' and run_after <= now()) as ready,
      (select count(*)::int from tasks where status='running') as running,
      (select coalesce(max(extract(epoch from now()-run_after)),0)::float from tasks
        where status='queued' and run_after <= now()) as oldest_seconds,
      (select coalesce(percentile_cont(0.95) within group (order by extract(epoch from finished_at-started_at)),0)::float
        from tasks where status='done' and finished_at > now()-interval '1 day') as p95_seconds,
      -- Overdue means a company the daily run would scan and has not scanned successfully in a day
      -- (26 hours, so the run's own spread is not counted as lateness). A company with no source
      -- the run can scan is not overdue; it is unscannable, reported on its own so the release gate
      -- can tell "the worker is behind" from "these companies need a person".
      (select count(*)::int from companies c where c.status='active' and c.added_at < now()-interval '26 hours'
        and exists (select 1 from career_sources cs where cs.company_id=c.id and cs.status in ('active','failing')
          and (cs.next_scan_at is null or cs.next_scan_at <= now()))
        and not exists (select 1 from career_sources cs where cs.company_id=c.id and cs.last_ok_scan_at > now()-interval '26 hours')) as overdue_companies,
      (select count(*)::int from companies c where c.status='active'
        and not exists (select 1 from career_sources cs where cs.company_id=c.id and cs.status in ('active','failing'))) as unscannable_companies,
      (select count(*)::int from discovery_sources where enabled=true and next_run_at < now()-interval '1 day') as overdue_discovery,
      -- amount is real, as cost_usd is: sum() over it accumulates in single precision, so a month
      -- of small holds drifts. Widen each value before adding, not the total afterwards.
      (select coalesce(sum(amount::float8),0) from ai_reservations where expires_at > now()) as reserved_usd,
      (select count(*)::int from worker_events where kind='crash_recovery' and at >= now()-interval '1 hour') as crash_recoveries_1h,
      (select count(*)::int from worker_events where kind='crash_recovery' and at >= now()-interval '24 hours') as crash_recoveries_24h,
      (select count(*)::int from ai_calls where at >= now()-interval '1 hour'
        and (ok or ${aiProviderFailureSql})) as provider_calls_1h,
      (select count(*)::int from ai_calls where at >= now()-interval '1 hour' and ok=true) as provider_successes_1h,
      (select count(*)::int from ai_calls where at >= now()-interval '1 hour'
        and ${aiProviderFailureSql}) as provider_failures_1h,
      (select count(*)::int from (
        select call_site, model
        from ai_calls
        where at >= now()-interval '1 hour'
          and (ok or ${aiProviderFailureSql})
        group by call_site, model
        having count(*) filter (where ok=false) >= 3 and count(*) filter (where ok=true) = 0
      ) provider_outages) as provider_outage_groups_1h,
      (select coalesce(sum(cost_usd::float8),0) from ai_calls where at >= now()-interval '24 hours') as spend_24h_usd,
      (select coalesce(sum(cost_usd::float8),0) from ai_calls where at >= (select start from month)) as spend_month_usd,
      (select count(*)::int from (
        select u.id
        from users u
        left join user_settings budget on budget.user_id=u.id and budget.key='aiBudgetUsd'
        left join user_settings reset on reset.user_id=u.id and reset.key='aiBudgetResetAt'
        -- Bounded by the month first, so the join reads this month's calls through (user_id, at)
        -- rather than every call the account has ever made.
        left join ai_calls calls on calls.user_id=u.id and calls.at >= (select start from month) and calls.at >= greatest(
          (select start from month),
          case when jsonb_typeof(reset.value)='string'
              and pg_input_is_valid(reset.value #>> '{}', 'timestamp with time zone')
            then (reset.value #>> '{}')::timestamptz
            else (select start from month) end)
        group by u.id, budget.value
        having coalesce(sum(calls.cost_usd::float8),0) > 0
          and coalesce(sum(calls.cost_usd::float8),0) >= coalesce(
          case when jsonb_typeof(budget.value)='number' then (budget.value #>> '{}')::float8 end,
          ${DEFAULT_ACCOUNT_AI_BUDGET_USD})
      ) exhausted_accounts) as accounts_at_or_over_budget`);
  });
  const row = result.rows[0]!;
  return {
    ready: row.ready,
    running: row.running,
    oldest_seconds: row.oldest_seconds,
    p95_seconds: row.p95_seconds,
    overdueCompanies: row.overdue_companies ?? 0,
    unscannableCompanies: row.unscannable_companies ?? 0,
    overdueDiscovery: row.overdue_discovery ?? 0,
    reservedUsd: row.reserved_usd ?? 0,
    crashRecoveries1h: row.crash_recoveries_1h ?? 0,
    crashRecoveries24h: row.crash_recoveries_24h ?? 0,
    providerCalls1h: row.provider_calls_1h ?? 0,
    providerSuccesses1h: row.provider_successes_1h ?? 0,
    providerFailures1h: row.provider_failures_1h ?? 0,
    providerOutageGroups1h: row.provider_outage_groups_1h ?? 0,
    spend24hUsd: Number(row.spend_24h_usd ?? 0),
    spendMonthUsd: Number(row.spend_month_usd ?? 0),
    accountsAtOrOverBudget: row.accounts_at_or_over_budget ?? 0,
  };
}
