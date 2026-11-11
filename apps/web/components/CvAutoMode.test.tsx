// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CvAutoMode } from "./CvAutoMode";
import { openOrClaimAutoCv, readAutoCvSourceChoices } from "@/app/actions/cv-editing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/cv-editing", () => ({ openOrClaimAutoCv: vi.fn(), openCvAutoEdition: vi.fn(), readAutoCvSourceChoices: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const group = { conflictId: "conflict-1", groupKey: "revenue", fingerprint: "current-fingerprint",
  recordId: "record-1", title: "Service launch", statements: [{ id: "one", text: "Revenue of £1m" }, { id: "two", text: "Revenue of £2m" }] };
const choice = { groupKey: group.groupKey, fingerprint: group.fingerprint, chosenAssertionId: "two" };
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;
async function reveal() {
  await act(async () => {
    const details = container.querySelector("details")!;
    details.open = true; details.dispatchEvent(new Event("toggle"));
  });
}

it("builds without loading or resolving the optional review queue", async () => {
  vi.mocked(openOrClaimAutoCv).mockResolvedValue({ ok: true, status: "queued", charged: true, sourceReview: [group] });
  act(() => root.render(<CvAutoMode contextId="context" selectedBaseline={null} />));
  expect(readAutoCvSourceChoices).not.toHaveBeenCalled();
  await act(async () => button("Create Auto CV").click());
  expect(openOrClaimAutoCv).toHaveBeenCalledWith("context", "update", []);
  expect(container.textContent).toContain("Auto is building");
  expect(container.textContent).toContain("build and finalise without resolving Experience reviews");
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input[value=""]')?.checked).toBe(true);
  expect(button("Create Auto CV").disabled).toBe(false);
});

it("restores saved CV-only choices and retains an edited choice after a failed build", async () => {
  vi.mocked(readAutoCvSourceChoices).mockResolvedValue({ ok: true, conflicts: [group] });
  vi.mocked(openOrClaimAutoCv).mockResolvedValue({ ok: false, error: "Experience changed. Refresh choices." });
  act(() => root.render(<CvAutoMode contextId="context" selectedBaseline={null} initialChoices={[choice]} />));
  await reveal();
  expect(container.querySelector<HTMLInputElement>('input[value="two"]')?.checked).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[value="one"]')!.click());
  await act(async () => button("Create Auto CV").click());
  expect(openOrClaimAutoCv).toHaveBeenCalledWith("context", "update", [{ ...choice, chosenAssertionId: "one" }]);
  expect(container.querySelector<HTMLInputElement>('input[value="one"]')?.checked).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Refresh choices");
  expect(container.querySelector<HTMLAnchorElement>('a[href^="/library/review"]')?.target).toBe("_blank");
  act(() => button("Reset CV-only choices").click());
  await act(async () => button("Create Auto CV").click());
  expect(openOrClaimAutoCv).toHaveBeenLastCalledWith("context", "update", []);
});

it("preserves saved choices when optional loading fails and lets the person retry", async () => {
  vi.mocked(readAutoCvSourceChoices).mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ok: true, conflicts: [group] });
  act(() => root.render(<CvAutoMode contextId="context" selectedBaseline={null} initialChoices={[choice]} />));
  await reveal();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("selections are unchanged");
  expect(button("Create Auto CV").disabled).toBe(false);
  await act(async () => button("Refresh choices").click());
  expect(container.querySelector<HTMLInputElement>('input[value="two"]')?.checked).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
