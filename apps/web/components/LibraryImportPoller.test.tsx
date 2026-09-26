// @vitest-environment jsdom
/**
 * The Library's import poller, in a browser: it asks the small status route on each tick and
 * refreshes the page only when the answer moves, rather than re-rendering the whole Library every
 * few seconds while a document is read.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { LibraryImportPoller } from "./LibraryImportPoller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const answer = (body: { reading: number; signature: string }) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

it("does not refresh while the imports stand as the page showed them, and refreshes once when one lands", async () => {
  const fetch = vi.fn<(url: string) => Promise<Response>>().mockResolvedValue(answer({ reading: 1, signature: "1:1:" }));
  vi.stubGlobal("fetch", fetch);
  act(() => root.render(<LibraryImportPoller pending={1} signature="1:1:" />));

  // Five ticks of backing off (5 s, 7.5 s, 11.25 s, then the 20 s cap): asked each time, never refreshed.
  await advance(5_000 + 7_500 + 11_250 + 20_000 + 20_000);
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(fetch.mock.calls[0]![0]).toBe("/api/cv/library/imports");
  expect(router.refresh).not.toHaveBeenCalled();

  fetch.mockResolvedValue(answer({ reading: 0, signature: "1:0:2026-09-26 18:00:00+00" }));
  await advance(20_000);
  expect(router.refresh).toHaveBeenCalledTimes(1);
});

it("refreshes when fewer are being read than the page showed, even if its fingerprint was already current", async () => {
  // The page listed the import as reading, then read the fingerprint just after it landed.
  const fetch = vi.fn<(url: string) => Promise<Response>>().mockResolvedValue(answer({ reading: 0, signature: "1:0:later" }));
  vi.stubGlobal("fetch", fetch);
  act(() => root.render(<LibraryImportPoller pending={1} signature="1:0:later" />));
  await advance(5_000);
  expect(router.refresh).toHaveBeenCalledTimes(1);
});
