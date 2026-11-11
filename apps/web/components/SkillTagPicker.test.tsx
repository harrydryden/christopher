// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillTagPicker } from "./SkillTagPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("selects several exact labels without splitting a comma-containing skill", () => {
  const add = vi.fn();
  act(() => root.render(<SkillTagPicker label="Choose skills" selected={["Planning, delivery"]}
    choices={["PLANNING, DELIVERY", "SQL", "Python", "sql"]} limit={3} onAdd={add} onRemove={vi.fn()} />));
  expect(container.querySelectorAll('button[aria-label="Add PLANNING, DELIVERY"]')).toHaveLength(0);
  expect(container.querySelectorAll('button[aria-label^="Add "]')).toHaveLength(2);
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Add SQL"]')!.click());
  expect(add).toHaveBeenCalledWith("SQL");
  const input = container.querySelector<HTMLInputElement>('input[maxlength="150"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Analysis, reporting");
    input.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => [...container.querySelectorAll("button")].find(button => button.textContent === "Add skill")!.click());
  expect(add).toHaveBeenCalledWith("Analysis, reporting");
});
