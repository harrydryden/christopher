// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LIBRARY_IMPORT_SLOW_MS } from "@/lib/library-import-clock";
import { LibraryImportReading } from "./LibraryImportReading";

vi.mock("@/app/actions/library-import", () => ({ dismissLibraryImport: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("turns an unchanged reading import into an actionable stalled card at fifteen minutes", () => {
  const createdAtMs = Date.now();
  act(() => root.render(<LibraryImportReading id="import-1" createdAtMs={createdAtMs} initialStalled={false} />));
  expect(container.textContent).toContain("Reading your document");
  expect(container.querySelector("button")?.textContent).toBeUndefined();
  act(() => vi.advanceTimersByTime(LIBRARY_IMPORT_SLOW_MS - 1));
  expect(container.textContent).toContain("Reading your document");
  act(() => vi.advanceTimersByTime(1));
  expect(container.textContent).toContain("This is taking longer than usual");
  expect(container.querySelector("button")?.textContent).toBe("Dismiss");
});

it("shows the stall action immediately when an old import is first rendered", () => {
  act(() => root.render(<LibraryImportReading id="import-2" createdAtMs={Date.now() - LIBRARY_IMPORT_SLOW_MS} initialStalled={false} />));
  expect(container.querySelector("button")?.textContent).toBe("Dismiss");
});
