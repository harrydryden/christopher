-- Worker runtime: indexed claim ordering, shutdown hand-back, and the indexes the hot reads need.
--
-- `tasks` claims used to order by an ageing expression computed per row, which no index could
-- serve, so every claim sorted the whole ready lane. The ordering is now the plain
-- (priority, run_after, created_at) the indexes below cover, and ageing is a bounded sweep in the
-- scheduler that decrements `priority` itself.
--
-- `ai_reservations` gains the worker that holds it, so a worker shutting down can release its own
-- holds at once instead of leaving a killed CV build's 30-minute hold against an account's budget.
--
-- `ai_spend_periods` has not been read or written since account budgets replaced the running
-- totals (a budget is recorded spend in `ai_calls` plus live reservations); the empty table goes.
--
-- Idempotent throughout: every statement is IF EXISTS / IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS "ai_calls_user_at_idx" ON "ai_calls" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_runs_company_started_idx" ON "discovery_runs" USING btree ("company_id","started_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_profiles_company_generated_idx" ON "company_profiles" USING btree ("company_id","generated_at" DESC);--> statement-breakpoint

ALTER TABLE "ai_reservations" ADD COLUMN IF NOT EXISTS "worker_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_reservations_worker_idx" ON "ai_reservations" USING btree ("worker_id");--> statement-breakpoint

DROP INDEX IF EXISTS "tasks_status_run_after_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_status_run_after_idx" ON "tasks" USING btree ("status","priority","run_after","created_at");--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_lane_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_lane_idx" ON "tasks" USING btree ("type","status","priority","run_after","created_at");--> statement-breakpoint

DROP TABLE IF EXISTS "ai_spend_periods";
