ALTER TABLE "credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_kind_check";
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_kind_check"
CHECK ("kind" IN ('grant', 'reserve', 'release', 'consume', 'transfer', 'revoke'));
