import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CvInlineInput } from "@col/core/cv-inline-ai";

/** Ownership FKs are defined by migration 0075 to avoid a circular schema import. */
export const cvInlineEditRuns = pgTable("cv_inline_edit_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(), contextId: uuid("context_id").notNull(),
  requestKey: uuid("request_key").notNull(), inputHash: text("input_hash").notNull(),
  usageId: uuid("usage_id").notNull(),
  input: jsonb("input").$type<CvInlineInput>().notNull(),
  status: text("status", { enum: ["queued", "ready", "failed", "dismissed"] }).notNull().default("queued"),
  proposedText: text("proposed_text"), error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("cv_inline_edit_runs_request_idx").on(table.userId, table.requestKey),
  index("cv_inline_edit_runs_context_idx").on(table.userId, table.contextId, table.createdAt.desc()),
  index("cv_inline_edit_runs_input_idx").on(table.userId, table.contextId, table.inputHash)]);
