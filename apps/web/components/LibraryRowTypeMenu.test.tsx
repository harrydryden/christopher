// @vitest-environment jsdom
/**
 * A row's Type menu, in a browser: it opens on its first chosen type, stays open while types are
 * toggled, is laid out against the viewport and flipped above its trigger near the bottom of the
 * screen, and closes on Escape (caret back on the trigger), Tab, or a pointer outside.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EvidenceFacet } from "@ava/core/cv-helpers";
import { LibraryRowTypeMenu } from "./LibraryRowTypeMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render(value: EvidenceFacet[], onChange = vi.fn()) {
  act(() => root.render(<LibraryRowTypeMenu label="Type of row 1" value={value} onChange={onChange} />));
  return { trigger: container.querySelector<HTMLButtonElement>("button")!, onChange };
}
const menu = () => container.querySelector<HTMLElement>("[role=menu]");
const press = (target: Element, key: string) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const rect = (top: number, bottom: number) => ({ top, bottom, left: 10, right: 200, width: 190, height: bottom - top, x: 10, y: top, toJSON: () => ({}) });

it("opens on the first chosen type and stays open while types are toggled", () => {
  const { trigger, onChange } = render(["outcome", "metric"]);
  act(() => trigger.click());
  expect(menu()).not.toBeNull();
  expect(document.activeElement?.textContent).toBe("Outcomes");
  act(() => (document.activeElement as HTMLButtonElement).click());
  expect(onChange).toHaveBeenCalledWith(["metric"]);
  expect(menu()).not.toBeNull();
});

it("closes on Escape with the caret back on the trigger, and on Tab or a pointer outside", () => {
  const { trigger } = render([]);
  act(() => trigger.click());
  press(document.activeElement!, "Escape");
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(trigger);

  act(() => trigger.click());
  press(document.activeElement!, "Tab");
  expect(menu()).toBeNull();

  act(() => trigger.click());
  act(() => { document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  expect(menu()).toBeNull();
});

it("sits below its trigger, and above it when it would fall off the bottom of the screen", () => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(240);
  const { trigger } = render([]);
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(100, 164) as DOMRect);
  act(() => trigger.click());
  expect(menu()!.style.top).toBe("168px");
  expect(menu()!.style.left).toBe("10px");
  act(() => trigger.click());

  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(window.innerHeight - 70, window.innerHeight - 6) as DOMRect);
  act(() => trigger.click());
  expect(menu()!.style.top).toBe(`${window.innerHeight - 70 - 4 - 200}px`);
});
