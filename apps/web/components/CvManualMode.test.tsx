// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/cv-editing", () => ({ createManualCvEdition: vi.fn(), saveManualCvEdition: vi.fn() }));
import { createManualCvEdition, saveManualCvEdition } from "@/app/actions/cv-editing";
import { CvManualMode } from "./CvManualMode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const version = "714c04c0-e0ff-47eb-aed1-9f06cd34dd4b";
function enter(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  act(() => { setter?.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("starts from the selected source by choice, while blank Manual remains free", async () => {
  vi.mocked(createManualCvEdition).mockResolvedValue({ ok: true, draftId: "manual-1", charged: false });
  act(() => root.render(<CvManualMode contextId="context" descriptionVersionId={version} draft={null}
    copySource={{ kind: "baseline", id: "baseline" }} prefill={{ name: "Alex", contact: "London", summary: "Analyst" }} />));
  const copy = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("Copy selected"))!;
  await act(async () => { copy.click(); });
  expect(createManualCvEdition).toHaveBeenCalledWith("context", version, { kind: "baseline", id: "baseline" });
  expect(router.refresh).toHaveBeenCalledOnce();
});

it("can save a genuine first Manual section without Auto or an AI call", async () => {
  vi.mocked(saveManualCvEdition).mockResolvedValue({ ok: true, draftId: "manual-child" });
  act(() => root.render(<CvManualMode contextId="context" descriptionVersionId={version}
    draft={{ id: "manual-starter", revision: 1, content: null, editingTargets: null }}
    prefill={{ name: "Alex Morgan", contact: "London", summary: "Operations analyst" }} />));
  const add = [...container.querySelectorAll("button")].find(button => button.textContent === "Add section")!;
  act(() => add.click());
  const heading = [...container.querySelectorAll("input")].find(input => input.closest("label")?.textContent?.includes("Heading"))!;
  enter(heading, "My project work");
  const bullet = [...container.querySelectorAll("textarea")].find(input => input.closest("label")?.textContent?.includes("Bullet 1"))!;
  enter(bullet, "Built the monthly report for my team.");
  const save = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("Save Manual CV"))!;
  await act(async () => save.click());
  const call = vi.mocked(saveManualCvEdition).mock.calls[0]!;
  expect(call[0]).toBe("manual-starter");
  expect(call[1]).toBe(1);
  expect(call[2]).toMatchObject({ name: "Alex Morgan", summary: "Operations analyst",
    sections: [{ kind: "experience", heading: "My project work", bullets: ["Built the monthly report for my team."] }] });
  expect(call[3]).toBeUndefined();
});

it("keeps a chosen comma-containing skill as one ordered Manual label", async () => {
  vi.mocked(saveManualCvEdition).mockResolvedValue({ ok: true, draftId: "manual-child" });
  act(() => root.render(<CvManualMode contextId="context" descriptionVersionId={version}
    draft={{ id: "manual-starter", revision: 1, content: null, editingTargets: null }}
    prefill={{ name: "Alex Morgan", contact: "London", summary: "Operations analyst" }}
    skillChoices={["Planning, delivery", "SQL"]} />));
  act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Add section")!.click());
  const type = [...container.querySelectorAll<HTMLSelectElement>("select")].find(select =>
    select.closest("label")?.textContent?.includes("Type"))!;
  act(() => { type.value = "skill"; type.dispatchEvent(new Event("change", { bubbles: true })); });
  const heading = [...container.querySelectorAll<HTMLInputElement>("input")].find(input =>
    input.closest("label")?.textContent?.includes("Heading"))!;
  enter(heading, "Delivery skills");
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Add Planning, delivery"]')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent?.startsWith("Save Manual CV"))!.click());
  expect(vi.mocked(saveManualCvEdition).mock.calls[0]?.[2]).toMatchObject({ sections: [{
    kind: "skill", heading: "Delivery skills", skillItems: ["Planning, delivery"], bullets: ["Planning, delivery"] }] });
});
