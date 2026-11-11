"use server";

import { createHash, randomUUID } from "node:crypto";
import { CareerCvChoiceOverrideSchema, type CareerCvChoiceOverride, type CareerCvProjection } from "@col/core/career-record";
import { and, desc, eq, sql } from "drizzle-orm";
import { CV_PROMPT_IDS, PROMPTS, promptSetVersion, resolveRoute, routedModel } from "@col/ai/prompt-registry";
import { CV_REVIEW_VERSION, type CvJobSource } from "@col/core/cv-assessment";
import { cvSemanticAuditIdentity } from "@col/core/cv-semantic-audit";
import { CvTargetingBriefSchema, cvRankedPriorityChoices } from "@col/core/cv-targeting";
import { cvTargetingRubricKey, cvTargetingSource } from "@col/core/cv-targeting-identity";
import { CV_FIT_VERSION, CV_RENDER_VERSION, cvAutoInputKey, cvRefinedResultKey, cvProjectRefinements, cvRefinementSourceIdentity,
  cvRefinementDependencies, cvEditingTargetsFor, cvProjectOneExactWording,
  validateCvEditingTargetTransition, CvRefinementSchema,
  type CvAutoInputV1, type CvRefinementV1, type CvEditingTargets } from "@col/core/cv-editing-modes";
import { BulletSignpostSchema, CvContentSchema, CvLibrarySchema, CvThemeSchema, DEFAULT_CV_THEME, groupCvLibrary, isEmptyCvExperienceError, isKnownModel, modelForCallSite,
  type CvContent, type CvLibrary } from "@col/core";
import { canonicalJson, cvAssessmentCurrent, validateCvRubric } from "@col/core/cv-review";
import { cvPreviewRefinementRebase, type CvRefinementRebaseItem } from "@col/core/cv-refinement-rebase";
import { appendCvRefinement, currentCvRefinements, attachCvAutoBaselineDraft, claimCvAutoBaseline, cvApplicationContexts, cvAutoBaselines,
  cvContextDescriptions, cvDrafts, jobs, companies, userJobs, users, nextCvRevision, reserveCvCredit,
  resolveCvApplicationContext } from "@col/db";
import { latestCareerCvEvidence, ensureCareerBackfill, lockAccountScoreInput } from "@col/db";
import type { Db } from "@col/db";
import { cvTailoringPlans, saveCvTailoringPlan } from "@col/db";
import { updateCvContextDescription } from "@col/db";
import { requireUser, requireVerifiedUser } from "@/lib/auth";
import { assertCvBuildCapacity, lockCvBuildCapacity } from "@/lib/cv-build-capacity";
import { latestLibrary } from "@/lib/cv-library-write";
import { cvDraftEditBaseHash } from "@/lib/cv-edit-base";
import { cvRevisionRubricCheckpoint } from "@/lib/cv-rubric-carry";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { getSettingsFor } from "@/lib/settings";
import { actionError, UserFacingError } from "@/lib/validation";
import { revalidatePath } from "next/cache";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CvContextResult = { ok: true; contextId: string; descriptionVersionId: string }
  | { ok: false; error: string };

/** Stored postings reopen one default context; an explicit new key creates another application. */
export async function createCvApplicationContext(input: {
  jobId?: string; requestKey: string; companyName?: string; jobTitle?: string; description?: string;
}): Promise<CvContextResult> {
  const user = await requireUser();
  try {
    if (!/^(?:job|new|paste):[0-9a-f-]{36}$/i.test(input.requestKey))
      throw new UserFacingError("Reload this application before creating its CV workspace.");
    let role: { jobId: string | null; company: string; title: string; description: string; source: CvJobSource };
    if (input.jobId) {
      if (!uuid.test(input.jobId)) throw new UserFacingError("Role not found.");
      const [found] = await db().select({ job: jobs,
        company: sql<string>`coalesce(${jobs.companyLabel}, ${companies.name}, 'Unknown employer')` })
        .from(userJobs).innerJoin(jobs, eq(jobs.id, userJobs.jobId))
        .leftJoin(companies, eq(jobs.companyId, companies.id))
        .where(and(eq(userJobs.userId, user.id), eq(jobs.id, input.jobId),
          sql`(${jobs.manualOwnerId} is null or ${jobs.manualOwnerId} = ${user.id}::uuid)`));
      if (!found) throw new UserFacingError("Role not found.");
      const supplied = input.description?.trim() ?? "";
      if (!supplied && (found.job.descriptionTruncated || found.job.descriptionSource === "model"))
        throw new UserFacingError("Paste the complete original advert for this role.");
      role = { jobId: input.jobId, company: found.company, title: found.job.title,
        description: supplied || found.job.descriptionText || "",
        source: { kind: supplied ? "user_supplied" : "company_snapshot", url: found.job.url,
          capturedAt: new Date().toISOString(),
          method: supplied ? "pasted" : found.job.descriptionSource === "direct" ? "direct" : "unknown" } };
      if (input.requestKey.startsWith("job:") && input.requestKey !== `job:${input.jobId}`)
        throw new UserFacingError("This saved role does not match its application context.");
    } else {
      if (!input.requestKey.startsWith("paste:")) throw new UserFacingError("Choose a saved role or paste a new one.");
      role = { jobId: null, company: input.companyName?.trim() ?? "", title: input.jobTitle?.trim() ?? "",
        description: input.description?.trim() ?? "", source: { kind: "user_supplied", url: null,
          capturedAt: new Date().toISOString(), method: "pasted" } };
      if (!role.company || !role.title || role.company.length > 160 || role.title.length > 160)
        throw new UserFacingError("Give the pasted role a company and job title.");
    }
    const result = await db().transaction(tx => resolveCvApplicationContext(tx, { userId: user.id,
      requestKey: input.requestKey, jobId: role.jobId, companyName: role.company, jobTitle: role.title,
      description: role.description, source: role.source }));
    revalidatePath("/cv");
    return { ok: true, contextId: result.context.id, descriptionVersionId: result.description.id };
  } catch (error) {
    const result = actionError(error, "Could not open this application. Please try again.");
    return { ok: false, error: result.ok ? "Could not open this application." : result.error };
  }
}

export async function updateCvApplicationDescription(contextId: string, expectedDescriptionVersionId: string,
  description: string): Promise<CvContextResult> {
  const user = await requireUser();
  try {
    if (!uuid.test(contextId) || !uuid.test(expectedDescriptionVersionId))
      throw new UserFacingError("This application changed. Reload it before updating the advert.");
    const next = await db().transaction(tx => updateCvContextDescription(tx, { userId: user.id,
      contextId, expectedDescriptionVersionId, description: description.trim(),
      source: { kind: "user_supplied", url: null, capturedAt: new Date().toISOString(), method: "pasted" } }));
    revalidatePath("/cv");
    return { ok: true, contextId, descriptionVersionId: next.id };
  } catch (error) {
    const result = actionError(error, "Could not update this role description. Please try again.");
    return { ok: false, error: result.ok ? "Could not update this role description." : result.error };
  }
}

export type AutoCvResult = { ok: true; status: "ready" | "queued" | "failed" | "missing";
  baselineId?: string; draftId?: string | null; updateAvailable?: boolean | null; charged: boolean;
  sourceReview?: CareerCvProjection["reviewConflicts"] }
  | { ok: false; error: string; sourceReview?: CareerCvProjection["reviewConflicts"] };

export type CvRefinementResult = { ok: true; version: number } | { ok: false; error: string };
export type CvRebasePreviewResult = { ok: true; version: number; toDescriptionVersionId: string;
  previewKey: string; items: CvRefinementRebaseItem[] } | { ok: false; error: string };
export type CvRebaseApplyResult = { ok: true; version: number; rebasedIds: string[];
  conflicts: Extract<CvRefinementRebaseItem, { status: "conflict" }>[] } | { ok: false; error: string };

type CvTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function cvRebaseSnapshot(tx: CvTx, input: { userId: string; contextId: string;
  expectedVersion: number; fromBaselineId: string; toBaselineId: string }) {
  const [context] = await tx.select().from(cvApplicationContexts).where(and(
    eq(cvApplicationContexts.id, input.contextId), eq(cvApplicationContexts.userId, input.userId))).for("update");
  if (!context?.currentDescriptionVersionId || context.refinementsVersion !== input.expectedVersion)
    throw new UserFacingError("These refinements changed. Reload this application before rebasing.");
  const [from, to] = await Promise.all([input.fromBaselineId, input.toBaselineId].map(id =>
    tx.select().from(cvAutoBaselines).where(and(eq(cvAutoBaselines.id, id),
      eq(cvAutoBaselines.userId, input.userId), eq(cvAutoBaselines.contextId, input.contextId),
      eq(cvAutoBaselines.status, "ready"))).limit(1).then(rows => rows[0])));
  if (!from?.content || !from.editingTargets || !from.librarySnapshot ||
      !to?.content || !to.editingTargets || !to.librarySnapshot)
    throw new UserFacingError("Choose two saved Auto results in this application to review the source change.");
  if (to.descriptionVersionId !== context.currentDescriptionVersionId)
    throw new UserFacingError("The destination Auto result uses an older role description. Update Auto first.");
  const active = await currentCvRefinements(tx, input.userId, input.contextId);
  const items = cvPreviewRefinementRebase({ from: { id: from.id,
    descriptionVersionId: from.descriptionVersionId, content: from.content,
    targets: from.editingTargets, library: from.librarySnapshot,
    rubric: from.assessment?.rubric ?? null },
  to: { id: to.id, descriptionVersionId: to.descriptionVersionId, content: to.content,
    targets: to.editingTargets, library: to.librarySnapshot, rubric: to.assessment?.rubric ?? null },
  refinements: active });
  const previewKey = createHash("sha256").update(canonicalJson({ contextId: context.id,
    currentDescriptionVersionId: context.currentDescriptionVersionId,
    refinementsVersion: context.refinementsVersion,
    from: { id: from.id, inputKey: from.inputKey, content: from.content,
      editingTargets: from.editingTargets, librarySnapshot: from.librarySnapshot,
      rubric: from.assessment?.rubric ?? null },
    to: { id: to.id, inputKey: to.inputKey, content: to.content,
      editingTargets: to.editingTargets, librarySnapshot: to.librarySnapshot,
      rubric: to.assessment?.rubric ?? null }, active, items })).digest("hex");
  return { context, to, active, items, previewKey };
}

/** Review exact anchors before choosing which remembered rules to carry to a newer Auto source. */
export async function previewCvRefinementRebase(contextId: string, expectedVersion: number,
  fromBaselineId: string, toBaselineId: string): Promise<CvRebasePreviewResult> {
  const user = await requireUser();
  try {
    if (![contextId, fromBaselineId, toBaselineId].every(id => uuid.test(id)) ||
        fromBaselineId === toBaselineId || !Number.isInteger(expectedVersion) || expectedVersion < 0)
      throw new UserFacingError("Choose distinct saved Auto results and reload this application.");
    const snapshot = await db().transaction(tx => cvRebaseSnapshot(tx, {
      userId: user.id, contextId, expectedVersion, fromBaselineId, toBaselineId }));
    return { ok: true, version: snapshot.context.refinementsVersion,
      toDescriptionVersionId: snapshot.to.descriptionVersionId,
      previewKey: snapshot.previewKey, items: snapshot.items };
  } catch (error) {
    const result = actionError(error, "Could not review these refinements. Please try again.");
    return { ok: false, error: result.ok ? "Could not review these refinements." : result.error };
  }
}

/** The preview is advisory; the account, sources, overlay version and exact mapping are rechecked under lock. */
export async function applyCvRefinementRebase(contextId: string, expectedVersion: number,
  fromBaselineId: string, toBaselineId: string, expectedPreviewKey: string,
  acceptedIds: string[]): Promise<CvRebaseApplyResult> {
  const user = await requireUser();
  try {
    if (![contextId, fromBaselineId, toBaselineId].every(id => uuid.test(id)) ||
        fromBaselineId === toBaselineId || !Number.isInteger(expectedVersion) || expectedVersion < 0 ||
        !/^[a-f0-9]{64}$/.test(expectedPreviewKey) || !Array.isArray(acceptedIds) ||
        acceptedIds.some(id => !uuid.test(id)) || new Set(acceptedIds).size !== acceptedIds.length)
      throw new UserFacingError("Reload the source review before carrying these refinements forward.");
    const result = await db().transaction(async tx => {
      const snapshot = await cvRebaseSnapshot(tx, { userId: user.id, contextId,
        expectedVersion, fromBaselineId, toBaselineId });
      if (snapshot.previewKey !== expectedPreviewKey)
        throw new UserFacingError("The source review changed. Preview these refinements again.");
      const compatible = new Map(snapshot.items.filter((item): item is Extract<CvRefinementRebaseItem,
        { status: "compatible" }> => item.status === "compatible").map(item => [item.id, item]));
      if (acceptedIds.some(id => !compatible.has(id)))
        throw new UserFacingError("Only exact compatible refinements can be carried forward. Review the conflicts.");
      let version = expectedVersion;
      for (const id of acceptedIds) {
        const prior = snapshot.active.find(row => row.id === id)!;
        const mapped = compatible.get(id)!;
        const saved = await appendCvRefinement(tx, { userId: user.id, contextId, expectedVersion: version,
          refinement: CvRefinementSchema.parse({ ...prior, version: prior.version + 1,
            target: mapped.target, ...(mapped.structured ? { structured: mapped.structured } : {}),
            dependencies: { descriptionVersionId: snapshot.to.descriptionVersionId,
              sourceIds: mapped.sourceIds, sourceHash: mapped.sourceHash,
              originBaselineId: snapshot.to.id } }) });
        version = saved.version;
      }
      return { version, rebasedIds: acceptedIds,
        conflicts: snapshot.items.filter((item): item is Extract<CvRefinementRebaseItem,
          { status: "conflict" }> => item.status === "conflict") };
    });
    revalidatePath(`/cv/context/${contextId}`);
    return { ok: true, ...result };
  } catch (error) {
    const result = actionError(error, "Could not carry these refinements forward. Please try again.");
    return { ok: false, error: result.ok ? "Could not carry these refinements forward." : result.error };
  }
}

type RefinementInput = { id?: string; kind: CvRefinementV1["kind"]; target: CvRefinementV1["target"];
  text?: string; bulletSignpost?: string | null; structured?: CvRefinementV1["structured"]; order: number;
  sourceKind: "baseline" | "draft"; sourceId: string };

function hasRefinementTarget(targets: CvEditingTargets, target: CvRefinementV1["target"]): boolean {
  if (target.type === "selection" || target.type === "appearance") return !target.id;
  if (target.type === "summary") return target.id === targets.summaryId;
  return targets.sections.some(section => target.type === "section" ? section.sectionId === target.id
    : target.type === "bullet" ? section.bulletIds.includes(target.id ?? "")
    : section.skillIds.includes(target.id ?? ""));
}

/** Reconstruct a pruned producer's exact review cache only under its pinned review contract. */
function retainedAutoAuditCache(baseline: typeof cvAutoBaselines.$inferSelect | null | undefined,
  content: CvContent | null | undefined, library: CvLibrary, description: string,
  settings: Awaited<ReturnType<typeof getSettingsFor>>) {
  const assessment = baseline?.assessment;
  if (!baseline?.content || !baseline.librarySnapshot || !content || !assessment ||
    canonicalJson(baseline.content) !== canonicalJson(content) ||
    canonicalJson(baseline.librarySnapshot) !== canonicalJson(library) ||
    !cvAssessmentCurrent(assessment, content, description, library) ||
    baseline.engineContract.promptSet !== promptSetVersion() ||
    baseline.engineContract.review !== CV_REVIEW_VERSION) return null;
  const route = resolveRoute(PROMPTS["cv.review"], settings.stageRoutes);
  const reviewRoute = { model: routedModel(route,
    { cvModel: settings.cvModel, callSite: settings.cvModel }, settings.cvModel), effort: route.effort };
  if (canonicalJson(baseline.engineContract.routes["cv.review"] ?? null) !== canonicalJson(reviewRoute)) return null;
  return { identity: cvSemanticAuditIdentity({ content, library, rubric: assessment.rubric,
    description, reviewRoute, reviewPromptVersion: PROMPTS["cv.review"].version, sourcePolicy: "legacy" }),
    review: assessment.review };
}

