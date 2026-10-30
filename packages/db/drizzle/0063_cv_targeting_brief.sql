ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "targeting_brief" jsonb;
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "pending_skill_proposals" jsonb;
ALTER TABLE "cv_drafts" ADD COLUMN IF NOT EXISTS "semantic_audit_cache" jsonb;
