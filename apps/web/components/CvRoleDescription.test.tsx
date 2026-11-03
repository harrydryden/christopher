// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CvRefinementV1 } from "@col/core/cv-editing-modes";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/cv-editing", () => ({ updateCvApplicationDescription: vi.fn(),
  previewCvRefinementRebase: vi.fn(), applyCvRefinementRebase: vi.fn() }));
import { updateCvApplicationDescription, previewCvRefinementRebase,
  applyCvRefinementRebase } from "@/app/actions/cv-editing";
import { CvRoleDescription } from "./CvRoleDescription";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const d = "44444444-4444-4444-8444-444444444444";
const props = { contextId: a, descriptionVersionId: b, description: "Original role", version: 1,
  refinementVersion: 2, initialFrom: c, refinements: [], baselines: [
    { id: c, status: "ready" as const, descriptionVersionId: a, roleVersion: 1 },
    { id: d, status: "ready" as const, descriptionVersionId: b, roleVersion: 2 },
  ] };
const rebaseProps = { ...props, refinements: [{ id: a, version: 1, order: 0, kind: "exact_wording",
  target: { type: "summary", id: b }, text: "A saved edit", reset: false,
  dependencies: { descriptionVersionId: a, sourceHash: "a".repeat(64), sourceIds: [], originBaselineId: c } }] as CvRefinementV1[] };
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container);
  root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const text = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const type = (value: string) => act(() => { const input = text();
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true })); });

it("adopts a clean externally updated role but retains dirty wording and refuses a stale save", async () => {
  act(() => root.render(<CvRoleDescription {...props} />));
  expect(text().value).toBe("Original role");
  act(() => root.render(<CvRoleDescription {...props} descriptionVersionId={d} description="New external role" version={2} />));
  expect(text().value).toBe("New external role");
  type("My unsaved role edits");
  act(() => root.render(<CvRoleDescription {...props} descriptionVersionId={c} description="Another external role" version={3} />));
  expect(text().value).toBe("My unsaved role edits");
  expect(container.textContent).toContain("newer role description");
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.includes("Update saved role description"))!;
  expect(save.disabled).toBe(true);
  expect(updateCvApplicationDescription).not.toHaveBeenCalled();
});

it("gives the role textarea and rebase selects exact explicit labels in server markup", () => {
  const html = renderToStaticMarkup(<CvRoleDescription {...rebaseProps} />);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const label = [...parsed.querySelectorAll("label")].find(row => row.textContent === "Role description for this application")!;
  const field = parsed.querySelector("textarea")!;
  expect(label.htmlFor).toBe(field.id);
  expect(label.htmlFor).toBeTruthy();
  for (const name of ["From saved Auto result", "To current role’s Auto result"]) {
    const exact = [...parsed.querySelectorAll("label")].find(row => row.textContent === name)!;
    expect(exact).toBeTruthy();
    expect(exact.htmlFor).toBeTruthy();
    expect(parsed.getElementById(exact.htmlFor)?.tagName).toBe("SELECT");
  }
});

it("updates the role with a version fence without replacing a saved CV", async () => {
  vi.mocked(updateCvApplicationDescription).mockResolvedValue({ ok: true, contextId: a, descriptionVersionId: d });
  act(() => root.render(<CvRoleDescription {...props} />));
  type("My revised role");
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.includes("Update saved role description"))!.click(); });
  expect(updateCvApplicationDescription).toHaveBeenCalledWith(a, b, "My revised role");
  expect(refresh).toHaveBeenCalledOnce();
  expect(text().value).toBe("My revised role");
  expect(container.textContent).toContain("Existing CVs and remembered choices remain unchanged");
});

it("applies only explicitly selected compatible rules using the exact preview key", async () => {
  vi.mocked(previewCvRefinementRebase).mockResolvedValue({ ok: true, version: 2,
    toDescriptionVersionId: b, previewKey: "a".repeat(64), items: [
      { id: a, status: "compatible", target: { type: "summary", id: b }, sourceIds: [], sourceHash: "hash" },
      { id: c, status: "current" },
      { id: d, status: "conflict", reason: "changed_source" },
    ] });
  vi.mocked(applyCvRefinementRebase).mockResolvedValue({ ok: true, version: 3, rebasedIds: [a], conflicts: [] });
  act(() => root.render(<CvRoleDescription {...rebaseProps} />));
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent === "Review source changes")!.click(); });
  expect(previewCvRefinementRebase).toHaveBeenCalledWith(a, 2, c, d);
  expect(container.textContent).toContain("1 compatible remembered changes");
  expect(container.textContent).toContain("1 already current");
  expect(container.textContent).toContain("Needs a new decision");
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.includes("Carry compatible changes"))!.click(); });
  expect(applyCvRefinementRebase).toHaveBeenCalledWith(a, 2, c, d, "a".repeat(64), [a]);
});
