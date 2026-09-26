/** The System settings table of stage routes: what it shows, and what a submitted form stores. */
import { expect, it } from "vitest";
import { STAGE_ROUTE_IDS } from "@ava/core";
import { stageRouteRows, stageRoutesFromForm, stageRouteWarnings } from "./stage-routes";

it("lists every stage, the CV build's first, with default where nothing is routed", () => {
  const rows = stageRouteRows({ "cv.author": { model: "claude-opus-5-5", effort: "high" } });
  expect(rows).toHaveLength(STAGE_ROUTE_IDS.length);
  expect(rows.slice(0, 6).every((row) => row.id.startsWith("cv."))).toBe(true);
  expect(rows.find((row) => row.id === "cv.author")).toEqual({ id: "cv.author", label: "CV · writing", model: "claude-opus-5-5", effort: "high" });
  expect(rows.find((row) => row.id === "cv.review")).toMatchObject({ model: null, effort: null });
  expect(stageRouteRows(undefined).every((row) => row.model === null && row.effort === null)).toBe(true);
});

it("stores only what was chosen, and drops what the provider would refuse", () => {
  const form = new FormData();
  form.set("route:cv.author:model", "claude-opus-5-5");
  form.set("route:cv.author:effort", "");
  form.set("route:cv.review:effort", "max");
  form.set("route:cv.rubric:model", "a-model-nobody-offers");
  form.set("route:cv.planning:effort", "enormous");
  form.set("route:not-a-stage:model", "claude-opus-5-5");
  expect(stageRoutesFromForm(form)).toEqual({ "cv.author": { model: "claude-opus-5-5" }, "cv.review": { effort: "max" } });
  expect(stageRoutesFromForm(new FormData())).toEqual({});
});

it("warns about an overridden stage running at a route the committed report did not grade", () => {
  const evaluated = {
    report: "docs/evaluations/cv-replay/report.json", promptSetVersion: "abc123", unverified: true, at: "2026-09-26T00:00:00Z",
    routes: { "cv.review": { model: "cvModel", resolvedModel: "claude-fable-5-1", effort: "high" as const, defaultModel: "cvModel", defaultEffort: "high" as const } },
  };
  expect(stageRouteWarnings({ "cv.review": { effort: "medium" } }, evaluated)).toEqual([
    "CV · checking against the evidence runs on the account's CV model at medium effort, but docs/evaluations/cv-replay/report.json (prompt set abc123, unverified) graded it on the account's CV model (claude-fable-5-1 when graded) at high effort. Replay a draft at this route and commit its report before relying on it.",
  ]);
  expect(stageRouteWarnings({ "cv.review": { effort: "high" } }, evaluated)).toEqual([]);
  expect(stageRouteWarnings(null, evaluated)).toEqual([]);
});