/** Saving a refinement is free; it changes only this context's versioned overlay. */
export async function saveCvRefinement(contextId: string, expectedVersion: number,
  input: RefinementInput): Promise<CvRefinementResult> {
  const user = await requireUser();
  try {
    if (!uuid.test(contextId) || !uuid.test(input.sourceId) ||
      (input.id && !uuid.test(input.id)) || !Number.isInteger(expectedVersion) || expectedVersion < 0)
      throw new UserFacingError("Reload this application before saving the refinement.");
    if (input.kind === "instruction" && (input.text?.trim().length ?? 0) > 2_000)
      throw new UserFacingError("Keep refinement instructions under 2,000 characters.");
    const result = await db().transaction(async tx => {
      const [context] = await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      if (!context?.currentDescriptionVersionId || context.refinementsVersion !== expectedVersion)
        throw new UserFacingError("These refinements changed. Reload the application before saving.");
      const [baseline] = input.sourceKind === "baseline" ? await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, input.sourceId), eq(cvAutoBaselines.contextId, contextId),
        eq(cvAutoBaselines.userId, user.id), eq(cvAutoBaselines.status, "ready"))) : [];
      const [draft] = input.sourceKind === "draft" ? await tx.select().from(cvDrafts).where(and(
        eq(cvDrafts.id, input.sourceId), eq(cvDrafts.contextId, contextId), eq(cvDrafts.userId, user.id))) : [];
      const [retained] = draft?.autoBaselineId ? await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, draft.autoBaselineId), eq(cvAutoBaselines.contextId, contextId),
        eq(cvAutoBaselines.userId, user.id), eq(cvAutoBaselines.status, "ready"))) : [];
      if (draft?.autoBaselineId && !retained)
        throw new UserFacingError("This refinement's Auto source is unavailable. Choose a saved edition.");
      const targets = baseline?.editingTargets ?? draft?.editingTargets;
      const content = baseline?.content ?? draft?.content;
      if (!targets || !content || (draft && draft.status !== "ready"))
        throw new UserFacingError("Save a complete CV edition before adding a refinement.");
      if ((baseline?.descriptionVersionId ?? draft?.descriptionVersionId) !== context.currentDescriptionVersionId)
        throw new UserFacingError("The role description changed. Open a current edition before refining it.");
      if (!hasRefinementTarget(targets, input.target))
        throw new UserFacingError("This CV item changed. Reload the edition before refining it.");
      // A generated Refine may have removed citations while applying exact wording. Its durable
      // Auto source still owns the target's factual dependency, including after several edits.
      const dependencySource = baseline ?? retained;
      const dependencyContent = dependencySource?.content ?? content;
      const dependencyTargets = dependencySource?.editingTargets ?? targets;
      if (!dependencyContent || !dependencyTargets || !hasRefinementTarget(dependencyTargets, input.target) ||
        (dependencySource && dependencySource.descriptionVersionId !== context.currentDescriptionVersionId))
        throw new UserFacingError("This refinement's Auto source changed. Review the selected item.");
      const dependencies = cvRefinementDependencies({ content: dependencyContent, targets: dependencyTargets,
        library: dependencySource?.librarySnapshot ?? draft!.librarySnapshot,
        descriptionVersionId: context.currentDescriptionVersionId, target: input.target,
        structured: input.structured });
      const existing = await currentCvRefinements(tx, user.id, contextId, true);
      const prior = input.id ? existing.find(row => row.id === input.id) : undefined;
      if (input.id && !prior) throw new UserFacingError("This refinement changed. Reload the application.");
      const row = CvRefinementSchema.parse({ id: input.id ?? randomUUID(), version: (prior?.version ?? 0) + 1,
        order: input.order, kind: input.kind, target: input.target,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...((input.bulletSignpost !== undefined ? input.bulletSignpost : prior?.bulletSignpost) !== undefined
          ? { bulletSignpost: input.bulletSignpost !== undefined ? input.bulletSignpost : prior?.bulletSignpost } : {}),
        ...(input.structured !== undefined ? { structured: input.structured } : {}),
        dependencies: { descriptionVersionId: context.currentDescriptionVersionId, ...dependencies,
          originBaselineId: (baseline ?? retained)?.id ?? null }, reset: false });
      return appendCvRefinement(tx, { userId: user.id, contextId, expectedVersion, refinement: row });
    });
    revalidatePath("/cv");
    return { ok: true, version: result.version };
  } catch (error) {
    const result = actionError(error, "Could not save this refinement. Please try again.");
    return { ok: false, error: result.ok ? "Could not save this refinement." : result.error };
  }
}

/** Save one exact edit and show it on a new ready edition, with no model call or CV credit. */
export async function saveAndUpdateCvExactRefinement(contextId: string, expectedOverlayVersion: number,
  source: { kind: "baseline" | "draft"; id: string; revision?: number },
  input: { id?: string; target: { type: "summary" | "section" | "bullet" | "skill"; id: string };
    text: string; bulletSignpost?: string | null; order: number; requestKey: string }): Promise<
  { ok: true; version: number; draftId: string; revision: number; charged: false } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    if (!uuid.test(contextId) || !uuid.test(source.id) || !uuid.test(input.target.id) ||
      !uuid.test(input.requestKey) || (input.id && !uuid.test(input.id)) ||
      !Number.isInteger(expectedOverlayVersion) || expectedOverlayVersion < 0 ||
      !Number.isInteger(input.order) || input.order < 0 || !input.text.trim() ||
      (source.kind === "draft" && (!Number.isInteger(source.revision) || source.revision! < 1)))
      throw new UserFacingError("Reload this CV before saving its exact wording.");
    if (input.bulletSignpost !== undefined && input.target.type !== "bullet")
      throw new UserFacingError("Only a bullet can have a title.");
    const checkedSignpost = input.bulletSignpost === undefined ? undefined : BulletSignpostSchema.safeParse(input.bulletSignpost);
    if (checkedSignpost && !checkedSignpost.success)
      throw new UserFacingError("Keep the bullet title to one line and 60 characters.");
    const bulletSignpost = checkedSignpost?.success ? checkedSignpost.data : undefined;
    const requestPrefix = `exact:${input.requestKey}:`;
    const requestIdentity = requestPrefix + createHash("sha256").update(canonicalJson({
      contextId, expectedOverlayVersion, source, target: input.target, text: input.text, bulletSignpost,
      order: input.order, refinementId: input.id ?? null,
    })).digest("hex");
    const outcome = await db().transaction(async tx => {
      const [context] = await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      if (!context) throw new UserFacingError("This application is unavailable.");
      const [priorResult] = await tx.select().from(cvDrafts).where(and(eq(cvDrafts.userId, user.id),
        eq(cvDrafts.contextId, contextId), sql`${cvDrafts.refinedResultKey} like ${requestPrefix + "%"}`)).limit(1);
      if (priorResult) {
        if (priorResult.refinedResultKey !== requestIdentity)
          throw new UserFacingError("This save request was already used for different wording. Reload this CV.");
        if (context.selectedKind !== "draft" || context.selectedId !== priorResult.id ||
          context.refinementsVersion !== expectedOverlayVersion + 1)
          throw new UserFacingError("The selected CV changed since this save. Reload before continuing.");
        return { version: context.refinementsVersion, draftId: priorResult.id,
          revision: priorResult.revision };
      }
      if (context.refinementsVersion !== expectedOverlayVersion ||
        context.selectedKind !== source.kind || context.selectedId !== source.id ||
        !context.currentDescriptionVersionId)
        throw new UserFacingError("The selected CV or its refinements changed. Reload before saving.");
      const [baseline] = source.kind === "baseline" ? await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, source.id), eq(cvAutoBaselines.userId, user.id),
        eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.status, "ready"))) : [];
      const [sourceDraft] = source.kind === "draft" ? await tx.select().from(cvDrafts).where(and(
        eq(cvDrafts.id, source.id), eq(cvDrafts.userId, user.id),
        eq(cvDrafts.contextId, contextId))).for("update") : [];
      if (sourceDraft && (sourceDraft.status !== "ready" || sourceDraft.revision !== source.revision))
        throw new UserFacingError("This saved CV changed. Reload before saving wording.");
      const activeDraftId = sourceDraft?.id ?? baseline?.sourceDraftId;
      if (activeDraftId) {
        const activeTask = await tx.execute<{ active: boolean }>(sql`select exists (
          select 1 from tasks where payload->>'draftId' = ${activeDraftId}
            and status in ('queued', 'running')
        ) as active`);
        if (activeTask.rows[0]?.active)
          throw new UserFacingError("Wait for this CV's current work to finish before updating its wording.");
      }
      const [retainedBaseline] = sourceDraft?.autoBaselineId ? await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, sourceDraft.autoBaselineId), eq(cvAutoBaselines.userId, user.id),
        eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.status, "ready"))) : [];
      if (sourceDraft?.autoBaselineId && !retainedBaseline)
        throw new UserFacingError("This CV's original Auto source is unavailable.");
      const authority = baseline ?? retainedBaseline ?? sourceDraft;
      const sourceContent = baseline?.content ?? sourceDraft?.content;
      const sourceTargets = baseline?.editingTargets ?? sourceDraft?.editingTargets;
      const library = baseline?.librarySnapshot ?? sourceDraft?.librarySnapshot;
      const descriptionVersionId = baseline?.descriptionVersionId ?? sourceDraft?.descriptionVersionId;
      if (!authority || !sourceContent || !sourceTargets || !library ||
        !descriptionVersionId || descriptionVersionId !== context.currentDescriptionVersionId ||
        !authority.content || !authority.editingTargets || !authority.librarySnapshot ||
        !hasRefinementTarget(authority.editingTargets, input.target) ||
        !hasRefinementTarget(sourceTargets, input.target))
        throw new UserFacingError("This CV item or role changed. Reload before saving wording.");
      const [description] = await tx.select().from(cvContextDescriptions).where(and(
        eq(cvContextDescriptions.id, descriptionVersionId), eq(cvContextDescriptions.contextId, contextId),
        eq(cvContextDescriptions.userId, user.id))).limit(1);
      if (!description) throw new UserFacingError("The saved role description is unavailable.");
      let projected: CvContent;
      try { projected = cvProjectOneExactWording({ content: sourceContent, targets: sourceTargets,
        target: input.target, text: input.text, bulletSignpost }); }
      catch (error) { throw new UserFacingError((error as Error).message); }
      if (canonicalJson(projected) === canonicalJson(sourceContent))
        throw new UserFacingError("This wording already matches the selected CV.");
      const active = await currentCvRefinements(tx, user.id, contextId, true);
      const onTarget = active.filter(row => row.kind === "exact_wording" &&
        row.target.type === input.target.type && row.target.id === input.target.id);
      if (onTarget.length > 1 || (input.id && onTarget.some(row => row.id !== input.id)))
        throw new UserFacingError("This item has conflicting exact edits. Review them before saving.");
      const existing = input.id ? active.find(row => row.id === input.id) : onTarget[0];
      if (input.id && (!existing || existing.kind !== "exact_wording" ||
        existing.target.type !== input.target.type || existing.target.id !== input.target.id))
        throw new UserFacingError("This exact edit changed. Reload before saving.");
      const dependencies = cvRefinementDependencies({ content: authority.content,
        targets: authority.editingTargets, library: authority.librarySnapshot,
        descriptionVersionId, target: input.target });
      const row = CvRefinementSchema.parse({ id: existing?.id ?? randomUUID(),
        version: (existing?.version ?? 0) + 1, order: input.order, kind: "exact_wording",
        target: input.target, text: input.text,
        ...((bulletSignpost !== undefined ? bulletSignpost : existing?.bulletSignpost) !== undefined
          ? { bulletSignpost: bulletSignpost !== undefined ? bulletSignpost : existing?.bulletSignpost } : {}),
        dependencies: {
          descriptionVersionId, ...dependencies, originBaselineId: baseline?.id ?? retainedBaseline?.id ?? null },
        reset: false });
      const saved = await appendCvRefinement(tx, { userId: user.id, contextId,
        expectedVersion: expectedOverlayVersion, refinement: row });
      const refinements = [...active.filter(item => item.id !== row.id), row];
      const revision = await nextCvRevision(tx, { userId: user.id, companyName: context.companyName,
        jobTitle: context.jobTitle, contextId });
      const rubricCheckpoint = cvRevisionRubricCheckpoint(baseline ? {
        jobDescription: description.text, assessment: baseline.assessment } : sourceDraft!, description.text);
      const [child] = await tx.insert(cvDrafts).values({ userId: user.id, contextId,
        descriptionVersionId, editingMode: "refine", parentId: sourceDraft?.id ?? null,
        autoBaselineId: baseline?.id ?? retainedBaseline?.id ?? null,
        jobId: context.jobId, jobTitle: context.jobTitle, companyName: context.companyName,
        jobDescription: description.text, jobSource: description.source,
        libraryVersion: sourceDraft?.libraryVersion ?? 1, librarySnapshot: library,
        model: sourceDraft?.model ?? baseline!.inputSnapshot.routes["cv.author"]?.model ?? "manual",
        revision, status: "ready", content: projected, editingTargets: sourceTargets,
        refinementSnapshot: refinements, refinedResultKey: requestIdentity,
        appliedRefinements: [...(sourceDraft?.appliedRefinements ?? []).filter(item => item.id !== row.id),
          { id: row.id, version: row.version }],
        refinementSourceContent: sourceContent, refinementSourceTargets: sourceTargets,
        refinementEngineContract: sourceDraft?.refinementEngineContract ?? baseline?.engineContract ?? null,
        refinementOriginKind: baseline || retainedBaseline ? "baseline" : "manual",
        targetingBrief: sourceDraft?.targetingBrief ?? null,
        buildCheckpoint: rubricCheckpoint, semanticAuditCache: sourceDraft?.semanticAuditCache ?? null,
        assessment: null,
      }).returning({ id: cvDrafts.id });
      const plan = baseline?.tailoringPlan ?? (sourceDraft ? (await tx.select({ plan: cvTailoringPlans.plan })
        .from(cvTailoringPlans).where(and(eq(cvTailoringPlans.draftId, sourceDraft.id),
          eq(cvTailoringPlans.userId, user.id))).limit(1))[0]?.plan : null);
      if (plan) await saveCvTailoringPlan(tx, child!.id, user.id, plan);
      await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: child!.id })
        .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
      return { version: saved.version, draftId: child!.id, revision };
    });
    revalidatePath("/cv");
    return { ok: true, ...outcome, charged: false };
  } catch (error) {
    const result = actionError(error, "Could not save and update this CV. Please try again.");
    return { ok: false, error: result.ok ? "Could not save and update this CV." : result.error };
  }
}

