// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assessCvDraft } from "@/app/actions/cv";
import { CvCheckForm } from "./CvCheckForm";

vi.mock("@/app/actions/cv", () => ({ assessCvDraft: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  window.history.replaceState(null, "", "/cv/test#cv-panel-evaluation");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CvCheckForm id="test" hasContent />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function submit() {
  container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
}

it("stays in Review on mount and after a failed Check", async () => {
  expect(window.location.hash).toBe("#cv-panel-evaluation");
  vi.mocked(assessCvDraft).mockResolvedValue({ ok: false, error: "Check unavailable." });
  await act(async () => submit());
  expect(assessCvDraft).toHaveBeenCalledOnce();
  expect(window.location.hash).toBe("#cv-panel-evaluation");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Check unavailable.");
});

it("opens Write only after its own confirmed Check", async () => {
  let finish!: (value: { ok: true }) => void;
  vi.mocked(assessCvDraft).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  act(() => submit());
  expect(window.location.hash).toBe("#cv-panel-evaluation");
  await act(async () => finish({ ok: true }));
  expect(window.location.hash).toBe("#cv-panel-content");
});

it("reopens Write when its fragment was already in the URL", async () => {
  window.history.replaceState(null, "", "/cv/test#cv-panel-content");
  const changed = vi.fn();
  window.addEventListener("hashchange", changed);
  try {
    vi.mocked(assessCvDraft).mockResolvedValue({ ok: true });
    await act(async () => submit());
    expect(changed).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("#cv-panel-content");
  } finally {
    window.removeEventListener("hashchange", changed);
  }
});

it("does not navigate when the Check response is unknown", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(assessCvDraft).mockRejectedValue(new TypeError("Failed to fetch"));
  await act(async () => submit());
  expect(window.location.hash).toBe("#cv-panel-evaluation");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't confirm");
});
