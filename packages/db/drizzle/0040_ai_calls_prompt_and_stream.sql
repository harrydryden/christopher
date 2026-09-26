-- Every call names the prompt that produced it and how its stream behaved.
--
-- `prompt_id` and `prompt_version` are the prompt registry entry and the short hash of its text and
-- schema (packages/ai/src/prompt-registry.ts), so a shift in cost or quality can be traced to the
-- prompt change behind it. `ttft_ms` and `max_event_gap_ms` are measured per call, so a p95 of
-- either is a percentile over rows rather than a mean of means. `stop_reason`, `request_id`,
-- `attempt` and `step_id` make one call findable from a build step, and from the provider's side.
--
-- Every column is nullable and has no default, so adding them rewrites nothing, and rows written
-- before this migration read as "not recorded". The interface deploys separately and may run
-- against a database without these columns for a few minutes; `recordAiCall` checks for them
-- before writing them.
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "prompt_id" text;
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "prompt_version" text;
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "ttft_ms" integer;
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "max_event_gap_ms" integer;
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "stop_reason" text;
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "request_id" text;
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "attempt" integer;
ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "step_id" text;
