ALTER TABLE "billing_accounts"
ADD COLUMN IF NOT EXISTS "stripe_event_created_at" bigint DEFAULT 0 NOT NULL;
