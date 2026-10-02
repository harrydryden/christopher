-- An application can be at interview or offer without the person knowing when it was submitted.
-- Existing dates are preserved; new status-only records leave this field empty.
ALTER TABLE "applications" ALTER COLUMN "applied_on" DROP NOT NULL;