/** A reset is a tombstone event, so an older result remains inspectable. */
export async function resetCvRefinement(contextId: string, expectedVersion: number,
  refinementId?: string): Promise<CvRefinementResult> {
  const user = await requireUser();
  try {
    if (!uuid.test(contextId) || (refinementId && !uuid.test(refinementId)) ||
      !Number.isInteger(expectedVersion) || expectedVersion < 0)
      throw new UserFacingError("Reload this application before resetting refinements.");
    const version = await db().transaction(async tx => {
      const active = await currentCvRefinements(tx, user.id, contextId);
      const selected = refinementId ? active.filter(row => row.id === refinementId) : active;
      if (refinementId && !selected.length) throw new UserFacingError("This refinement is no longer active.");
      let current = expectedVersion;
      if (!selected.length) {
        const [context] = await tx.select().from(cvApplicationContexts).where(and(
          eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
        if (!context || context.refinementsVersion !== expectedVersion)
          throw new UserFacingError("These refinements changed. Reload the application.");
      }
      for (const row of selected) {
        const saved = await appendCvRefinement(tx, { userId: user.id, contextId, expectedVersion: current,
          refinement: { ...row, version: row.version + 1, reset: true } });
        current = saved.version;
      }
      const [context] = !refinementId ? await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update") : [];
      if (context?.selectedKind === "draft" && context.selectedId) {
        const [selectedDraft] = await tx.select({ baselineId: cvDrafts.autoBaselineId }).from(cvDrafts)
          .where(and(eq(cvDrafts.id, context.selectedId), eq(cvDrafts.contextId, contextId),
            eq(cvDrafts.userId, user.id)));
        if (selectedDraft?.baselineId) await tx.update(cvApplicationContexts)
          .set({ selectedKind: "baseline", selectedId: selectedDraft.baselineId })
          .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
      }
      return current;
    });
    revalidatePath("/cv");
    return { ok: true, version };
  } catch (error) {
    const result = actionError(error, "Could not reset refinements. Please try again.");
    return { ok: false, error: result.ok ? "Could not reset refinements." : result.error };
  }
}

/** Manual begins without a model call or a fabricated CV claim. A complete first Save supplies content. */
export async function createManualCvEdition(contextId: string, expectedDescriptionVersionId: string,
  selectedSource?: { kind: "baseline" | "draft"; id: string } | null): Promise<{ ok: true; draftId: string; charged: false } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    if (!uuid.test(contextId) || !uuid.test(expectedDescriptionVersionId) ||
      (selectedSource && !uuid.test(selectedSource.id)))
      throw new UserFacingError("This application changed. Reload it before starting Manual.");
    const draftId = await db().transaction(async tx => {
      const [context] = await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      if (!context || context.currentDescriptionVersionId !== expectedDescriptionVersionId)
        throw new UserFacingError("The role description changed. Reload before starting Manual.");
      const [description] = await tx.select().from(cvContextDescriptions).where(and(
        eq(cvContextDescriptions.id, expectedDescriptionVersionId), eq(cvContextDescriptions.contextId, contextId),
        eq(cvContextDescriptions.userId, user.id)));
      if (!description) throw new UserFacingError("The saved role description is unavailable.");
      const [source] = selectedSource?.kind === "draft" ? await tx.select().from(cvDrafts).where(and(
        eq(cvDrafts.id, selectedSource.id), eq(cvDrafts.userId, user.id), eq(cvDrafts.contextId, contextId))) : [];
      const [baseline] = selectedSource?.kind === "baseline" ? await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, selectedSource.id), eq(cvAutoBaselines.userId, user.id),
        eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.status, "ready"))) : [];
      if (selectedSource && (!(source || baseline) || !(source?.content ?? baseline?.content) ||
        (source && source.status !== "ready")))
        throw new UserFacingError("The source CV is no longer ready to copy.");
      const [sourceBaseline] = source?.autoBaselineId && !baseline ? await tx.select().from(cvAutoBaselines)
        .where(and(eq(cvAutoBaselines.id, source.autoBaselineId), eq(cvAutoBaselines.contextId, contextId),
          eq(cvAutoBaselines.userId, user.id), eq(cvAutoBaselines.status, "ready"))) : [];
      const retained = baseline ?? sourceBaseline;
      const [sourcePlan] = source ? await tx.select({ plan: cvTailoringPlans.plan }).from(cvTailoringPlans)
        .where(and(eq(cvTailoringPlans.draftId, source.id), eq(cvTailoringPlans.userId, user.id))) : [];
      const latest = source || baseline ? null : await latestLibrary(tx, user.id);
      const [account] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, user.id));
      const fallback = CvLibrarySchema.parse({ name: account?.name?.trim() || account?.email.split("@")[0] || "Candidate",
        contact: "", profile: "", entries: [] });
      const library = source?.librarySnapshot ?? baseline?.librarySnapshot ?? latest?.content ?? fallback;
      const copiedContent = source?.content ?? baseline?.content ?? null;
      const settings = await getSettingsFor(user.id, tx);
      const possibleAssessment = source?.assessment ?? retained?.assessment ?? null;
      const assessment = copiedContent && possibleAssessment &&
        cvAssessmentCurrent(possibleAssessment, copiedContent, description.text, CvLibrarySchema.parse(library))
        ? possibleAssessment : null;
      const reconstructedCache = retainedAutoAuditCache(retained, copiedContent,
        CvLibrarySchema.parse(library), description.text, settings);
      const rubricCheckpoint = copiedContent ? cvRevisionRubricCheckpoint(source ?? {
        jobDescription: description.text, assessment: retained?.assessment }, description.text) : null;
      const revision = await nextCvRevision(tx, { userId: user.id, companyName: context.companyName,
        jobTitle: context.jobTitle, contextId });
      const [draft] = await tx.insert(cvDrafts).values({ userId: user.id, contextId,
        descriptionVersionId: description.id, editingMode: "manual", parentId: source?.id ?? baseline?.sourceDraftId ?? null,
        jobId: context.jobId, jobTitle: context.jobTitle, companyName: context.companyName,
        jobDescription: description.text, jobSource: description.source,
        libraryVersion: source?.libraryVersion ?? latest?.version ?? 0,
        librarySnapshot: CvLibrarySchema.parse(library), model: source?.model ?? settings.cvModel,
        revision, status: "ready", content: copiedContent, assessment,
        semanticAuditCache: source?.semanticAuditCache ?? reconstructedCache,
        buildCheckpoint: rubricCheckpoint,
        editingTargets: source?.editingTargets ?? baseline?.editingTargets ?? null,
        targetingBrief: source?.targetingBrief ?? null,
      }).returning({ id: cvDrafts.id });
      const plan = sourcePlan?.plan ?? retained?.tailoringPlan;
      if (plan) await saveCvTailoringPlan(tx, draft!.id, user.id, plan);
      await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: draft!.id })
        .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
      return draft!.id;
    });
    revalidatePath("/cv");
    return { ok: true, draftId, charged: false };
  } catch (error) {
    const result = actionError(error, "Could not start Manual. Please try again.");
    return { ok: false, error: result.ok ? "Could not start Manual." : result.error };
  }
}

