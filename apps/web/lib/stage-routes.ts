/**
 * The per-stage model and effort routes an administrator sets on System settings, as rows the page
 * can render and as the stored value a submitted form becomes. The setting itself, its ids and its
 * sanitiser belong to the model engine (`stageRoutes`, `STAGE_ROUTE_IDS`, `sanitiseStageRoutes`).
 */
import {
  EVALUATED_ROUTES,
  sanitiseStageRoutes,
  stageRouteDrift,
  STAGE_ROUTE_IDS,
  type EvaluatedRoutes,
  type StageRouteId,
  type StageRoutes,
} from "@ava/core";

/** What each prompt registry entry is called on the page; the CV build's stages come first. */
const STAGE_LABELS: Record<string, string> = {
  "cv.rubric": "CV · extracting the requirements",
  "cv.planning": "CV · matching the evidence",
  "cv.author": "CV · writing",
  "cv.review": "CV · checking against the evidence",
  "cv.improvement": "CV · the optional revision",
  "cv.review_candidate": "CV · checking the revision",
};

export interface StageRouteRow {
  id: StageRouteId;
  label: string;
  /** The routed model, or null for the default. */
  model: string | null;
  /** The routed effort, or null for the default. */
  effort: string | null;
}

/** Every stage, CV build stages first, with what is routed for it or null for "default". */
export function stageRouteRows(routes: StageRoutes | null | undefined): StageRouteRow[] {
  const ids = [...STAGE_ROUTE_IDS].sort((a, b) => Number(!a.startsWith("cv.")) - Number(!b.startsWith("cv.")));
  return ids.map((id) => ({
    id,
    label: STAGE_LABELS[id] ?? id,
    model: routes?.[id]?.model ?? null,
    effort: routes?.[id]?.effort ?? null,
  }));
}

/** The stored value a submitted form becomes: `route:<id>:model` and `route:<id>:effort`, blank for default. */
export function stageRoutesFromForm(form: FormData): StageRoutes {
  const raw: Record<string, { model?: string; effort?: string }> = {};
  for (const id of STAGE_ROUTE_IDS) {
    const model = String(form.get(`route:${id}:model`) ?? "").trim();
    const effort = String(form.get(`route:${id}:effort`) ?? "").trim();
    if (model || effort) raw[id] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  return sanitiseStageRoutes(raw);
}

/** A route's model as a person reads it: the account's own CV model, or the model named. */
function modelWords(model: string, resolved?: string): string {
  if (model === "cvModel") return resolved ? `the account's CV model (${resolved} when graded)` : "the account's CV model";
  if (model === "callSite") return "the call site's model";
  return model;
}

/**
 * Health's warning, one sentence per stage the `stageRoutes` setting runs at a model or effort the
 * last committed evaluation report did not grade (`stageRouteDrift`). Empty when every overridden
 * stage runs at what was graded.
 */
export function stageRouteWarnings(routes: StageRoutes | null | undefined, evaluated: EvaluatedRoutes = EVALUATED_ROUTES): string[] {
  const report = `${evaluated.report || "the last evaluation report"}${evaluated.promptSetVersion ? ` (prompt set ${evaluated.promptSetVersion}${evaluated.unverified ? ", unverified" : ""})` : ""}`;
  return stageRouteDrift(routes, evaluated).map(({ id, routed, graded }) =>
    `${STAGE_LABELS[id] ?? id} runs on ${modelWords(routed.model)} at ${routed.effort} effort, but ${report} graded it on ` +
    `${modelWords(graded.model, graded.resolvedModel)} at ${graded.effort} effort. Replay a draft at this route and commit its report before relying on it.`);
}
