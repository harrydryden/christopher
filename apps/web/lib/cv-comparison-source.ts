import { CvContentSchema } from "@col/core/cv";
import { CvEditingTargetsSchema } from "@col/core/cv-editing-modes";
import { canonicalJson } from "@col/core/cv-review";
import type { CvTargetingView } from "@col/core/cv-targeting";
import { cvAutoBaselines, cvDrafts } from "@col/db";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { cvBaselineTargetingView } from "@/lib/cv-baseline-targeting-view";
import { cvTargetingViewForOwnedDraft } from "@/lib/cv-targeting-view";

type Draft = typeof cvDrafts.$inferSelect;
type Baseline = typeof cvAutoBaselines.$inferSelect;
type RetainedSource = Pick<Draft, "refinementSourceContent" | "refinementSourceTargets" | "descriptionVersionId">;
type CandidateSource = { content: unknown; editingTargets: unknown; descriptionVersionId: string | null };

/** A matching heading or selected workspace item is not proof of historical provenance. */
export function cvComparisonSourceMatches(retained: RetainedSource, candidate: CandidateSource): boolean {
  if (!retained.descriptionVersionId || retained.descriptionVersionId !== candidate.descriptionVersionId)
    return false;
  const before = CvContentSchema.safeParse(retained.refinementSourceContent);
  const actual = CvContentSchema.safeParse(candidate.content);
  const beforeTargets = CvEditingTargetsSchema.safeParse(retained.refinementSourceTargets);
  const actualTargets = CvEditingTargetsSchema.safeParse(candidate.editingTargets);
  return before.success && actual.success && beforeTargets.success && actualTargets.success &&
    canonicalJson(retained.refinementSourceContent) === canonicalJson(candidate.content) &&
    canonicalJson(retained.refinementSourceTargets) === canonicalJson(candidate.editingTargets);
}

/** Resolve the result's actual saved source, including a producer draft that has since been pruned. */
export async function cvComparisonSourceForOwnedDraft(userId: string, contextId: string, result: Draft):
  Promise<{ sourceTargeting: CvTargetingView | null; provenance: "exact" | "unavailable" }> {
  const unavailable = { sourceTargeting: null, provenance: "unavailable" as const };
  if (result.userId !== userId || result.contextId !== contextId || result.editingMode !== "refine")
    return unavailable;
  if (result.refinementOriginKind === "baseline" && result.autoBaselineId) {
    const [baseline] = await db().select().from(cvAutoBaselines).where(and(
      eq(cvAutoBaselines.id, result.autoBaselineId), eq(cvAutoBaselines.userId, userId),
      eq(cvAutoBaselines.contextId, contextId))).limit(1);
    if (!baseline || baseline.status !== "ready" || !baseline.librarySnapshot ||
      !cvComparisonSourceMatches(result, baseline)) return unavailable;
    return { provenance: "exact", sourceTargeting: cvBaselineTargetingView({ id: baseline.id,
      content: CvContentSchema.parse(baseline.content), library: baseline.librarySnapshot,
      assessment: baseline.assessment, plan: baseline.tailoringPlan, snapshot: baseline.inputSnapshot }) };
  }
  if (result.refinementOriginKind === "manual" && result.parentId) {
    const [parent] = await db().select().from(cvDrafts).where(and(
      eq(cvDrafts.id, result.parentId), eq(cvDrafts.userId, userId),
      eq(cvDrafts.contextId, contextId))).limit(1);
    if (!parent || parent.editingMode !== "manual" || !cvComparisonSourceMatches(result, parent))
      return unavailable;
    return { provenance: "exact", sourceTargeting: await cvTargetingViewForOwnedDraft(userId, parent) };
  }
  return unavailable;
}