/** A Manual Save forks a ready revision and never changes confirmed Experience or requests AI. */
export async function saveManualCvEdition(draftId: string, expectedRevision: number,
  rawContent: unknown, rawTargets?: unknown): Promise<{ ok: true; draftId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    if (!uuid.test(draftId) || !Number.isInteger(expectedRevision) || expectedRevision < 0)
      throw new UserFacingError("Reload this Manual CV before saving.");
    const content = CvContentSchema.parse(rawContent);
    const childId = await db().transaction(async tx => {
      const [probe] = await tx.select({ contextId: cvDrafts.contextId }).from(cvDrafts).where(and(
        eq(cvDrafts.id, draftId), eq(cvDrafts.userId, user.id)));
      if (!probe?.contextId) throw new UserFacingError("This Manual CV is unavailable.");
      const [context] = await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, probe.contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      const [source] = await tx.select().from(cvDrafts).where(and(eq(cvDrafts.id, draftId),
        eq(cvDrafts.userId, user.id))).for("update");
      if (!source || source.editingMode !== "manual" || !source.contextId || source.status !== "ready" ||
        source.revision !== expectedRevision)
        throw new UserFacingError("This Manual CV changed. Reload it before saving.");
      // Manual wording stays pinned to its saved advert even when this context gains a newer JD.
      if (!context || source.contextId !== context.id || context.selectedKind !== "draft" || context.selectedId !== source.id)
        throw new UserFacingError("The selected application changed. Reload it before saving.");
      if (source.content && source.editingTargets && !rawTargets)
        throw new UserFacingError("Reload this Manual CV to preserve its item targets before saving.");
      const targets = rawTargets && source.content && source.editingTargets
        ? validateCvEditingTargetTransition(source.content, source.editingTargets, content, rawTargets)
        : cvEditingTargetsFor(content, randomUUID);
      const assessment = source.assessment && cvAssessmentCurrent(source.assessment, content,
        source.jobDescription, source.librarySnapshot) ? source.assessment : null;
      const rubricCheckpoint = cvRevisionRubricCheckpoint(source, source.jobDescription);
      const revision = await nextCvRevision(tx, { userId: user.id, companyName: source.companyName,
        jobTitle: source.jobTitle, contextId: source.contextId });
      const [child] = await tx.insert(cvDrafts).values({ userId: user.id, contextId: source.contextId,
        descriptionVersionId: source.descriptionVersionId, editingMode: "manual", parentId: source.id,
        jobId: source.jobId, jobTitle: source.jobTitle, companyName: source.companyName,
        jobDescription: source.jobDescription, jobSource: source.jobSource,
        libraryVersion: source.libraryVersion, librarySnapshot: source.librarySnapshot,
        model: source.model, revision, status: "ready", content, editingTargets: targets,
        assessment, semanticAuditCache: source.semanticAuditCache, buildCheckpoint: rubricCheckpoint,
        targetingBrief: source.targetingBrief,
      }).returning({ id: cvDrafts.id });
      const [plan] = await tx.select({ plan: cvTailoringPlans.plan }).from(cvTailoringPlans)
        .where(and(eq(cvTailoringPlans.draftId, source.id), eq(cvTailoringPlans.userId, user.id)));
      if (plan) await saveCvTailoringPlan(tx, child!.id, user.id, plan.plan);
      await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: child!.id })
        .where(and(eq(cvApplicationContexts.id, context.id), eq(cvApplicationContexts.userId, user.id)));
      return child!.id;
    });
    revalidatePath("/cv");
    return { ok: true, draftId: childId };
  } catch (error) {
    const result = actionError(error, "Could not save this Manual CV. Please try again.");
    return { ok: false, error: result.ok ? "Could not save this Manual CV." : result.error };
  }
}

