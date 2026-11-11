// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

vi.mock("@/app/actions/cv-finalisation", () => ({
  prepareCvFinalisation: vi.fn(), approveCvFinalisation: vi.fn(),
}));
import { prepareCvFinalisation, approveCvFinalisation } from "@/app/actions/cv-finalisation";
import { CvFinaliseControl } from "./CvFinaliseControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("measures before approval, displays actual warnings and requires a deliberate acknowledgement", async () => {
  vi.mocked(prepareCvFinalisation).mockResolvedValue({ ok: true, token: "signed", measuredPages: 3, maxPages: 2,
    assessmentState: "unchecked", warnings: [{ id: "page-limit", text: "Three pages against a two-page limit." }] });
  act(() => root.render(<CvFinaliseControl id="draft" revision={4} baseHash="saved-hash" />));
  expect(container.textContent).toContain("Checking is optional");
  expect(container.textContent).not.toContain("Three pages against");
  await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
  expect(prepareCvFinalisation).toHaveBeenCalledWith("draft", 4, "saved-hash");
  expect(container.textContent).toContain("3 pages");
  expect(container.textContent).toContain("not checked");
  expect(container.textContent).toContain("Three pages against a two-page limit.");
  const approve = [...container.querySelectorAll("button")].find(button => button.textContent === "Finalise this CV")!;
  expect(approve.disabled).toBe(true);
  act(() => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  expect(approve.disabled).toBe(false);
  expect(approveCvFinalisation).not.toHaveBeenCalled();
});

it("does not measure or approve while a mounted editor has unsaved wording", async () => {
  const dirty = document.createElement("div"); dirty.dataset.cvEditorDirty = "true"; dirty.dataset.cvEditorId = "draft"; document.body.append(dirty);
  try {
    act(() => root.render(<CvFinaliseControl id="draft" revision={4} baseHash="saved-hash" />));
    await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(container.textContent).toContain("Save your CV edits");
    expect(prepareCvFinalisation).not.toHaveBeenCalled();
  } finally { dirty.remove(); }
});

it("does not approve a saved Manual edition while its visible Manual buffer differs", async () => {
  const dirty = document.createElement("div"); dirty.dataset.cvModeDirty = "true";
  dirty.dataset.cvModeEditorId = "manual-edition"; document.body.append(dirty);
  try {
    act(() => root.render(<CvFinaliseControl id="manual-edition" revision={2} baseHash="saved" />));
    await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(container.textContent).toContain("Save your CV edits");
    expect(prepareCvFinalisation).not.toHaveBeenCalled();
  } finally { dirty.remove(); }
});

it("ignores unsaved wording in a different mounted mode or edition", async () => {
  const other = document.createElement("div"); other.dataset.cvEditorDirty = "true"; other.dataset.cvEditorId = "refine-edition";
  const otherMode = document.createElement("div"); otherMode.dataset.cvModeDirty = "true";
  otherMode.dataset.cvModeEditorId = "other-manual-edition";
  document.body.append(other, otherMode);
  vi.mocked(prepareCvFinalisation).mockResolvedValue({ ok: true, token: "signed", measuredPages: 1, maxPages: 2,
    assessmentState: "unchecked", warnings: [{ id: "assessment", text: "Not checked" }] });
  vi.mocked(approveCvFinalisation).mockResolvedValue({ ok: true });
  try {
    act(() => root.render(<CvFinaliseControl id="manual-edition" revision={2} baseHash="saved" />));
    await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(prepareCvFinalisation).toHaveBeenCalledWith("manual-edition", 2, "saved");
    expect(other.dataset.cvEditorDirty).toBe("true");
    act(() => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Finalise this CV")!.click(); });
    expect(approveCvFinalisation).toHaveBeenCalledOnce();
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(other.dataset.cvEditorDirty).toBe("true");
    expect(container.textContent).toContain("The saved PDF is now available");
  } finally { other.remove(); otherMode.remove(); }
});


it("waits for a saved child to arrive before offering final approval", async () => {
  const editor = document.createElement("div");
  editor.dataset.cvModePending = "true";
  editor.dataset.cvModeDirty = "true";
  editor.dataset.cvModeEditorId = "old-draft";
  document.body.append(editor);
  vi.mocked(prepareCvFinalisation).mockResolvedValue({ ok: true, token: "signed", measuredPages: 1,
    maxPages: 2, assessmentState: "unchecked", warnings: [] });
  try {
    await act(async () => root.render(<CvFinaliseControl id="old-draft" revision={2} baseHash="old" />));
    const review = container.querySelector<HTMLButtonElement>("button")!;
    expect(review.disabled).toBe(true);
    await act(async () => review.click());
    expect(prepareCvFinalisation).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Save your CV edits before");
    await act(async () => {
      root.render(<CvFinaliseControl id="new-draft" revision={3} baseHash="new" />);
      editor.dataset.cvModePending = "false";
      editor.dataset.cvModeDirty = "false";
      editor.dataset.cvModeEditorId = "new-draft";
    });
    expect(review.disabled).toBe(false);
    await act(async () => review.click());
    expect(prepareCvFinalisation).toHaveBeenCalledWith("new-draft", 3, "new");
  } finally { editor.remove(); }
});
