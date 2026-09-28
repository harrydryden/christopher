// @vitest-environment jsdom
/**
 * The poll loop every live page shares: it parks a hidden tab, asks at once on return with the time
 * away given back to its ceiling, re-reads whole on "resync", and stops for good when torn down.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVisiblePoll, type VisiblePoll } from "./useVisiblePoll";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setVisibility("visible");
  vi.useRealTimers();
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function Poller({ loop }: { loop: () => VisiblePoll }) {
  useVisiblePoll(loop, [loop]);
  return null;
}

it("parks while hidden, asks at once on return, and gives the time away back to the ceiling", async () => {
  const read = vi.fn(async () => 1_000);
  const loop = () => ({ first: 1_000, ceilingMs: 5_000, read, fail: () => 1_000 });
  act(() => root.render(<Poller loop={loop} />));
  await advance(2_000);
  expect(read).toHaveBeenCalledTimes(2);

  act(() => setVisibility("hidden"));
  await advance(60_000);
  // The tick due at three seconds found the tab hidden and parked; nothing more was asked.
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => { setVisibility("visible"); await vi.advanceTimersByTimeAsync(0); });
  expect(read).toHaveBeenCalledTimes(3);

  // Three of the five seconds were spent looking before the tab was hidden, so two remain.
  await advance(60_000);
  expect(read).toHaveBeenCalledTimes(5);
});

it("reads at once when asked to, re-reads whole on resync, and stops on null", async () => {
  const answers: Array<number | null | "resync"> = ["resync", 1_000, null];
  const read = vi.fn(async (_signal: AbortSignal, _alive: () => boolean, _resync: boolean) => {
    const next = answers.shift();
    if (next === undefined) throw new Error("no more");
    return next;
  });
  const fail = vi.fn(() => null);
  act(() => root.render(<Poller loop={() => ({ first: "now", read, fail })} />));
  await advance(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.map((call) => call[2])).toEqual([false, true]);
  await advance(1_000);
  expect(read).toHaveBeenCalledTimes(3);
  // A null answer stops the loop.
  await advance(60_000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(fail).not.toHaveBeenCalled();
});

it("aborts the reading in flight and asks nothing more once unmounted", async () => {
  let seen: AbortSignal | undefined;
  const read = vi.fn((signal: AbortSignal) => {
    seen = signal;
    return new Promise<number>(() => undefined);
  });
  const fail = vi.fn(() => 1_000);
  act(() => root.render(<Poller loop={() => ({ first: 0, read, fail })} />));
  await advance(0);
  expect(read).toHaveBeenCalledTimes(1);
  act(() => root.render(<></>));
  expect(seen!.aborted).toBe(true);
  await advance(60_000);
  expect(read).toHaveBeenCalledTimes(1);
});
