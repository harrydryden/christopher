CREATE INDEX "suggestions_review_idx" ON "company_suggestions" USING btree ("status","rank","created_at");--> statement-breakpoint
CREATE INDEX "suggestions_history_idx" ON "company_suggestions" USING btree ("status","resolved_at");--> statement-breakpoint
CREATE INDEX "discovery_document_pending_idx" ON "discovery_documents" USING btree ("source_id","created_at") WHERE "discovery_documents"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "discovery_sources_due_idx" ON "discovery_sources" USING btree ("next_run_at") WHERE "discovery_sources"."enabled" = true;--> statement-breakpoint
CREATE INDEX "scans_run_idx" ON "scans" USING btree ("scan_run_id");--> statement-breakpoint
CREATE INDEX "tasks_scan_run_idx" ON "tasks" USING btree (("payload"->>'scanRunId'),"status");--> statement-breakpoint
CREATE INDEX "tasks_source_status_idx" ON "tasks" USING btree (("payload"->>'sourceId'),"status","created_at");--> statement-breakpoint
CREATE INDEX "tasks_lane_idx" ON "tasks" USING btree ("type","status","priority","run_after");