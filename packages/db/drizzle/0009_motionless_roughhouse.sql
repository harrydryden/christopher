CREATE TABLE "ai_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_site" text NOT NULL,
	"amount" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_spend_periods" (
	"key" text PRIMARY KEY NOT NULL,
	"amount" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_pacing" (
	"host" text PRIMARY KEY NOT NULL,
	"next_at" timestamp with time zone NOT NULL
);
