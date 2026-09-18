-- Per-account monthly AI budgets, and one reset of every account's spend counter as this lands.
--
-- Each account has its own monthly budget, and it is the only budget there is. The default lives
-- in code (DEFAULT_ACCOUNT_AI_BUDGET_USD), so no `aiBudgetUsd` row is written here: an account
-- that has never been given a figure uses the default, and only a deliberate change stores one.
--
-- Spend is never a running total; it is the sum of `ai_calls` inside a window, so a counter is
-- zeroed by moving the window rather than by deleting the log. `aiBudgetResetAt` is that window's
-- start, recorded here for every existing account, so everyone begins the new arrangement at zero
-- while Health can still show every call ever made. A later month rolls past the marker on its
-- own, because the window is the later of the marker and the month.
--
-- Idempotent: an account that already carries a marker (a reset made from Admin) keeps it.

INSERT INTO "user_settings" ("user_id", "key", "value", "updated_at")
SELECT u."id", 'aiBudgetResetAt', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), now()
FROM "users" u
ON CONFLICT ("user_id", "key") DO NOTHING;