/** A Refine request freezes its overlay and source. A cache hit never reserves a second credit. */
export async function generateRefinedCv(contextId: string, expectedVersion: number,
  sourceKind: "baseline" | "draft", sourceId: string): Promise<AutoCvResult> {
  const user = await requireVerifiedUser();
  try {
    if (!uuid.test(contextId) || !uuid.test(sourceId) || !Number.isInteger(expectedVersion) || expectedVersion < 0)
      throw new UserFacingError("Reload this application before generating a refined CV.");
    const outcome = await db().transaction(async tx => {
      await lockCvBuildCapacity(tx, user.id);
      const [context] = await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      if (!context?.currentDescriptionVersionId || context.refinementsVersion !== expectedVersion)
        throw new UserFacingError("The role or its refinements changed. Reload before generating.");
      const [baseline] = sourceKind === "baseline" ? await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, sourceId), eq(cvAutoBaselines.contextId, contextId),
        eq(cvAutoBaselines.userId, user.id), eq(cvAutoBaselines.status, "ready"))) : [];
      const [sourceDraft] = sourceKind === "draft" ? await tx.select().from(cvDrafts).where(and(
        eq(cvDrafts.id, sourceId), eq(cvDrafts.contextId, contextId), eq(cvDrafts.userId, user.id))) : [];
      const [retainedBaseline] = sourceDraft?.autoBaselineId ? await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, sourceDraft.autoBaselineId), eq(cvAutoBaselines.contextId, contextId),
        eq(cvAutoBaselines.userId, user.id), eq(cvAutoBaselines.status, "ready"))) : [];
      const base = baseline ?? retainedBaseline;
      const parentId = baseline?.sourceDraftId ?? sourceDraft?.id;
      const sourceContent = base?.content ?? sourceDraft?.content;
      const library = base?.librarySnapshot ?? sourceDraft?.librarySnapshot;
      const sourceDescriptionVersionId = base?.descriptionVersionId ?? sourceDraft?.descriptionVersionId;
      if (!sourceContent || !library || !sourceDescriptionVersionId ||
        (sourceDraft && sourceDraft.status !== "ready"))
        throw new UserFacingError("Save a complete source edition before generating a refinement.");
      if (sourceDescriptionVersionId !== context.currentDescriptionVersionId)
        throw new UserFacingError("The role description changed. Update the source edition before generating.");
      const [description] = await tx.select().from(cvContextDescriptions).where(and(
        eq(cvContextDescriptions.id, sourceDescriptionVersionId), eq(cvContextDescriptions.contextId, contextId),
        eq(cvContextDescriptions.userId, user.id)));
      if (!description) throw new UserFacingError("The saved role description is unavailable.");
      const sourceHash = base ? base.inputKey : cvRefinementSourceIdentity({ content: sourceContent,
        librarySnapshot: library, jobDescription: sourceDraft!.jobDescription,
        descriptionVersionId: sourceDescriptionVersionId });
      const originKind = base ? "baseline" as const : "manual" as const;
      const refinements = await currentCvRefinements(tx, user.id, contextId);
      if (!refinements.length) throw new UserFacingError("Save at least one refinement before generating.");
      const sourceTargets = base?.editingTargets ?? sourceDraft?.editingTargets;
      if (!sourceTargets || refinements.some(row => {
        const actual = cvRefinementDependencies({ content: sourceContent, targets: sourceTargets,
          library, descriptionVersionId: sourceDescriptionVersionId, target: row.target,
          structured: row.structured });
        return row.dependencies.sourceHash !== actual.sourceHash ||
          row.dependencies.descriptionVersionId !== sourceDescriptionVersionId;
      }))
        throw new UserFacingError("A refinement belongs to an earlier source. Review its conflict before generating.");
      const contracts = { promptSet: promptSetVersion(), review: CV_REVIEW_VERSION,
        fit: CV_FIT_VERSION, render: CV_RENDER_VERSION };
      const settings = await getSettingsFor(user.id, tx);
      const routes = Object.fromEntries(CV_PROMPT_IDS.map(id => {
        const route = resolveRoute(PROMPTS[id], settings.stageRoutes);
        return [id, { model: routedModel(route, { cvModel: settings.cvModel, callSite: settings.cvModel }, settings.cvModel),
          effort: route.effort }];
      })) as CvAutoInputV1["routes"];
      const engineContract = { ...contracts, routes };
      const sourceLibraryVersion = sourceDraft?.libraryVersion && sourceDraft.libraryVersion > 0
        ? sourceDraft.libraryVersion : 1;
      const sourceModel = sourceDraft?.model ?? settings.cvModel;
      const rubricCompatible = base
        ? base.engineContract.promptSet === contracts.promptSet &&
          canonicalJson(base.engineContract.routes["cv.rubric"] ?? null) === canonicalJson(routes["cv.rubric"] ?? null)
        : sourceDraft?.model === settings.cvModel;
      const rubricCheckpoint = rubricCompatible ? cvRevisionRubricCheckpoint(base ? {
        jobDescription: description.text, assessment: base.assessment } : sourceDraft!, description.text) : null;
      const targetingChoice = [...refinements].reverse().find(row => row.kind === "structured" &&
        row.structured?.kind === "targeting")?.structured;
      const priorBrief = !base && sourceDraft?.targetingBrief
        ? CvTargetingBriefSchema.parse(sourceDraft.targetingBrief) : null;
      let targetingBrief = priorBrief;
      if (targetingChoice?.kind === "targeting") {
        if (!rubricCheckpoint?.sourceRubric)
          throw new UserFacingError("Check the source CV's role requirements before applying these priority choices.");
        const originalRubric = validateCvRubric(description.text, rubricCheckpoint.sourceRubric);
        const choices = targetingChoice.choices;
        const source = cvTargetingSource(sourceLibraryVersion, library, description.text);
        targetingBrief = CvTargetingBriefSchema.parse({ version: 1, source,
          entries: choices.entries, presentation: choices.presentation,
          priority: { state: "confirmed", rubric: originalRubric,
            rubricKey: cvTargetingRubricKey(source, originalRubric, sourceModel, promptSetVersion()),
            emphasisRequirementIds: choices.emphasisRequirementIds,
            ...(choices.requirements ? { requirements: cvRankedPriorityChoices(originalRubric, choices.requirements) } : {}),
            acknowledgedEssentialOmissionIds: choices.acknowledgedEssentialOmissionIds },
          manualSections: sourceContent.sections });
      }
      const [sourcePlan] = sourceDraft ? await tx.select({ plan: cvTailoringPlans.plan }).from(cvTailoringPlans)
        .where(and(eq(cvTailoringPlans.draftId, sourceDraft.id), eq(cvTailoringPlans.userId, user.id))) : [];
      const reusablePlan = targetingChoice ? null : base?.tailoringPlan ?? sourcePlan?.plan ?? null;
      const reusableCache = retainedAutoAuditCache(base, sourceContent,
        library, description.text, settings) ?? (!base ? sourceDraft?.semanticAuditCache : null);
      const key = cvRefinedResultKey(sourceHash, refinements, engineContract);
      const [existing] = await tx.select().from(cvDrafts).where(and(eq(cvDrafts.userId, user.id),
        eq(cvDrafts.contextId, contextId), eq(cvDrafts.refinedResultKey, key))).for("update");
      if (existing) {
        await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: existing.id })
          .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
        return { status: existing.status === "ready" ? "ready" as const :
        existing.status === "failed" ? "failed" as const : "queued" as const,
        draftId: existing.id, charged: false };
      }
      const instructions = refinements.filter(row => row.kind === "instruction");
      if (originKind === "baseline" && !instructions.length) {
        const projected = cvProjectRefinements({ content: sourceContent, targets: sourceTargets,
          library, refinements, descriptionVersionId: sourceDescriptionVersionId, sourceHash });
        if (projected.conflicts.length)
          throw new UserFacingError("An exact refinement conflicts with this Auto source. Review the affected wording.");
        const revision = await nextCvRevision(tx, { userId: user.id, companyName: context.companyName,
          jobTitle: context.jobTitle, contextId });
        const [free] = await tx.insert(cvDrafts).values({ userId: user.id, contextId,
          descriptionVersionId: description.id, editingMode: "refine", parentId,
          autoBaselineId: base?.id ?? null,
          jobId: context.jobId, jobTitle: context.jobTitle, companyName: context.companyName,
          jobDescription: description.text, jobSource: description.source,
          libraryVersion: sourceLibraryVersion, librarySnapshot: library,
          model: sourceModel,
          revision, status: "ready", content: projected.content, editingTargets: projected.targets,
          refinementSnapshot: refinements, refinedResultKey: key,
          refinementSourceContent: sourceContent, refinementSourceTargets: sourceTargets,
          refinementEngineContract: engineContract,
          refinementOriginKind: originKind,
          targetingBrief,
          buildCheckpoint: rubricCheckpoint,
          assessment: !targetingChoice && (base?.assessment ?? sourceDraft?.assessment) && cvAssessmentCurrent(
            base?.assessment ?? sourceDraft?.assessment, projected.content, description.text, library)
            ? base?.assessment ?? sourceDraft?.assessment : null,
          semanticAuditCache: reusableCache,
        }).returning({ id: cvDrafts.id });
        if (reusablePlan) await saveCvTailoringPlan(tx, free!.id, user.id, reusablePlan);
        await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: free!.id })
          .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
        return { status: "ready" as const, draftId: free!.id, charged: false };
      }
      await assertCvBuildCapacity(tx, user.id);
      const revision = await nextCvRevision(tx, { userId: user.id, companyName: context.companyName,
        jobTitle: context.jobTitle, contextId });
      const [draft] = await tx.insert(cvDrafts).values({ userId: user.id, contextId,
        descriptionVersionId: description.id, editingMode: "refine", parentId,
        autoBaselineId: base?.id ?? null,
        jobId: context.jobId, jobTitle: context.jobTitle, companyName: context.companyName,
        jobDescription: description.text, jobSource: description.source,
        libraryVersion: sourceLibraryVersion, librarySnapshot: library,
        model: sourceModel, revision, status: "queued",
        refinementSnapshot: refinements, refinedResultKey: key,
        refinementSourceContent: sourceContent, refinementSourceTargets: sourceTargets,
        refinementEngineContract: engineContract,
        refinementOriginKind: originKind,
        editingTargets: sourceTargets, targetingBrief,
        buildCheckpoint: { tailoringEnabled: true, quizCompleted: true,
          ...(rubricCheckpoint ?? {}),
          ...(reusablePlan ? { tailoringPlan: reusablePlan } : {}) },
      }).returning({ id: cvDrafts.id });
      await reserveCvCredit(tx, user.id, draft!.id);
      await enqueue("generate_cv", { draftId: draft!.id, userId: user.id }, tx);
      await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: draft!.id })
        .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
      return { status: "queued" as const, draftId: draft!.id, charged: true };
    });
    revalidatePath("/cv");
    return { ok: true, ...outcome };
  } catch (error) {
    const result = actionError(error, "Could not generate this refinement. Please try again.");
    return { ok: false, error: result.ok ? "Could not generate this refinement." : result.error };
  }
}

