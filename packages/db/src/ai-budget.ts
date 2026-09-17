/**
 * What has been spent on AI, read straight from `ai_calls`.
 *
 * `ai_calls` is the only record of spend: every call writes one row with its real cost, so a
 * budget is a sum over a window rather than a running total that something has to keep correct.
 * Resetting a counter moves the window (a reset marker in settings); nothing is deleted, so the
 * call log stays complete. Everything here is read-only; holding capacity for a call in flight is
 * the worker's `ai_reservations` and is deliberately not mixed in.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client";

/** One account's recorded spend since `since`, in USD. Shared work carries no account and is excluded. */
export async function accountAiSpend(db: Db, userId: string, since: Date): Promise<number> {
  const rows = await db.execute<{ total: number }>(
    sql`select coalesce(sum(cost_usd), 0)::float8 as total from ai_calls where user_id = ${userId} and at >= ${since}`,
  );
  return Number(rows.rows[0]?.total ?? 0);
}

/** Every call since `since`, whoever it was for, which is what the shared ceiling counts. */
export async function sharedAiSpend(db: Db, since: Date): Promise<number> {
  const rows = await db.execute<{ total: number }>(
    sql`select coalesce(sum(cost_usd), 0)::float8 as total from ai_calls where at >= ${since}`,
  );
  return Number(rows.rows[0]?.total ?? 0);
}

/** One line per account, call site and model: what was spent and what it bought. */
export interface AiAccountUsage {
  /** null for shared work with no account behind it, such as extraction and discovery. */
  userId: string | null;
  callSite: string;
  model: string;
  calls: number;
  /** Calls that returned nothing usable. They were still billed, so they still count. */
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Spend since `since` grouped by account, call site and model, dearest first. */
export async function aiUsageByAccount(db: Db, since: Date): Promise<AiAccountUsage[]> {
  const rows = await db.execute<AiAccountUsage & Record<string, unknown>>(sql`select
      user_id as "userId",
      call_site as "callSite",
      model,
      count(*)::int as calls,
      count(*) filter (where not ok)::int as failed,
      coalesce(sum(input_tokens), 0)::int as "inputTokens",
      coalesce(sum(output_tokens), 0)::int as "outputTokens",
      coalesce(sum(cache_read_tokens), 0)::int as "cacheReadTokens",
      coalesce(sum(cache_write_tokens), 0)::int as "cacheWriteTokens",
      coalesce(sum(cost_usd), 0)::float8 as "costUsd"
    from ai_calls where at >= ${since}
    group by user_id, call_site, model
    order by coalesce(sum(cost_usd), 0) desc, call_site asc, model asc`);
  return rows.rows.map((row) => ({
    userId: row.userId ?? null,
    callSite: row.callSite,
    model: row.model,
    calls: Number(row.calls),
    failed: Number(row.failed),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    costUsd: Number(row.costUsd),
  }));
}
