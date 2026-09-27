// @vitest-environment jsdom
/**
 * The Library's evidence poller, in a browser: it asks the reviews route while a version is being
 * scored, refreshes when the answer moves, and asks nothing of a hidden tab, without letting the
 * time away use up the ten minutes it watches for.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { LibraryEvidencePoller } from "./LibraryEvidencePoller";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const answer = (signature: string) => ({ ok: true, status: 200, json: async () => ({ signature }) }) as unknown as Response;

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

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

it("refreshes once when a review lands", async () => {
  const fetch = vi.fn<(url: string) => Promise<Response>>().mockResolvedValue(answer("v4:pending"));
  vi.stubGlobal("fetch", fetch);
  act(() => root.render(<LibraryEvidencePoller version={4} signature="v4:pending" />));
  await advance(5_000 + 7_500);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![0]).toBe("/api/cv/library/reviews?version=4");
  expect(router.refresh).not.toHaveBeenCalled();
  fetch.mockResolvedValue(answer("v4:scored"));
  await advance(11_250);
  expect(router.refresh).toHaveBeenCalledTimes(1);
});

it("parks while the tab is hidden, and asks at once on return however long it was away", async () => {
  const fetch = vi.fn<(url: string) => Promise<Response>>().mockResolvedValue(answer("v4:pending"));
  vi.stubGlobal("fetch", fetch);
  try {
    act(() => root.render(<LibraryEvidencePoller version={4} signature="v4:pending" />));
    await advance(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => setVisibility("hidden"));
    await advance(15 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(answer("v4:scored"));
    await act(async () => { setVisibility("visible"); await vi.advanceTimersByTimeAsync(0); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // Still watching afterwards, on the time it has left.
    fetch.mockResolvedValue(answer("v4:scored"));
    await advance(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    act(() => setVisibility("visible"));
  }
});
