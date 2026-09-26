/**
 * Whether the administrator's stage routes still run at what was evaluated.
 *
 * `EVALUATED_ROUTES` (evaluated-routes.ts, generated from the committed evaluation report by
 * `pnpm exec tsx scripts/check-evaluation-reports.ts --write`, and held to it by CI) records the
 * route each CV stage was graded at, beside the registry's default route for it. A stage the
 * `stageRoutes` setting overrides to a model or effort other than the graded one is running at a
 * route no committed report vouches for; Health says so, so the switch is made after a passing
 * replay rather than instead of one (docs/DEPLOY.md, "Changing a stage's effort or model").
 */
import type { StageEffort, StageRouteId, StageRoutes } from "./settings";

export interface EvaluatedStageRoute {
  /** The graded route's model: symbolic (`cvModel`, `callSite`) or a model id. */
  model: string;
  /** The model it resolved to in the graded run. */
  resolvedModel: string;
  effort: StageEffort;
  /** The registry's own route for the stage, which a route leaving a field out keeps. */
  defaultModel: string;
  defaultEffort: StageEffort;
}

export interface EvaluatedRoutes {
  /** The committed report the routes were read from. */
  report: string;
  promptSetVersion: string;
  /** Whether that report's answers came from a live model (false) or a scripted recording (true). */
  unverified: boolean;
  at: string;
  routes: Partial<Record<StageRouteId, EvaluatedStageRoute>>;
}

export interface StageRouteDrift {
  id: StageRouteId;
  /** What the setting makes the stage run at. */
  routed: { model: string; effort: StageEffort };
  /** What the committed report graded it at. */
  graded: Pick<EvaluatedStageRoute, "model" | "resolvedModel" | "effort">;
}

/** Every overridden stage whose route differs from the one the committed report graded. */
export function stageRouteDrift(routes: StageRoutes | null | undefined, evaluated: EvaluatedRoutes): StageRouteDrift[] {
  const drift: StageRouteDrift[] = [];
  for (const [id, override] of Object.entries(routes ?? {}) as Array<[StageRouteId, StageRoutes[StageRouteId]]>) {
    const graded = evaluated.routes[id];
    if (!graded || !override) continue;
    const model = override.model ?? graded.defaultModel;
    const effort = override.effort ?? graded.defaultEffort;
    // A model named outright matches a graded run that resolved to it; a symbolic one must match as written.
    const sameModel = model === graded.model || model === graded.resolvedModel;
    if (sameModel && effort === graded.effort) continue;
    drift.push({ id, routed: { model, effort }, graded: { model: graded.model, resolvedModel: graded.resolvedModel, effort: graded.effort } });
  }
  return drift;
}
