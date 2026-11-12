import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { canonicalJson } from "@col/core/cv-review";
import { cvInlineTargetText, type CvInlineInput, type CvInlineRequest, type CvInlineRunView } from "@col/core/cv-inline-ai";
import { CvContentSchema } from "@col/core/cv";
import type { Db } from "./client";
import { cvApplicationContexts, cvAutoBaselines, cvContextDescriptions, cvDrafts } from "./schema";
import { cvInlineEditRuns } from "./cv-inline-edit-schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export const cvInlineHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export class CvInlineSourceError extends Error {
  readonly userFacing = true;
  constructor() { super("This CV or role changed. Reopen the saved version before asking for a change."); }
}

/** Lock the owned context first: an unrelated account can never resolve a source or target. */
export async function readCvInlineSource(tx: Tx, userId: string, request: CvInlineRequest) {
  const [context] = await tx.select().from(cvApplicationContexts).where(and(
    eq(cvApplicationContexts.id, request.contextId), eq(cvApplicationContexts.userId, userId))).for("update");
  if (!context?.currentDescriptionVersionId || context.selectedId !== request.source.id || context.selectedKind !== request.source.kind)
    throw new CvInlineSourceError();
  const [baseline] = request.source.kind === "baseline" ? await tx.select().from(cvAutoBaselines).where(and(
    eq(cvAutoBaselines.id, request.source.id), eq(cvAutoBaselines.userId, userId),
    eq(cvAutoBaselines.contextId, context.id), eq(cvAutoBaselines.status, "ready"))) : [];
  const [draft] = request.source.kind === "draft" ? await tx.select().from(cvDrafts).where(and(
    eq(cvDrafts.id, request.source.id), eq(cvDrafts.userId, userId), eq(cvDrafts.contextId, context.id))).for("update") : [];
  if (draft && (draft.revision !== request.source.revision || draft.status !== "ready")) throw new CvInlineSourceError();
  const source = baseline ?? draft;
  if (!source?.content || !source.editingTargets || !source.descriptionVersionId ||
    (request.action === "inline_tailor" && source.descriptionVersionId !== context.currentDescriptionVersionId))
    throw new CvInlineSourceError();
  const content = CvContentSchema.parse(source.content);
  const target = cvInlineTargetText(content, source.editingTargets, request.target);
  if (!target || request.text.length > target.maxLength) throw new CvInlineSourceError();
  const [description] = await tx.select().from(cvContextDescriptions).where(and(
    eq(cvContextDescriptions.id, source.descriptionVersionId), eq(cvContextDescriptions.contextId, context.id),
    eq(cvContextDescriptions.userId, userId)));
  if (!description) throw new CvInlineSourceError();
  return { context, target, description,
    fingerprint: cvInlineHash({ content, targets: source.editingTargets, description: description.id,
      revision: draft?.revision ?? null }) };
}

export async function cvInlineSourceCurrent(tx: Tx, userId: string, input: CvInlineInput): Promise<boolean> {
  try {
    const source = await readCvInlineSource(tx, userId, input.request);
    return source.fingerprint === input.sourceFingerprint && source.description.id === input.descriptionVersionId;
  } catch (error) { if (error instanceof CvInlineSourceError) return false; throw error; }
}

export function cvInlineRunView(run: typeof cvInlineEditRuns.$inferSelect): CvInlineRunView {
  return { id: run.id, status: run.status, beforeText: run.input.selection.selected,
    proposedText: run.proposedText, text: run.input.request.text,
    selectionStart: run.input.selection.start, selectionEnd: run.input.selection.end,
    error: run.error, target: run.input.request.target, source: run.input.request.source };
}
