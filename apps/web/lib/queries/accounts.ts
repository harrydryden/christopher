/**
 * What each account has spent on AI this month, against its own budget: the one budget there is.
 *
 * The limit and the reset marker are two `user_settings` keys, read for every listed account in one
 * query and resolved through the same defaults and clamps as any other setting. Spend itself is a
 * sum over `ai_calls` per account, which is one small indexed query each; Admin › Accounts lists a
 * handful of accounts, so they are read together rather than joined into the listing.
 */
import { and, inArray } from "drizzle-orm";
import { aiBudgetWindowStart, DEFAULT_ACCOUNT_AI_BUDGET_USD, resolveUserSettings } from "@ava/core";
import { accountAiSpend } from "@ava/db";
import { userSettings } from "@ava/db/schema";
import { db } from "@/lib/db";

/** The two `user_settings` keys that decide one account's budget window. */
const BUDGET_KEYS = ["aiBudgetUsd", "aiBudgetResetAt"];

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
  const budgets = new Map<string, AccountAiBudget>();
  if (userIds.length === 0) return budgets;
  const rows = await db()
    .select({ userId: userSettings.userId, key: userSettings.key, value: userSettings.value })
    .from(userSettings)
    .where(and(inArray(userSettings.userId, userIds), inArray(userSettings.key, BUDGET_KEYS)));
  const monthStart = aiBudgetWindowStart(now, null);
  // An account counts from its own marker, or from the month when it has none: the same window the
  // worker admits its work in, and nobody else's reset can move it.
  await Promise.all(
    userIds.map(async (userId) => {
      const settings = resolveUserSettings(rows.filter((row) => row.userId === userId));
      const since = aiBudgetWindowStart(now, settings.aiBudgetResetAt);
      budgets.set(userId, {
        limitUsd: settings.aiBudgetUsd,
        since,
        countingSince: since.getTime() > monthStart.getTime() ? since : null,
        spentUsd: await accountAiSpend(db(), userId, since),
      });
    }),
  );
  return budgets;
}

/** One account's own budget, for its Settings page. */
export async function accountAiBudget(userId: string, now: Date = new Date()): Promise<AccountAiBudget> {
  return (await accountAiBudgets([userId], now)).get(userId) ?? defaultAccountAiBudget(now);
}
