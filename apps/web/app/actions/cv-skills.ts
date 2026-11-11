"use server";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { CvContentSchema, CvLibrarySchema, CvSkillSuggestionSchema } from "@col/core";
import { CvRefinementSchema, cvEditingTargetsFor, cvProjectSkillSelection,
  cvRefinementDependencies, type CvRefinementV1 } from "@col/core/cv-editing-modes";
import { canonicalJson } from "@col/core/cv-review";
import { appendCvRefinement, currentCvRefinements, cvApplicationContexts, cvAutoBaselines,
  cvDrafts, cvSkillSuggestionRuns, lockAccountScoreInput, nextCvRevision } from "@col/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { latestLibrary, writeCvLibraryVersion } from "@/lib/cv-library-write";
import { acceptCvSkillSuggestions } from "@/lib/cv-skill-accept";
import { cvSuggestionAssignments } from "@/lib/cv-review-edits";
import { actionError, UserFacingError } from "@/lib/validation";
import { revalidatePath } from "next/cache";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Save source-checked skill tags and the selected ready CV together, without another AI call. */
export async function useCvSkillSuggestions(contextId: string, draftId: string, runId: string,
  expectedRevision: number, expectedOverlayVersion: number, selectedIds: string[], requestKey: string): Promise<
  { ok: true; draftId: string; version: number; charged: false } | { ok: false; error: string }> {
  const user = await requireUser();
  try {
    if (![contextId, draftId, runId, requestKey].every(value => uuid.test(value)) ||
      !Number.isInteger(expectedRevision) || expectedRevision < 1 ||
      !Number.isInteger(expectedOverlayVersion) || expectedOverlayVersion < 0 ||
      !Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 10 ||
      selectedIds.some(value => !uuid.test(value)) || new Set(selectedIds).size !== selectedIds.length)
      throw new UserFacingError("Refresh the CV and choose its current skill suggestions.");
    const identity = createHash("sha256").update(canonicalJson({ contextId, draftId, runId,
      expectedRevision, expectedOverlayVersion, selectedIds: [...selectedIds].sort(), requestKey })).digest("hex");
    const result = await db().transaction(async tx => {
      await lockAccountScoreInput(tx as unknown as ReturnType<typeof db>, user.id, "exclusive");
      const [context] = await tx.select().from(cvApplicationContexts).where(and(
        eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id))).for("update");
      const [source] = await tx.select().from(cvDrafts).where(and(eq(cvDrafts.id, draftId),
        eq(cvDrafts.userId, user.id), eq(cvDrafts.contextId, contextId))).for("update");
      const [run] = await tx.select().from(cvSkillSuggestionRuns).where(and(
        eq(cvSkillSuggestionRuns.id, runId), eq(cvSkillSuggestionRuns.userId, user.id),
        eq(cvSkillSuggestionRuns.draftId, draftId))).for("update");
      if (!context || !source || !run || !source.content || source.status !== "ready" ||
        source.revision !== expectedRevision ||
        source.descriptionVersionId !== context.currentDescriptionVersionId || run.status !== "ready")
        throw new UserFacingError("The CV or its skill suggestions changed. Refresh before using them.");
      if (run.acceptedDraftId) {
        if (run.acceptedSelectionHash !== identity || context.selectedKind !== "draft" ||
          context.selectedId !== run.acceptedDraftId ||
          context.refinementsVersion !== expectedOverlayVersion + 1)
          throw new UserFacingError("These skills were already used on another edition. Open the current CV.");
        return { draftId: run.acceptedDraftId, version: context.refinementsVersion };
      }
      if (context.selectedKind !== "draft" || context.selectedId !== draftId ||
        context.refinementsVersion !== expectedOverlayVersion)
        throw new UserFacingError("The selected CV changed. Refresh before using these skills.");
      const activeTask = await tx.execute<{ active: boolean }>(sql`select exists (
        select 1 from tasks where payload->>'draftId' = ${draftId}
          and status in ('queued', 'running')
      ) as active`);
      if (activeTask.rows[0]?.active)
        throw new UserFacingError("Wait for this CV's current work to finish before using its skills.");
      const selected = selectedIds.map(id => run.suggestions.find(row => row.id === id));
      if (selected.some(row => !row)) throw new UserFacingError("A selected skill is no longer available. Refresh suggestions.");
      const suggestions = selected.map(row => CvSkillSuggestionSchema.parse(row));
      const latest = await latestLibrary(tx, user.id);
      if (!latest || latest.version !== run.libraryVersion)
        throw new UserFacingError("Your Experience changed. Refresh skill suggestions.");
      const original = CvContentSchema.parse(source.content);
      const originalTargets = source.editingTargets ?? cvEditingTargetsFor(original, randomUUID);
      const [baseline] = source.autoBaselineId ? await tx.select().from(cvAutoBaselines).where(and(
        eq(cvAutoBaselines.id, source.autoBaselineId), eq(cvAutoBaselines.userId, user.id),
        eq(cvAutoBaselines.contextId, contextId), eq(cvAutoBaselines.status, "ready"))) : [];
      if (source.autoBaselineId && !baseline)
        throw new UserFacingError("This CV's original Auto source is unavailable.");
      let acceptedContent = original;
      const citations: Record<string, { sourceId: string; quote: string }> = {};
      const nextLibraryVersion = await writeCvLibraryVersion(tx, user.id, run.libraryVersion, current => {
        if (!current) throw new UserFacingError("Your Experience changed. Refresh suggestions.");
        const targets = current.entries.flatMap(entry => entry.kind === "skill" && entry.skillItems?.length
          ? [{ id: entry.id, heading: entry.heading, items: entry.skillItems }] : []);
        for (const { suggestion, heading } of cvSuggestionAssignments(original.sections, suggestions, targets))
          citations[`${heading}\0${suggestion.label}`] = { sourceId: suggestion.sourceId, quote: suggestion.evidenceQuote };
        const accepted = acceptCvSkillSuggestions(CvLibrarySchema.parse(current), original, suggestions);
        acceptedContent = accepted.content;
        return accepted.library;
      }, { review: false, careerOrigin: "accepted_suggestion", careerSourceId: runId,
        acceptedSuggestionCitations: citations });
      const published = await latestLibrary(tx, user.id);
      if (!published || published.version !== nextLibraryVersion) throw new Error("Accepted skills were not published.");
      const library = CvLibrarySchema.parse(published.content);
      const additions = acceptedContent.sections.flatMap(section => {
        if (section.kind !== "skill") return [];
        const previous = original.sections.find(item => item.entryId === section.entryId);
        const held = new Set(previous?.skillItems ?? []);
        const items = (section.skillItems ?? []).filter(label => !held.has(label)).map(label => {
          const matches = library.entries.filter(entry => entry.kind === "skill")
            .flatMap(entry => (entry.skillItems ?? []).flatMap((value, index) => value === label &&
              entry.heading === section.heading ? [library.careerProjection?.sourceMap[`entry:${entry.id}:skill:${index}`]] : []))
            .filter(Boolean);
          if (matches.length !== 1) throw new UserFacingError("The selected skill source changed. Refresh suggestions.");
          const suggestion = suggestions.find(item => item.label === label)!;
          return { id: randomUUID(), bulletId: randomUUID(), label, sourceId: suggestion.sourceId, quote: suggestion.evidenceQuote,
            sourceRef: matches[0]! };
        });
        if (!items.length) return [];
        return [{ entryId: section.entryId,
          sectionId: originalTargets.sections.find(item => item.entryId === section.entryId)?.sectionId ?? randomUUID(),
          heading: section.heading, items }];
      });
      if (!additions.length) throw new UserFacingError("The chosen skills are already on this CV.");
      const active = await currentCvRefinements(tx, user.id, contextId);
      const authority = baseline ?? source;
      if (!authority.content || !authority.editingTargets || !authority.librarySnapshot)
        throw new UserFacingError("This CV's editing source changed. Reload it.");
      const target = { type: "selection" as const };
      const dependencies = cvRefinementDependencies({ content: authority.content,
        targets: authority.editingTargets, library: authority.librarySnapshot,
        descriptionVersionId: source.descriptionVersionId!, target });
      const refinement = CvRefinementSchema.parse({ id: randomUUID(), version: 1,
        order: Math.max(-1, ...active.map(row => row.order)) + 1, kind: "structured", target,
        structured: { kind: "skill_selection", runId, careerVersion: library.careerProjection?.version ?? 0,
          sections: additions }, dependencies: { ...dependencies,
          descriptionVersionId: source.descriptionVersionId,
          originBaselineId: baseline?.id ?? null }, reset: false });
      const saved = await appendCvRefinement(tx, { userId: user.id, contextId,
        expectedVersion: expectedOverlayVersion, refinement });
      let projected: ReturnType<typeof cvProjectSkillSelection>;
      try { projected = cvProjectSkillSelection(original, originalTargets, refinement.structured! as Extract<
        NonNullable<CvRefinementV1["structured"]>, { kind: "skill_selection" }>); }
      catch { throw new UserFacingError("A skill selection conflicts with this CV. Refresh and choose again."); }
      if (canonicalJson(projected.content) !== canonicalJson(acceptedContent))
        throw new UserFacingError("The selected skill targets changed. Refresh and choose again.");
      const revision = await nextCvRevision(tx, { userId: user.id,
        companyName: context.companyName, jobTitle: context.jobTitle, contextId });
      const [child] = await tx.insert(cvDrafts).values({ userId: user.id, contextId,
        descriptionVersionId: source.descriptionVersionId, editingMode: source.editingMode === "manual" ? "manual" : "refine",
        parentId: source.id, autoBaselineId: baseline?.id ?? null,
        jobId: source.jobId, jobTitle: source.jobTitle, companyName: source.companyName,
        jobDescription: source.jobDescription, jobSource: source.jobSource,
        libraryVersion: nextLibraryVersion, librarySnapshot: library, model: source.model,
        revision, status: "ready", content: acceptedContent,
        editingTargets: projected.targets,
        refinementSnapshot: [...(source.refinementSnapshot ?? []), refinement],
        appliedRefinements: [...(source.appliedRefinements ?? []), { id: refinement.id, version: 1 }],
        refinementSourceContent: baseline?.content ?? source.content,
        refinementSourceTargets: baseline?.editingTargets ?? source.editingTargets,
        refinementEngineContract: source.refinementEngineContract ?? baseline?.engineContract ?? null,
        refinementOriginKind: baseline ? "baseline" : "manual",
        targetingBrief: source.targetingBrief, buildCheckpoint: source.buildCheckpoint,
        assessment: null, semanticAuditCache: source.semanticAuditCache,
      }).returning({ id: cvDrafts.id });
      await tx.update(cvSkillSuggestionRuns).set({ acceptedSelectionHash: identity,
        acceptedDraftId: child!.id, updatedAt: new Date() }).where(eq(cvSkillSuggestionRuns.id, runId));
      await tx.update(cvApplicationContexts).set({ selectedKind: "draft", selectedId: child!.id })
        .where(and(eq(cvApplicationContexts.id, contextId), eq(cvApplicationContexts.userId, user.id)));
      return { draftId: child!.id, version: saved.version };
    });
    revalidatePath("/cv"); revalidatePath("/library");
    return { ok: true, ...result, charged: false };
  } catch (error) {
    const result = actionError(error, "Could not use these skills. Please try again.");
    return { ok: false, error: result.ok ? "Could not use these skills." : result.error };
  }
}
