import { and, eq, sql } from "drizzle-orm";
import type { CvContent, CvLibrary } from "@col/core";
import type { CvAssessment, CvJobSource } from "@col/core/cv-assessment";
import { CvContentSchema, CvLibrarySchema } from "@col/core";
import { cvAutoInputKey, validateCvEditingTargets, type CvAutoInputV1, type CvEditingTargets } from "@col/core/cv-editing-modes";
import { canonicalJson } from "@col/core/cv-review";
import { CvTailoringPlanSchema, type CvTailoringPlan } from "@col/core/cv-tailoring";
import type { Db } from "./client";
import { cvApplicationContexts, cvAutoBaselines, cvContextDescriptions, cvDrafts } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class CvContextConflict extends Error {
  readonly userFacing = true as const;
}

/** Reopening a request key is idempotent; a deliberate new application supplies another UUID key. */
export async function resolveCvApplicationContext(tx: Tx, input: {
  userId: string; requestKey: string; jobId?: string | null; companyName: string; jobTitle: string;
  description: string; source?: CvJobSource | null;
}) {
  if (!input.requestKey || input.requestKey.length > 120) throw new CvContextConflict("Invalid application context key.");
  if (input.description.trim().length < 80 || input.description.length > 60_000)
    throw new CvContextConflict("Keep the role description between 80 and 60,000 characters.");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cv:context:${input.userId}:${input.requestKey}`}, 0))`);
  const [existing] = await tx.select().from(cvApplicationContexts)
    .where(and(eq(cvApplicationContexts.userId, input.userId), eq(cvApplicationContexts.requestKey, input.requestKey))).for("update");
  if (existing && (existing.jobId !== (input.jobId ?? null) || existing.companyName !== input.companyName || existing.jobTitle !== input.jobTitle))
    throw new CvContextConflict("This application context belongs to a different role. Open the saved role or start a new application.");
  const context = existing ?? (await tx.insert(cvApplicationContexts).values({ userId: input.userId,
    requestKey: input.requestKey, jobId: input.jobId ?? null, companyName: input.companyName, jobTitle: input.jobTitle }).returning())[0]!;
  const [latest] = await tx.select().from(cvContextDescriptions)
    .where(and(eq(cvContextDescriptions.contextId, context.id), eq(cvContextDescriptions.userId, input.userId)))
    .orderBy(sql`${cvContextDescriptions.version} desc`).limit(1);
  if (latest && latest.text !== input.description)
    throw new CvContextConflict("The saved role description differs. Open this application, then choose Update description explicitly.");
  if (latest) return { context, description: latest, changed: false };
  const [description] = await tx.insert(cvContextDescriptions).values({ contextId: context.id, userId: input.userId,
    version: 1, text: input.description, source: input.source ?? null }).returning();
  await tx.update(cvApplicationContexts).set({ currentDescriptionVersionId: description!.id })
    .where(and(eq(cvApplicationContexts.id, context.id), eq(cvApplicationContexts.userId, input.userId)));
  return { context: { ...context, currentDescriptionVersionId: description!.id }, description: description!, changed: true };
}

/** An advert change is deliberate and version-fenced; reopening never overwrites one. */
export async function updateCvContextDescription(tx: Tx, input: { userId: string; contextId: string;
  expectedDescriptionVersionId: string; description: string; source?: CvJobSource | null }) {
  if (input.description.trim().length < 80 || input.description.length > 60_000)
    throw new CvContextConflict("Keep the role description between 80 and 60,000 characters.");
  const [context] = await tx.select().from(cvApplicationContexts)
    .where(and(eq(cvApplicationContexts.id, input.contextId), eq(cvApplicationContexts.userId, input.userId))).for("update");
  if (!context || context.currentDescriptionVersionId !== input.expectedDescriptionVersionId)
    throw new CvContextConflict("This role description changed. Reload it before saving another version.");
  const [previous] = await tx.select().from(cvContextDescriptions)
    .where(and(eq(cvContextDescriptions.id, input.expectedDescriptionVersionId),
      eq(cvContextDescriptions.contextId, context.id), eq(cvContextDescriptions.userId, input.userId)));
  if (!previous) throw new CvContextConflict("The previous role description is unavailable.");
  if (previous.text === input.description) return previous;
  const [next] = await tx.insert(cvContextDescriptions).values({ contextId: context.id, userId: input.userId,
    version: previous.version + 1, text: input.description, source: input.source ?? null }).returning();
  await tx.update(cvApplicationContexts).set({ currentDescriptionVersionId: next!.id })
    .where(and(eq(cvApplicationContexts.id, context.id), eq(cvApplicationContexts.userId, input.userId)));
  return next!;
}

