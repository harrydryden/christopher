// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/app/actions/library-import", () => ({ importLibraryDocument: vi.fn() }));
import { LibraryImportCard } from "./LibraryImportCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("keeps pasted text when switching import sources with the keyboard", () => {
  act(() => root.render(<LibraryImportCard />));
  const cv = container.querySelector<HTMLButtonElement>("#library-import-source-tab-cv")!;
  act(() => { cv.focus(); cv.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  const linkedIn = container.querySelector<HTMLButtonElement>("#library-import-source-tab-linkedin")!;
  expect(document.activeElement).toBe(linkedIn);
  act(() => linkedIn.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  const paste = container.querySelector<HTMLButtonElement>("#library-import-source-tab-paste")!;
  expect(paste.getAttribute("aria-selected")).toBe("true");
  const draft = container.querySelector<HTMLTextAreaElement>('#library-import-paste textarea[name="content"]')!;
  draft.value = "My unsent work history";
  act(() => container.querySelector<HTMLButtonElement>("#library-import-source-tab-website")!.click());
  expect(container.querySelector<HTMLElement>("#library-import-paste")?.hidden).toBe(true);
  act(() => paste.click());
  expect(container.querySelector<HTMLTextAreaElement>('#library-import-paste textarea[name="content"]')).toBe(draft);
  expect(draft.value).toBe("My unsent work history");
});