/** A retained Auto artefact can become an editable/finalisable edition without another build. */
export async function openCvAutoEdition(contextId: string, baselineId: string): Promise<{
  ok: true; draftId: string; revision: number; baseHash: string; charged: false } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    if (!uuid.test(contextId) || !uuid.test(baselineId))
      throw new UserFacingError("This Auto result could not be found.");
    const edition = await db().transaction(async tx => {
      const [context] = await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      if (!context) throw new UserFacingError("This application could not be found.");
      const [baseline] = await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, baselineId), eq(cvAutoBaselines.contextId, contextId),
        eq(cvAutoBaselines.userId, user.id), eq(cvAutoBaselines.status, "ready")));
      if (!baseline?.content || !baseline.librarySnapshot || !baseline.editingTargets)
        throw new UserFacingError("This Auto result is not ready.");
      if (baseline.engineContract.render !== CV_RENDER_VERSION)
        throw new UserFacingError("This Auto result uses an earlier PDF layout. Request an Auto update or copy it into Manual.");
      const [held] = await tx.select().from(cvDrafts).where(and(
        eq(cvDrafts.userId, user.id), eq(cvDrafts.contextId, contextId),
        eq(cvDrafts.autoBaselineId, baseline.id), eq(cvDrafts.editingMode, "auto"),
        eq(cvDrafts.status, "ready"))).orderBy(desc(cvDrafts.createdAt)).limit(1);
      if (held) {
        await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: held.id })
          .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
        return { draftId: held.id, revision: held.revision,
          baseHash: cvDraftEditBaseHash(held.content, held.targetingBrief) };
      }
      const [description] = await tx.select().from(cvContextDescriptions).where(and(
        eq(cvContextDescriptions.id, baseline.descriptionVersionId), eq(cvContextDescriptions.contextId, contextId),
        eq(cvContextDescriptions.userId, user.id)));
      if (!description) throw new UserFacingError("This Auto result's role description is unavailable.");
      const revision = await nextCvRevision(tx, { userId: user.id, companyName: context.companyName,
        jobTitle: context.jobTitle, contextId });
      const [draft] = await tx.insert(cvDrafts).values({ userId: user.id, contextId,
        descriptionVersionId: baseline.descriptionVersionId, editingMode: "auto", autoBaselineId: baseline.id,
        jobId: context.jobId, jobTitle: context.jobTitle, companyName: context.companyName,
        jobDescription: description.text, jobSource: description.source,
        libraryVersion: 0, librarySnapshot: baseline.librarySnapshot,
        model: baseline.inputSnapshot.routes["cv.author"]?.model ?? (await getSettingsFor(user.id, tx)).cvModel,
        revision, status: "ready", content: baseline.content, assessment: baseline.assessment,
        editingTargets: baseline.editingTargets,
      }).returning({ id: cvDrafts.id });
      if (baseline.tailoringPlan) await saveCvTailoringPlan(tx, draft!.id, user.id, baseline.tailoringPlan);
      await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: draft!.id })
        .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
      return { draftId: draft!.id, revision,
        baseHash: cvDraftEditBaseHash(baseline.content, null) };
    });
    revalidatePath("/cv");
    return { ok: true, ...edition, charged: false };
  } catch (error) {
    const result = actionError(error, "Could not open this Auto CV. Please try again.");
    return { ok: false, error: result.ok ? "Could not open this Auto CV." : result.error };
  }
}

/** History selection is explicit and account scoped; no background task changes this pointer. */
export async function selectCvEdition(contextId: string, kind: "baseline" | "draft", id: string): Promise<{
  ok: true; kind: "baseline" | "draft"; id: string } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    if (!uuid.test(contextId) || !uuid.test(id) || (kind !== "baseline" && kind !== "draft"))
      throw new UserFacingError("This CV edition could not be found.");
    await db().transaction(async tx => {
      const [context] = await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      if (!context) throw new UserFacingError("This application could not be found.");
      const [owned] = kind === "baseline" ? await tx.select({ id: cvAutoBaselines.id }).from(cvAutoBaselines)
        .where(and(eq(cvAutoBaselines.id, id), eq(cvAutoBaselines.contextId, contextId),
          eq(cvAutoBaselines.userId, user.id)))
        : await tx.select({ id: cvDrafts.id }).from(cvDrafts).where(and(eq(cvDrafts.id, id),
          eq(cvDrafts.contextId, contextId), eq(cvDrafts.userId, user.id)));
      if (!owned) throw new UserFacingError("This CV edition could not be found.");
      await tx.update(cvApplicationContexts).set({ selectedKind: kind, selectedId: id })
        .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
    });
    revalidatePath(`/cv/context/${contextId}`);
    return { ok: true, kind, id };
  } catch (error) {
    const result = actionError(error, "Could not select this CV. Please try again.");
    return { ok: false, error: result.ok ? "Could not select this CV." : result.error };
  }
}

/** Optional source choices are loaded on demand, without generating or reserving a credit. */
export async function readAutoCvSourceChoices(contextId: string): Promise<{
  ok: true; conflicts: CareerCvProjection["reviewConflicts"];
} | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    if (!uuid.test(contextId)) throw new UserFacingError("This application could not be found.");
    const [description] = await db().select({ text: cvContextDescriptions.text })
      .from(cvApplicationContexts).innerJoin(cvContextDescriptions,
        and(eq(cvContextDescriptions.id, cvApplicationContexts.currentDescriptionVersionId),
          eq(cvContextDescriptions.contextId, cvApplicationContexts.id), eq(cvContextDescriptions.userId, user.id)))
      .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
    if (!description) throw new UserFacingError("This application has no saved role description.");
    await ensureCareerBackfill(db(), user.id);
    const career = await db().transaction(async tx => {
      await lockAccountScoreInput(tx as unknown as Db, user.id, "shared");
      return latestCareerCvEvidence(tx as unknown as Db, user.id, { roleText: description.text });
    });
    return { ok: true, conflicts: career.reviewConflicts };
  } catch (error) {
    const result = actionError(error, "Could not load Experience choices. Your saved CV is unchanged.");
    return { ok: false, error: result.ok ? "Could not load Experience choices." : result.error };
  }
}

