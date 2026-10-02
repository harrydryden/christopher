CREATE TABLE IF NOT EXISTS "billing_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"company_blocks" integer DEFAULT 0 NOT NULL,
	"current_period_start" timestamptz,
	"current_period_end" timestamptz,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"grace_ends_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_plan_check" CHECK ("plan" IN ('free', 'search', 'intensive')),
	CONSTRAINT "billing_accounts_status_check" CHECK ("status" IN ('active', 'past_due', 'cancelled')),
	CONSTRAINT "billing_accounts_company_blocks_check" CHECK ("company_blocks" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_accounts_customer_uidx" ON "billing_accounts" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_accounts_subscription_uidx" ON "billing_accounts" ("stripe_subscription_id") WHERE "stripe_subscription_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"source" text NOT NULL,
	"units" integer NOT NULL,
	"remaining" integer NOT NULL,
	"expires_at" timestamptz,
	"external_ref" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_source_check" CHECK ("source" IN ('welcome', 'monthly', 'topup', 'admin')),
	CONSTRAINT "credit_grants_units_check" CHECK ("units" > 0),
	CONSTRAINT "credit_grants_remaining_check" CHECK ("remaining" >= 0 AND "remaining" <= "units")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_grants_external_uidx" ON "credit_grants" ("source", "external_ref") WHERE "external_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_grants_spend_idx" ON "credit_grants" ("user_id", "expires_at", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_reservations" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"grant_id" uuid NOT NULL REFERENCES "credit_grants"("id") ON DELETE restrict,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_at" timestamptz DEFAULT now() NOT NULL,
	"settled_at" timestamptz,
	CONSTRAINT "credit_reservations_status_check" CHECK ("status" IN ('reserved', 'consumed', 'released'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_reservations_user_status_idx" ON "credit_reservations" ("user_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"grant_id" uuid REFERENCES "credit_grants"("id") ON DELETE restrict,
	"draft_id" uuid,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"idempotency_key" text NOT NULL UNIQUE,
	"note" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_kind_check" CHECK ("kind" IN ('grant', 'reserve', 'release', 'consume', 'transfer'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_user_created_idx" ON "credit_ledger" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "billing_accounts" ("user_id")
SELECT "id" FROM "users"
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
WITH inserted AS (
	INSERT INTO "credit_grants" ("user_id", "source", "units", "remaining", "external_ref")
	SELECT "id", 'welcome', 3, 3, 'welcome:' || "id"::text FROM "users"
	ON CONFLICT ("source", "external_ref") WHERE "external_ref" IS NOT NULL DO NOTHING
	RETURNING "id", "user_id", "units", "external_ref"
)
INSERT INTO "credit_ledger" ("user_id", "grant_id", "kind", "delta", "idempotency_key", "note")
SELECT "user_id", "id", 'grant', "units", 'grant:' || "external_ref", 'First three CV builds'
FROM inserted
ON CONFLICT ("idempotency_key") DO NOTHING;
