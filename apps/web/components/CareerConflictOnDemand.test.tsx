// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CareerConflictDetail } from "@col/core/career-record";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { CareerConflictOnDemand } from "./CareerConflictOnDemand";
import { CareerConflictSnapshot } from "./CareerConflictSnapshot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const detail: CareerConflictDetail = { id: "a".repeat(64), groupKey: "group", fingerprint: "b".repeat(64),
  subjectId: "44327166-38d1-4462-91af-c07a6b9284a4", subjectTitle: "Programme lead", active: true,
  effectiveConfidential: false, decisionRevision: 0, decision: null, history: [], historyNextCursor: null,
  statements: [{ id: "ae27e2bc-3e57-4781-ab7c-ff409f23a929", subjectId: "44327166-38d1-4462-91af-c07a6b9284a4",
    revision: 1, text: "Led 12 people", publicText: null, facets: ["metric"], status: "usable",
    context: { attribute: "team size", scope: "London", period: "2024", value: "12" },
    provenance: { kind: "direct_user", sourceId: null, quote: null, originalText: "Led 12 people", captureContext: null },
    createdAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T10:00:00Z" }] };

it("shows readable evidence first and loads choices only on intent", async () => {
  const decide = vi.fn();
  const html = renderToStaticMarkup(<CareerConflictOnDemand detail={detail} decide={decide}>
    <CareerConflictSnapshot detail={detail} /></CareerConflictOnDemand>);
  expect(html).toContain("Led 12 people");
  expect(html).toContain("Decide how to use these statements");
  expect(html).not.toContain("Use this statement for future CVs");

  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<CareerConflictOnDemand detail={detail} decide={decide}>
    <CareerConflictSnapshot detail={detail} /></CareerConflictOnDemand>));
  await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await import("./CareerConflictReview"); });
  expect(host.textContent).toContain("Use this statement for future CVs");
  await act(async () => root.unmount()); host.remove();
});
