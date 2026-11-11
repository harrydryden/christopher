// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { CareerConflictDetail } from "@col/core/career-record";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import { CareerConflictReview } from "./CareerConflictReview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const firstId = "94a4acfb-5d6c-401a-a72a-feb6851fb952";
const secondId = "2677c819-00ee-4d70-806e-d0eaf9006a10";
const subjectId = "75fb43bf-f58b-4571-91a5-31a0746322dc";
const provenance = { kind: "direct_user" as const, sourceId: null, quote: null,
  originalText: "I entered this", captureContext: "internal:do-not-display" };
const detail: CareerConflictDetail = { id: "a".repeat(64), groupKey: "group", fingerprint: "b".repeat(64), subjectId,
  subjectTitle: "Programme lead", active: true, effectiveConfidential: false,
  decisionRevision: 0, decision: null, history: [], historyNextCursor: null, statements: [
    { id: firstId, subjectId, revision: 1, text: "Led 12 people", publicText: null, facets: ["metric"],
      context: { attribute: "team size", scope: "London", period: "2024", value: "12" }, status: "usable", provenance,
      createdAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T10:00:00Z" },
    { id: secondId, subjectId, revision: 2, text: "Led 18 people", publicText: null, facets: ["metric"],
      context: { attribute: "team size", scope: "London", period: "2024", value: "18" }, status: "usable", provenance,
      createdAt: "2026-11-11T10:01:00Z", updatedAt: "2026-11-11T10:01:00Z" },
  ] };

afterEach(() => { vi.clearAllMocks(); });

it("shows both saved statements, their specific context and safe source descriptions", () => {
  const html = renderToStaticMarkup(<CareerConflictReview detail={detail} decide={vi.fn()} />);
  expect(html).toContain("Led 12 people");
  expect(html).toContain("Led 18 people");
  expect(html).toContain("London");
  expect(html).toContain("Added by you");
  expect(html).not.toContain("internal:do-not-display");
  expect(html).toContain("Review later");
  expect(html).toContain("Not a conflict");
});

it("offers separate safe CV wording for every statement when the source is private", () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<CareerConflictReview detail={{ ...detail, effectiveConfidential: true }} decide={vi.fn()} />));
  const keep = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Keep both with context")!;
  act(() => keep.click());
  expect(host.querySelectorAll('textarea[id^="context-public-"]')).toHaveLength(2);
  expect(host.textContent).toContain("Private client details stay in Experience");
  act(() => root.unmount()); host.remove();
});

it("binds a chosen statement to the exact saved group and preserves retry identity after failure", async () => {
  const decide = vi.fn().mockResolvedValue({ ok: false, error: "The connection failed. Try again." });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<CareerConflictReview detail={detail} decide={decide} />));
  const use = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Use this statement for future CVs")!;
  await act(async () => use.click());
  expect(decide).toHaveBeenCalledWith(expect.objectContaining({ conflictId: detail.id,
    expectedFingerprint: detail.fingerprint, expectedDecisionRevision: 0, choice: "choose", selectedAssertionId: firstId }));
  expect(host.textContent).toContain("The connection failed. Try again.");
  await act(async () => use.click());
  expect(decide.mock.calls[1]![0].requestKey).toBe(decide.mock.calls[0]![0].requestKey);
  act(() => root.unmount()); host.remove();
});

it("retains a drafted correction when the saved group changes", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<CareerConflictReview detail={detail} decide={vi.fn()} />));
  const correct = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Correct the details")!;
  act(() => correct.click());
  const wording = host.querySelector<HTMLTextAreaElement>("#correct-text")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(wording, "Led 14 people");
    wording.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => root.render(<CareerConflictReview detail={{ ...detail, fingerprint: "c".repeat(64), decisionRevision: 1 }} decide={vi.fn()} />));
  expect(host.querySelector<HTMLTextAreaElement>("#correct-text")?.value).toBe("Led 14 people");
  expect(host.textContent).toContain("Your draft is still here");
  act(() => root.unmount()); host.remove();
});

it("adopts the new statement revision after its own correction is saved", async () => {
  const decide = vi.fn().mockResolvedValue({ ok: true, decisionRevision: 1, careerVersion: 7,
    summary: { needsReview: true, activeCount: 1, deferredCount: 0 } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<CareerConflictReview detail={detail} decide={decide} />));
  const correct = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Correct the details")!;
  act(() => correct.click());
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save correction")!.click());
  expect(router.refresh).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLTextAreaElement>("#correct-text")?.disabled).toBe(true);
  const updated: CareerConflictDetail = { ...detail, fingerprint: "d".repeat(64), decisionRevision: 1,
    statements: [{ ...detail.statements[0]!, revision: 2, text: "Led 14 people" }, detail.statements[1]!] };
  await act(async () => root.render(<CareerConflictReview detail={updated} decide={decide} />));
  act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Correct the details")!.click());
  expect(host.querySelector<HTMLTextAreaElement>("#correct-text")?.value).toBe("Led 14 people");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save correction")!.click());
  expect(decide.mock.calls[1]![0].edits[0].expectedRevision).toBe(2);
  act(() => root.unmount()); host.remove();
});
