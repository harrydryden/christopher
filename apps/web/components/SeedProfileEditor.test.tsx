// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/validation";
import { SeedProfileEditor } from "./SeedProfileEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function textarea() { return container.querySelector<HTMLTextAreaElement>('textarea[name="seedProfile"]')!; }
function typeText(value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), value);
  textarea().dispatchEvent(new Event("input", { bubbles: true }));
}
function submit() { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); }

it("adopts a pristine server refresh as a visible text and expected snapshot pair", async () => {
  const action = vi.fn(async (_previous: ActionResult, _data: FormData): Promise<ActionResult> => ({ ok: false, error: "stale" }));
  await act(async () => root.render(<SeedProfileEditor text="Old preference" action={action} />));
  await act(async () => root.render(<SeedProfileEditor text="New preference" action={action} />));
  expect(textarea().value).toBe("New preference");
  await act(async () => { typeText("Edit of new preference"); submit(); });
  expect(action.mock.calls[0]![1].get("expectedSeedProfile")).toBe("New preference");
  expect(action.mock.calls[0]![1].get("seedProfile")).toBe("Edit of new preference");
});

it("retains dirty text and its old guard across a refresh from the other page", async () => {
  const action = vi.fn(async (_previous: ActionResult, _data: FormData): Promise<ActionResult> => ({ ok: false, error: "Preferences changed." }));
  await act(async () => root.render(<SeedProfileEditor text="Old preference" action={action} />));
  await act(async () => typeText("My unsaved draft"));
  await act(async () => root.render(<SeedProfileEditor text="Other page's preference" action={action} />));
  expect(textarea().value).toBe("My unsaved draft");
  await act(async () => submit());
  expect(action.mock.calls[0]![1].get("expectedSeedProfile")).toBe("Old preference");
  expect(textarea().value).toBe("My unsaved draft");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Preferences changed.");
});

it("keeps a newer pending edit and advances only to its own confirmed save", async () => {
  let resolve!: (result: ActionResult) => void;
  const action = vi.fn((_previous: ActionResult, _data: FormData) =>
    action.mock.calls.length === 1 ? new Promise<ActionResult>(done => { resolve = done; }) : Promise.resolve({ ok: false, error: "stale" } as ActionResult));
  await act(async () => root.render(<SeedProfileEditor text="Old preference" action={action} />));
  act(() => { typeText("First edit"); submit(); });
  await act(async () => typeText("Further edit while saving"));
  await act(async () => resolve({ ok: true, nextSnapshot: { expectedSeedProfile: "First edit" } }));
  await act(async () => root.render(<SeedProfileEditor text="Third tab's preference" action={action} />));
  await act(async () => submit());
  expect(action.mock.calls[0]![1].get("expectedSeedProfile")).toBe("Old preference");
  expect(action.mock.calls[1]![1].get("expectedSeedProfile")).toBe("First edit");
  expect(textarea().value).toBe("Further edit while saving");
});
