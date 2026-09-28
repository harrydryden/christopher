// @vitest-environment jsdom
/**
 * The action-call hook's guard: two presses that land before React re-renders make one call, and a
 * thrown action shows its sentence, or is rethrown when it has none.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useActionCall } from "./useActionCall";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let call: ReturnType<typeof useActionCall<string>>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe() {
  call = useActionCall<string>();
  return null;
}

it("makes one call for two presses in the same tick, and says which call is in flight", async () => {
  let finish!: () => void;
  const action = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  act(() => {
    call.run("a", action);
    call.run("b", action);
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect(call.pending).toBe("a");
  expect(call.busy).toBe(true);
  await act(async () => { finish(); });
  expect(call.busy).toBe(false);
  // Free again once it has settled.
  act(() => call.run("c", async () => undefined));
  expect(action).toHaveBeenCalledTimes(1);
});

it("shows the sentence a thrown action was given, and asks before starting when told to", async () => {
  await act(async () => { call.run("a", async () => { throw new Error("offline"); }, { failed: "Could not save." }); });
  expect(call.error).toBe("Could not save.");

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const action = vi.fn(async () => undefined);
  act(() => call.run("b", action, { confirm: "Delete it?" }));
  expect(confirm).toHaveBeenCalledWith("Delete it?");
  expect(action).not.toHaveBeenCalled();
  // A refusal starts nothing, so the earlier sentence is still on screen.
  expect(call.error).toBe("Could not save.");
  confirm.mockRestore();
});
