import { and, desc, eq, lt, or } from "drizzle-orm";
import { cvApplicationContexts, cvAutoBaselines, cvContextDescriptions, cvDrafts } from "@col/db/schema";
import { currentCvRefinements } from "@col/db";
import { db } from "@/lib/db";

const HISTORY_PAGE_SIZE = 25;
type HistoryCursor = { createdAt: Date; id: string } | "end" | null;

export function cvHistoryCursor(raw: string | undefined): HistoryCursor {
  if (!raw) return null;
  if (raw === "end") return "end";
  const separator = raw.indexOf("|");
  if (separator < 0) return null;
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  return Number.isFinite(createdAt.getTime()) && /^[a-f0-9-]{36}$/i.test(id) ? { createdAt, id } : null;
}

function nextCursor(rows: Array<{ createdAt: Date; id: string }>): string {
  const last = rows[HISTORY_PAGE_SIZE - 1];
  return rows.length > HISTORY_PAGE_SIZE && last ? `${last.createdAt.toISOString()}|${last.id}` : "end";
}

/** The selected artefact is fetched independently of history: an old selection cannot fall off a page. */
export async function getOwnCvWorkspace(userId: string, contextId: string,
  cursors: { baselines?: string; editions?: string } = {}) {
  const baselineCursor = cvHistoryCursor(cursors.baselines);
  const editionCursor = cvHistoryCursor(cursors.editions);
  const [context] = await db().select().from(cvApplicationContexts)
    .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, userId))).limit(1);
  if (!context) return null;
  const [descriptionRows, baselines, editions, baselineRows, draftRows, refinements] = await Promise.all([
    context.currentDescriptionVersionId ? db().select().from(cvContextDescriptions).where(and(
      eq(cvContextDescriptions.id, context.currentDescriptionVersionId),
      eq(cvContextDescriptions.contextId, contextId), eq(cvContextDescriptions.userId, userId))).limit(1) : Promise.resolve([]),
    baselineCursor === "end" ? Promise.resolve([]) : db().select({ id: cvAutoBaselines.id, status: cvAutoBaselines.status, sourceDraftId: cvAutoBaselines.sourceDraftId,
      createdAt: cvAutoBaselines.createdAt, publishedAt: cvAutoBaselines.publishedAt })
      .from(cvAutoBaselines).where(and(eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.userId, userId),
        baselineCursor ? or(lt(cvAutoBaselines.createdAt, baselineCursor.createdAt),
          and(eq(cvAutoBaselines.createdAt, baselineCursor.createdAt), lt(cvAutoBaselines.id, baselineCursor.id))) : undefined))
      .orderBy(desc(cvAutoBaselines.createdAt), desc(cvAutoBaselines.id)).limit(HISTORY_PAGE_SIZE + 1),
    editionCursor === "end" ? Promise.resolve([]) : db().select({ id: cvDrafts.id, status: cvDrafts.status, editingMode: cvDrafts.editingMode,
      revision: cvDrafts.revision, finalisedAt: cvDrafts.finalisedAt, createdAt: cvDrafts.createdAt })
      .from(cvDrafts).where(and(eq(cvDrafts.contextId, contextId), eq(cvDrafts.userId, userId),
        editionCursor ? or(lt(cvDrafts.createdAt, editionCursor.createdAt),
          and(eq(cvDrafts.createdAt, editionCursor.createdAt), lt(cvDrafts.id, editionCursor.id))) : undefined))
      .orderBy(desc(cvDrafts.createdAt), desc(cvDrafts.id)).limit(HISTORY_PAGE_SIZE + 1),
    context.selectedKind === "baseline" && context.selectedId ? db().select().from(cvAutoBaselines)
      .where(and(eq(cvAutoBaselines.id, context.selectedId), eq(cvAutoBaselines.contextId, contextId),
        eq(cvAutoBaselines.userId, userId))).limit(1) : Promise.resolve([]),
    context.selectedKind === "draft" && context.selectedId ? db().select().from(cvDrafts)
      .where(and(eq(cvDrafts.id, context.selectedId), eq(cvDrafts.contextId, contextId),
        eq(cvDrafts.userId, userId))).limit(1) : Promise.resolve([]),
    db().transaction(tx => currentCvRefinements(tx, userId, contextId),
      { isolationLevel: "repeatable read", accessMode: "read only" }),
  ]);
  const selectedDraft = draftRows[0] ?? null;
  const [linkedBaseline] = selectedDraft?.autoBaselineId ? await db().select().from(cvAutoBaselines)
    .where(and(eq(cvAutoBaselines.id, selectedDraft.autoBaselineId), eq(cvAutoBaselines.contextId, contextId),
      eq(cvAutoBaselines.userId, userId))).limit(1) : [];
  const selectedBaseline = baselineRows[0] ?? linkedBaseline ?? null;
  const selected = selectedDraft ? { kind: "draft" as const, id: selectedDraft.id, draftId: selectedDraft.id }
    : selectedBaseline ? { kind: "baseline" as const, id: selectedBaseline.id,
      draftId: selectedBaseline.sourceDraftId } : null;
  const nextBaselines = nextCursor(baselines);
  const nextEditions = nextCursor(editions);
  return { context, description: descriptionRows[0] ?? null, selected, selectedBaseline, selectedDraft, refinements,
    baselines: baselines.slice(0, HISTORY_PAGE_SIZE), editions: editions.slice(0, HISTORY_PAGE_SIZE),
    older: nextBaselines === "end" && nextEditions === "end" ? null : {
      baselines: baselineCursor === "end" ? "end" : nextBaselines === "end" ? "end" : nextBaselines,
      editions: editionCursor === "end" ? "end" : nextEditions === "end" ? "end" : nextEditions,
    } };
}