/** The unique row is a claim as well as a cache lookup; only a complete ready payload is a hit. */
export async function claimCvAutoBaseline(tx: Tx, input: {
  userId: string; contextId: string; descriptionVersionId: string; inputKey: string;
  inputSnapshot: CvAutoInputV1;
  engineContract: CvAutoInputV1["contracts"] & { routes: CvAutoInputV1["routes"] };
}) {
  if (!/^[a-f0-9]{64}$/.test(input.inputKey)) throw new CvContextConflict("Invalid Auto input identity.");
  if (cvAutoInputKey(input.inputSnapshot) !== input.inputKey || input.inputSnapshot.contextId !== input.contextId
    || input.inputSnapshot.descriptionVersionId !== input.descriptionVersionId
    || canonicalJson(input.engineContract) !== canonicalJson({ ...input.inputSnapshot.contracts, routes: input.inputSnapshot.routes }))
    throw new CvContextConflict("Auto input identity does not match the selected application.");
  const [context] = await tx.select({ id: cvApplicationContexts.id, currentDescriptionVersionId: cvApplicationContexts.currentDescriptionVersionId })
    .from(cvApplicationContexts).where(and(eq(cvApplicationContexts.id, input.contextId), eq(cvApplicationContexts.userId, input.userId))).for("update");
  if (!context || context.currentDescriptionVersionId !== input.descriptionVersionId)
    throw new CvContextConflict("The role description changed. Reload this application before generating a CV.");
  const [created] = await tx.insert(cvAutoBaselines).values({ ...input, status: "queued" as const })
    .onConflictDoNothing({ target: [cvAutoBaselines.userId, cvAutoBaselines.contextId, cvAutoBaselines.inputKey] })
    .returning();
  const row = created ?? (await tx.select().from(cvAutoBaselines)
    .where(and(eq(cvAutoBaselines.userId, input.userId), eq(cvAutoBaselines.contextId, input.contextId), eq(cvAutoBaselines.inputKey, input.inputKey)))
    .for("update"))[0];
  if (!row) throw new Error("Auto baseline claim vanished.");
  const ready = row.status === "ready" && row.publishedAt && row.content && row.librarySnapshot && row.editingTargets;
  return { baseline: row, created: !!created, hit: !!ready };
}

/** Binds the one paid build to its claim before it is queued. A loser cannot publish its answer. */
export async function attachCvAutoBaselineDraft(tx: Tx, input: { userId: string; baselineId: string; draftId: string }) {
  const [attached] = await tx.update(cvAutoBaselines).set({ sourceDraftId: input.draftId })
    .where(and(eq(cvAutoBaselines.id, input.baselineId), eq(cvAutoBaselines.userId, input.userId),
      eq(cvAutoBaselines.status, "queued"), sql`${cvAutoBaselines.sourceDraftId} is null`))
    .returning({ id: cvAutoBaselines.id });
  if (!attached) throw new CvContextConflict("This Auto build was already claimed. Open the existing build.");
}

/** Publication copies the result out of revision retention; repeated delivery cannot alter it. */
export async function publishCvAutoBaseline(tx: Tx, input: { userId: string; baselineId: string; sourceDraftId: string;
  content: CvContent; assessment?: CvAssessment | null; librarySnapshot: CvLibrary;
  tailoringPlan?: CvTailoringPlan | null; editingTargets: CvEditingTargets;
}) {
  const content = CvContentSchema.parse(input.content);
  const librarySnapshot = CvLibrarySchema.parse(input.librarySnapshot);
  const editingTargets = validateCvEditingTargets(content, input.editingTargets);
  const tailoringPlan = input.tailoringPlan ? CvTailoringPlanSchema.parse(input.tailoringPlan) : null;
  const [row] = await tx.select().from(cvAutoBaselines)
    .where(and(eq(cvAutoBaselines.id, input.baselineId), eq(cvAutoBaselines.userId, input.userId))).for("update");
  if (!row) throw new CvContextConflict("Auto baseline is no longer available.");
  if (row.sourceDraftId !== input.sourceDraftId)
    throw new CvContextConflict("A newer Auto build owns this baseline claim.");
  const [source] = await tx.select({ id: cvDrafts.id, userId: cvDrafts.userId,
    contextId: cvDrafts.contextId, descriptionVersionId: cvDrafts.descriptionVersionId,
    autoBaselineId: cvDrafts.autoBaselineId, editingMode: cvDrafts.editingMode,
    careerVersion: cvDrafts.careerVersion, careerSourceMap: cvDrafts.careerSourceMap,
    careerDisplay: cvDrafts.careerDisplay, careerPresentation: cvDrafts.careerPresentation })
    .from(cvDrafts).where(and(eq(cvDrafts.id, input.sourceDraftId), eq(cvDrafts.userId, input.userId)));
  if (!source || source.contextId !== row.contextId || source.descriptionVersionId !== row.descriptionVersionId
    || source.autoBaselineId !== row.id || source.editingMode !== "auto")
    throw new CvContextConflict("The Auto result belongs to a different application or build.");
  if (row.status === "ready") return row;
  if (row.status !== "queued") throw new CvContextConflict("This Auto baseline needs an explicit retry.");
  const [published] = await tx.update(cvAutoBaselines).set({ status: "ready", sourceDraftId: input.sourceDraftId,
    content, assessment: input.assessment ?? null, librarySnapshot, tailoringPlan,
    careerVersion: source.careerVersion, careerSourceMap: source.careerSourceMap,
    careerDisplay: source.careerDisplay, careerPresentation: source.careerPresentation,
    editingTargets, publishedAt: new Date() })
    .where(and(eq(cvAutoBaselines.id, row.id), eq(cvAutoBaselines.userId, input.userId), eq(cvAutoBaselines.status, "queued")))
    .returning();
  if (!published) throw new CvContextConflict("Auto baseline changed during publication.");
  return published;
}