/** `open` never reserves; `update` is the person's deliberate request for the current inputs. */
export async function openOrClaimAutoCv(contextId: string, intent: "open" | "update",
  conflictChoices: CareerCvChoiceOverride[] = []): Promise<AutoCvResult> {
  const user = intent === "update" ? await requireVerifiedUser() : await requireUser();
  let sourceReview: CareerCvProjection["reviewConflicts"] | undefined;
  try {
    if (!uuid.test(contextId) || (intent !== "open" && intent !== "update"))
      throw new UserFacingError("This application could not be found.");
    const parsedChoices = CareerCvChoiceOverrideSchema.array().max(100).safeParse(conflictChoices);
    if (!parsedChoices.success || new Set(parsedChoices.data.map(choice => choice.groupKey)).size !== parsedChoices.data.length)
      throw new UserFacingError("Reload Experience choices before updating Auto.");
    if (intent === "open") {
      const [context] = await db().select().from(cvApplicationContexts)
        .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
      if (!context) throw new UserFacingError("This application could not be found.");
      const [selected] = context.selectedKind === "baseline" && context.selectedId
        ? await db().select().from(cvAutoBaselines).where(and(eq(cvAutoBaselines.id, context.selectedId),
          eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.userId, user.id))) : [];
      const [selectedDraft] = context.selectedKind === "draft" && context.selectedId
        ? await db().select({ autoBaselineId: cvDrafts.autoBaselineId }).from(cvDrafts).where(and(
          eq(cvDrafts.id, context.selectedId), eq(cvDrafts.contextId, contextId), eq(cvDrafts.userId, user.id))) : [];
      const [linked] = selectedDraft?.autoBaselineId ? await db().select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, selectedDraft.autoBaselineId), eq(cvAutoBaselines.contextId, contextId),
        eq(cvAutoBaselines.userId, user.id))) : [];
      const [latest] = !context.selectedId ? await db().select().from(cvAutoBaselines)
        .where(and(eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.userId, user.id)))
        .orderBy(desc(cvAutoBaselines.createdAt)).limit(1) : [];
      const held = selected ?? linked ?? latest;
      return held ? { ok: true, status: held.status, baselineId: held.id,
        draftId: held.sourceDraftId, updateAvailable: null, charged: false }
        : { ok: true, status: "missing", charged: false };
    }
    await ensureCareerBackfill(db(), user.id);
    const outcome = await db().transaction(async tx => {
      // A build pins both career facts and contact/preferences while their writers wait.
      await lockAccountScoreInput(tx as unknown as Db, user.id, "shared");
      await lockCvBuildCapacity(tx, user.id);
      const [context] = await tx.select().from(cvApplicationContexts)
        .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      if (!context?.currentDescriptionVersionId) throw new UserFacingError("This application has no saved role description.");
      const [description] = await tx.select().from(cvContextDescriptions)
        .where(and(eq(cvContextDescriptions.id, context.currentDescriptionVersionId),
          eq(cvContextDescriptions.contextId, context.id), eq(cvContextDescriptions.userId, user.id)));
      if (!description) throw new UserFacingError("Reload the current role description before updating Auto.");
      const latest = await latestLibrary(tx, user.id);
      const settings = await getSettingsFor(user.id, tx);
      const career = await latestCareerCvEvidence(tx as unknown as Db, user.id,
        { roleText: description.text, conflictChoices: parsedChoices.data }, settings.cvTheme?.experienceLayout);
      sourceReview = career.reviewConflicts;
      const model = settings.cvModel;
      if (!isKnownModel(model) || model === modelForCallSite(settings, "A3"))
        throw new UserFacingError("Choose a supported CV model in Settings before generating.");
      const explicitTheme = settings.cvTheme ?? (canonicalJson(CvThemeSchema.parse(career.library.theme ?? DEFAULT_CV_THEME))
        !== canonicalJson(DEFAULT_CV_THEME) ? career.library.theme : undefined);
      const theme = { ...(explicitTheme ?? career.library.theme ?? DEFAULT_CV_THEME),
        maxPages: explicitTheme?.maxPages ?? 2, bodySizePt: explicitTheme?.bodySizePt ?? 12 };
      const library = groupCvLibrary(CvLibrarySchema.parse({ ...career.library,
        ...(settings.cvWritingPreferences ?? {}), theme }));
      const routes = Object.fromEntries(CV_PROMPT_IDS.map(id => {
        const route = resolveRoute(PROMPTS[id], settings.stageRoutes);
        return [id, { model: routedModel(route, { cvModel: model, callSite: model }, model), effort: route.effort }];
      }));
      const contracts = { promptSet: promptSetVersion(), review: CV_REVIEW_VERSION,
        fit: CV_FIT_VERSION, render: CV_RENDER_VERSION };
      const autoInput: CvAutoInputV1 = { version: 1, contextId: context.id,
        descriptionVersionId: description.id, jobTitle: context.jobTitle, companyName: context.companyName,
        description: description.text, library, basePriorityIdentity: "source-default",
        appearance: library.theme, writingPreferences: settings.cvWritingPreferences ?? {}, routes, contracts };
      const inputKey = cvAutoInputKey(autoInput);
      const claim = await claimCvAutoBaseline(tx, { userId: user.id, contextId: context.id,
        descriptionVersionId: description.id, inputKey, inputSnapshot: autoInput,
        engineContract: { ...contracts, routes } });
      if (claim.hit) {
        await tx.update(cvApplicationContexts).set({ selectedKind: "baseline", selectedId: claim.baseline.id })
          .where(and(eq(cvApplicationContexts.id, context.id), eq(cvApplicationContexts.userId, user.id)));
        return { status: "ready" as const, baselineId: claim.baseline.id, draftId: claim.baseline.sourceDraftId, charged: false };
      }
      if (!claim.created) {
        await tx.update(cvApplicationContexts).set({ selectedKind: claim.baseline.sourceDraftId ? "draft" : "baseline",
          selectedId: claim.baseline.sourceDraftId ?? claim.baseline.id })
          .where(and(eq(cvApplicationContexts.id, context.id), eq(cvApplicationContexts.userId, user.id)));
        return { status: claim.baseline.status === "failed" ? "failed" as const : "queued" as const,
          baselineId: claim.baseline.id, draftId: claim.baseline.sourceDraftId, charged: false };
      }
      await assertCvBuildCapacity(tx, user.id);
      const revision = await nextCvRevision(tx, { userId: user.id, companyName: context.companyName,
        jobTitle: context.jobTitle, contextId: context.id });
      const [previous] = await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.userId, user.id), eq(cvAutoBaselines.contextId, context.id),
        eq(cvAutoBaselines.status, "ready"))).orderBy(desc(cvAutoBaselines.publishedAt)).limit(1);
      const rubricCheckpoint = previous?.assessment && previous.descriptionVersionId === description.id &&
        previous.engineContract.promptSet === contracts.promptSet &&
        canonicalJson(previous.engineContract.routes["cv.rubric"]) === canonicalJson(routes["cv.rubric"])
        ? cvRevisionRubricCheckpoint({ jobDescription: description.text,
          assessment: previous.assessment }, description.text) : null;
      const [draft] = await tx.insert(cvDrafts).values({ userId: user.id, contextId: context.id,
        descriptionVersionId: description.id, editingMode: "auto", autoBaselineId: claim.baseline.id,
        jobId: context.jobId, jobTitle: context.jobTitle, companyName: context.companyName,
        jobDescription: description.text, jobSource: description.source, libraryVersion: latest?.version ?? 0,
        librarySnapshot: library, careerVersion: career.careerVersion,
        careerSourceMap: career.sourceMap, careerDisplay: career.display,
        careerPresentation: career.presentation,
        model, revision, status: "queued", buildCheckpoint: {
          tailoringEnabled: true, quizCompleted: true, ...(rubricCheckpoint ?? {}),
        } }).returning({ id: cvDrafts.id });
      await attachCvAutoBaselineDraft(tx, { userId: user.id, baselineId: claim.baseline.id, draftId: draft!.id });
      await reserveCvCredit(tx, user.id, draft!.id);
      await enqueue("generate_cv", { draftId: draft!.id, userId: user.id }, tx);
      await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: draft!.id })
        .where(and(eq(cvApplicationContexts.id, context.id), eq(cvApplicationContexts.userId, user.id)));
      return { status: "queued" as const, baselineId: claim.baseline.id, draftId: draft!.id, charged: true };
    });
    revalidatePath("/cv");
    return { ok: true, ...outcome, sourceReview };
  } catch (error) {
    if (isEmptyCvExperienceError(error)) return { ok: false, sourceReview,
      error: sourceReview?.length
        ? "Choose a statement for this CV below, add another work detail, or continue in Manual. You can leave Experience reviews for later."
        : "Add a work detail to Experience, or continue in Manual to write your CV." };
    const result = actionError(error, "Could not update Auto. Please try again.");
    return { ok: false, error: result.ok ? "Could not update Auto." : result.error, sourceReview };
  }
}

/** Retry a failed claim against its pinned input and completed stage checkpoint. */
export async function retryFailedAutoCv(contextId: string, baselineId: string): Promise<AutoCvResult> {
  const user = await requireVerifiedUser();
  try {
    if (!uuid.test(contextId) || !uuid.test(baselineId)) throw new UserFacingError("This Auto build could not be found.");
    const result = await db().transaction(async tx => {
      await lockCvBuildCapacity(tx, user.id);
      const [baseline] = await tx.select().from(cvAutoBaselines).where(and(eq(cvAutoBaselines.id, baselineId),
        eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.userId, user.id))).for("update");
      if (!baseline?.sourceDraftId) throw new UserFacingError("This Auto build could not be found.");
      if (baseline.status === "ready") return { status: "ready" as const, baselineId, draftId: baseline.sourceDraftId, charged: false };
      if (baseline.status === "queued") return { status: "queued" as const, baselineId, draftId: baseline.sourceDraftId, charged: false };
      if (baseline.engineContract.promptSet !== promptSetVersion() || baseline.engineContract.fit !== CV_FIT_VERSION
        || baseline.engineContract.render !== CV_RENDER_VERSION || baseline.engineContract.review !== CV_REVIEW_VERSION)
        throw new UserFacingError("This Auto build used an earlier engine. Request an update instead of retrying it.");
      const [draft] = await tx.select().from(cvDrafts).where(and(eq(cvDrafts.id, baseline.sourceDraftId),
        eq(cvDrafts.userId, user.id), eq(cvDrafts.contextId, contextId))).for("update");
      if (!draft || draft.status !== "failed" || draft.autoBaselineId !== baseline.id)
        throw new UserFacingError("The failed Auto build changed. Reload this application.");
      await assertCvBuildCapacity(tx, user.id);
      await reserveCvCredit(tx, user.id, draft.id);
      await tx.update(cvAutoBaselines).set({ status: "queued" })
        .where(and(eq(cvAutoBaselines.id, baseline.id), eq(cvAutoBaselines.userId, user.id), eq(cvAutoBaselines.status, "failed")));
      await tx.update(cvDrafts).set({ status: "queued", error: null, failure: null, buildStage: null })
        .where(and(eq(cvDrafts.id, draft.id), eq(cvDrafts.userId, user.id), eq(cvDrafts.status, "failed")));
      await enqueue("generate_cv", { draftId: draft.id, userId: user.id }, tx);
      return { status: "queued" as const, baselineId, draftId: draft.id, charged: true };
    });
    revalidatePath("/cv");
    return { ok: true, ...result };
  } catch (error) {
    const result = actionError(error, "Could not retry this Auto build. Please try again.");
    return { ok: false, error: result.ok ? "Could not retry this Auto build." : result.error };
  }
}
