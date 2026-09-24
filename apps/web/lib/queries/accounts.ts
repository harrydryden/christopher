/**
 * What each account has spent on AI this month, against its own budget: the one budget there is.
 *
 * The limit and the reset marker are two `user_settings` keys, resolved through the same defaults
 * and clamps as any other setting. Every account asked about is read in one statement: its two
 * keys, the window they give and its spend in that window, one indexed sum per account inside the
 * statement rather than one round trip each, so Admin › Accounts costs the same query for fifty
 * accounts as for one.
 */
import { sql } from "drizzle-orm";
import { cache } from "react";
import { aiBudgetWindowStart, DEFAULT_ACCOUNT_AI_BUDGET_USD, resolveUserSettings } from "@ava/core";
import { accountAiSpend } from "@ava/db";
import { db } from "@/lib/db";

export interface AccountAiBudget {
  /** What this account may spend in a month. */
  limitUsd: number;
  /** Spend is counted from here: the later of the start of the UTC month and the reset marker. */
  since: Date;
  /** The reset marker when it is later than the month start, so a page can say "counting since …". */
  countingSince: Date | null;
  spentUsd: number;
}

/** What an account that has never been listed or charged would show: the default, counting from the month. */
export function defaultAccountAiBudget(now: Date = new Date()): AccountAiBudget {
  return { limitUsd: DEFAULT_ACCOUNT_AI_BUDGET_USD, since: aiBudgetWindowStart(now, null), countingSince: null, spentUsd: 0 };
}

/** Month-to-date spend and budget for each of `userIds`, keyed by account id. */
export async function accountAiBudgets(userIds: string[], now: Date = new Date()): Promise<Map<string, AccountAiBudget>> {
  return budgetsForMonth(userIds, aiBudgetWindowStart(now, null));
}

async function budgetsForMonth(userIds: string[], monthStart: Date): Promise<Map<string, AccountAiBudget>> {
  const budgets = new Map<string, AccountAiBudget>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return budgets;
  // Drizzle renders one placeholder per element, so the array is spelled out rather than passed whole.
  const idArray = sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
  const result = await db().execute(sql`
    select u.id as user_id, budget.value as budget, reset.value as reset, w.since, coalesce(spend.total, 0) as spent
    from unnest(${idArray}) as u(id)
    left join user_settings budget on budget.user_id = u.id and budget.key = 'aiBudgetUsd'
    left join user_settings reset on reset.user_id = u.id and reset.key = 'aiBudgetResetAt'
    cross join lateral (select greatest(${monthStart}::timestamptz,
      case when jsonb_typeof(reset.value) = 'string' and pg_input_is_valid(reset.value #>> '{}', 'timestamp with time zone')
        then date_trunc('milliseconds', (reset.value #>> '{}')::timestamptz) end) as since) w
    cross join lateral (select sum(c.cost_usd::float8) as total from ai_calls c where c.user_id = u.id and c.at >= w.since) spend`);
  for (const row of result.rows as Array<{ user_id: string; budget: unknown; reset: unknown; since: string | Date; spent: number | string }>) {
    const stored = [
      ...(row.budget === null ? [] : [{ key: "aiBudgetUsd", value: row.budget }]),
      ...(row.reset === null ? [] : [{ key: "aiBudgetResetAt", value: row.reset }]),
    ];
    const settings = resolveUserSettings(stored);
    // An account counts from its own marker, or from the month when it has none: the same window the
    // worker admits its work in, and nobody else's reset can move it. The rule is core's; the SQL
    // window only saves a round trip, so a marker the two would read differently is summed again.
    const since = aiBudgetWindowStart(monthStart, settings.aiBudgetResetAt);
    const spentUsd = since.getTime() === new Date(row.since).getTime() ? Number(row.spent) : await accountAiSpend(db(), row.user_id, since);
    budgets.set(row.user_id, {
      limitUsd: settings.aiBudgetUsd,
      since,
      countingSince: since.getTime() > monthStart.getTime() ? since : null,
      spentUsd,
    });
  }
  return budgets;
}

/**
 * One account's budget within one request. The sidebar's Health count, Health's own count and its
 * items all ask, so the answer is kept for the request, keyed by account and budget month rather
 * than by each caller's clock.
 */
const budgetForMonth = cache(async (userId: string, monthStart: number): Promise<AccountAiBudget> => {
  const month = new Date(monthStart);
  return (await budgetsForMonth([userId], month)).get(userId) ?? defaultAccountAiBudget(month);
});

/** One account's own budget, for its Settings page and its Health. */
export async function accountAiBudget(userId: string, now: Date = new Date()): Promise<AccountAiBudget> {
  return budgetForMonth(userId, aiBudgetWindowStart(now, null).getTime());
}
