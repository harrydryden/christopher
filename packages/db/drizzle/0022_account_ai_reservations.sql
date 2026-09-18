-- Capacity held for a call in flight now belongs to an account.
--
-- There is one budget: each account's own monthly one. A reservation covers the gap between
-- admitting a call and its `ai_calls` row landing, so it has to say whose budget it is against,
-- or two builds started at once for the same account would each see the other's spend as unspent.
-- A row with no `user_id` is work that belongs to no account (extraction, discovery); only the
-- operator's optional day and discovery caps bound it.
--
-- Deleting an account deletes its holds: a reservation is a few minutes of bookkeeping and never
-- part of the record of what was spent, which is `ai_calls` and is kept.

ALTER TABLE "ai_reservations" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_reservations" ADD CONSTRAINT "ai_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_reservations_user_idx" ON "ai_reservations" USING btree ("user_id");--> statement-breakpoint
-- The shared monthly ceiling and the shared reset marker that moved its window are both gone. An
-- earlier build of migration 0021 wrote that marker into `settings`; a database that ran it keeps
-- a row no key reads, so it is dropped here rather than left to shift an account's window.
DELETE FROM "settings" WHERE "key" IN ('aiBudgetResetAt', 'monthlyAiBudgetUsd');
