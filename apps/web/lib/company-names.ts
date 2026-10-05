/**
 * Renaming a company in the shared catalogue, and the suggestions that ask for one.
 *
 * The catalogue is shared, so a name reaches every follower and only an administrator may change
 * it. A follower who knows better — the usual case is a company added before anyone confirmed its
 * careers page, whose name was taken from its domain — proposes one instead, and this is the one
 * place that turns a proposal into the rename.
 */
import { and, eq, sql } from "drizzle-orm";
import { enqueueTasks, taskRow } from "@col/db";
import { companies, companyNameSuggestions } from "@col/db/schema";
import type { db } from "./db";

type Writer = Pick<ReturnType<typeof db>, "select" | "insert" | "update" | "execute">;

export const MAX_COMPANY_NAME = 200;

/** The catalogue's name rule in one place: trimmed and bounded. Empty means "no name given". */
export function normaliseCompanyName(raw: string): string {
  return raw.trim().slice(0, MAX_COMPANY_NAME);
}

/** Queue every account with a view of this company's roles after its name changes. */
export async function enqueueCompanyNameRescores(writer: Writer, companyId: string): Promise<void> {
  const affected = await writer.execute<{ user_id: string }>(sql`select distinct uj.user_id
    from user_jobs uj join jobs j on j.id = uj.job_id join users u on u.id = uj.user_id
    where j.company_id = ${companyId}::uuid and (u.role = 'admin' or u.email_verified_at is not null)`);
  await enqueueTasks(writer as ReturnType<typeof db>, affected.rows.map(row =>
    taskRow("rescore_all", { userId: row.user_id, onlyInTable: true })), 250);
}

/**
 * Rename the company a pending suggestion names and resolve the suggestion in one go. Returns the
 * company it renamed, or null when the suggestion is gone or already resolved — an administrator
 * who applies the same row twice, from two tabs, renames nothing the second time.
 */
export async function applySuggestedName(writer: Writer, suggestionId: string, resolvedBy: string, now = new Date()): Promise<{ companyId: string; name: string } | null> {
  const [resolved] = await writer
    .update(companyNameSuggestions)
    .set({ status: "applied", resolvedBy, resolvedAt: now })
    .where(and(eq(companyNameSuggestions.id, suggestionId), eq(companyNameSuggestions.status, "pending")))
    .returning({ companyId: companyNameSuggestions.companyId, name: companyNameSuggestions.name });
  if (!resolved) return null;
  const name = normaliseCompanyName(resolved.name);
  if (!name) return null;
  await writer.update(companies).set({ name }).where(eq(companies.id, resolved.companyId));
  await enqueueCompanyNameRescores(writer, resolved.companyId);
  return { companyId: resolved.companyId, name };
}

/**
 * This account's pending proposal for a company: one per account and company, so proposing again
 * corrects the last one rather than queuing a second row for an administrator to read.
 */
export async function upsertNameSuggestion(writer: Writer, companyId: string, userId: string, name: string): Promise<string> {
  const [existing] = await writer
    .select({ id: companyNameSuggestions.id })
    .from(companyNameSuggestions)
    .where(and(eq(companyNameSuggestions.companyId, companyId), eq(companyNameSuggestions.userId, userId), eq(companyNameSuggestions.status, "pending")))
    .limit(1);
  if (existing) {
    await writer.update(companyNameSuggestions).set({ name }).where(eq(companyNameSuggestions.id, existing.id));
    return existing.id;
  }
  const [created] = await writer
    .insert(companyNameSuggestions)
    .values({ companyId, userId, name })
    .returning({ id: companyNameSuggestions.id });
  if (!created) throw new Error("Failed to record the name suggestion.");
  return created.id;
}
