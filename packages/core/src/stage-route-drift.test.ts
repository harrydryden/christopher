import { describe, expect, it } from "vitest";
import { EVALUATED_ROUTES } from "./evaluated-routes";
import { STAGE_ROUTE_IDS } from "./settings";
import { stageRouteDrift, type EvaluatedRoutes } from "./stage-route-drift";

const graded: EvaluatedRoutes = {
  report: "docs/evaluations/cv-replay/report.json", promptSetVersion: "abc", unverified: false, at: "2026-09-26T00:00:00Z",
  routes: {
    "cv.review": { model: "cvModel", resolvedModel: "claude-fable-5-1", effort: "high", defaultModel: "cvModel", defaultEffort: "high" },
    "cv.review_candidate": { model: "cvModel", resolvedModel: "claude-fable-5-1", effort: "medium", defaultModel: "cvModel", defaultEffort: "high" },
  },
};

describe("stage routes against the evaluated routes", () => {
  it("names an overridden stage whose effort or model differs from the graded route", () => {
    expect(stageRouteDrift({ "cv.review": { effort: "medium" } }, graded)).toEqual([
      { id: "cv.review", routed: { model: "cvModel", effort: "medium" }, graded: { model: "cvModel", resolvedModel: "claude-fable-5-1", effort: "high" } },
    ]);
    expect(stageRouteDrift({ "cv.review": { model: "claude-sonnet-5" } }, graded).map(item => item.routed))
      .toEqual([{ model: "claude-sonnet-5", effort: "high" }]);
  });

  it("is quiet for a route that matches what was graded, and for a stage no report covers or nobody overrode", () => {
    // Graded at medium through an override: the same override is what was evaluated.
    expect(stageRouteDrift({ "cv.review_candidate": { effort: "medium" } }, graded)).toEqual([]);
    // A model named outright that the graded run resolved to.
    expect(stageRouteDrift({ "cv.review": { model: "claude-fable-5-1" } }, graded)).toEqual([]);
    expect(stageRouteDrift({ A5: { effort: "high" } }, graded)).toEqual([]);
    expect(stageRouteDrift({}, graded)).toEqual([]);
    expect(stageRouteDrift(null, graded)).toEqual([]);
  });

  it("an override that names only a model keeps the default effort, which may differ from the graded one", () => {
    expect(stageRouteDrift({ "cv.review_candidate": { model: "claude-fable-5-1" } }, graded).map(item => item.routed))
      .toEqual([{ model: "claude-fable-5-1", effort: "high" }]);
  });

  it("the committed evaluated routes cover the CV stages with known stage ids", () => {
    for (const id of Object.keys(EVALUATED_ROUTES.routes)) expect(STAGE_ROUTE_IDS).toContain(id);
    expect(Object.keys(EVALUATED_ROUTES.routes).length).toBeGreaterThan(0);
  });
});
