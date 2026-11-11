"use server";

import { and, desc, eq, lt, or } from "drizzle-orm";
import { cvApplicationContexts, cvAutoBaselines, cvDrafts } from "@col/db/schema";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { cvHistoryCursor } from "@/lib/queries/cv-workspace";
import { zUuid } from "@/lib/validation";

const PAGE_SIZE = 25;

/** Metadata only: loading old history must not serialise every saved CV into the editor. */
export async function readCvHistoryPage(contextId: string, cursors: {
  baselines?: string; editions?: string;
}) {
  const user = await requireUser();
  if (!zUuid().safeParse(contextId).success) return { ok: false as const, error: "Application not found." };
  const [owned] = await db().select({ id: cvApplicationContexts.id }).from(cvApplicationContexts)
    .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).limit(1);
  if (!owned) return { ok: false as const, error: "Application not found." };
  const baselineCursor = cvHistoryCursor(cursors.baselines);
  const editionCursor = cvHistoryCursor(cursors.editions);
  const [baselines, editions] = await Promise.all([
    baselineCursor === "end" ? Promise.resolve([]) : db().select({
      id: cvAutoBaselines.id, status: cvAutoBaselines.status,
      descriptionVersionId: cvAutoBaselines.descriptionVersionId,
      createdAt: cvAutoBaselines.createdAt, publishedAt: cvAutoBaselines.publishedAt,
    }).from(cvAutoBaselines).where(and(eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.userId, user.id),
      baselineCursor ? or(lt(cvAutoBaselines.createdAt, baselineCursor.createdAt),
        and(eq(cvAutoBaselines.createdAt, baselineCursor.createdAt), lt(cvAutoBaselines.id, baselineCursor.id))) : undefined))
      .orderBy(desc(cvAutoBaselines.createdAt), desc(cvAutoBaselines.id)).limit(PAGE_SIZE + 1),
    editionCursor === "end" ? Promise.resolve([]) : db().select({
      id: cvDrafts.id, status: cvDrafts.status, editingMode: cvDrafts.editingMode,
      revision: cvDrafts.revision, finalisedAt: cvDrafts.finalisedAt, createdAt: cvDrafts.createdAt,
    }).from(cvDrafts).where(and(eq(cvDrafts.contextId, contextId), eq(cvDrafts.userId, user.id),
      editionCursor ? or(lt(cvDrafts.createdAt, editionCursor.createdAt),
        and(eq(cvDrafts.createdAt, editionCursor.createdAt), lt(cvDrafts.id, editionCursor.id))) : undefined))
      .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id)).limit(PAGE_SIZE + 1),
  ]);
  const next = (rows: Array<{ id: string; createdAt: Date }>) => {
    const last = rows[PAGE_SIZE - 1];
    return rows.length > PAGE_SIZE && last ? `${last.createdAt.toISOString()}|${last.id}` : "end";
  };
  const nextBaselines = next(baselines);
  const nextEditions = next(editions);
  return { ok: true as const, baselines: baselines.slice(0, PAGE_SIZE), editions: editions.slice(0, PAGE_SIZE),
    older: nextBaselines === "end" && nextEditions === "end" ? null : {
      baselines: baselineCursor === "end" ? "end" : nextBaselines,
      editions: editionCursor === "end" ? "end" : nextEditions,
    } };
}
