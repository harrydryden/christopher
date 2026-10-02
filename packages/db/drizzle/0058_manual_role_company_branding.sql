ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_manual_shape_chk";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_manual_shape_chk" CHECK (
  (origin = 'manual' AND source_id IS NULL AND manual_owner_id IS NOT NULL
    AND manual_fingerprint IS NOT NULL AND company_label IS NOT NULL AND length(btrim(company_label)) > 0
    AND shared = false AND input_kind IS NOT NULL AND input_kind IN ('link', 'pdf')
    AND ((input_kind = 'link' AND url IS NOT NULL AND source_filename IS NULL)
      OR (input_kind = 'pdf' AND url IS NULL)))
  OR (origin <> 'manual' AND company_id IS NOT NULL AND source_id IS NOT NULL AND url IS NOT NULL
    AND manual_owner_id IS NULL AND manual_fingerprint IS NULL AND company_label IS NULL
    AND input_kind IS NULL AND source_filename IS NULL)
);
