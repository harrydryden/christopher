// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CvContextModes } from "./CvContextModes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("keeps an unsaved Refine buffer mounted when Manual and Auto are viewed", () => {
  act(() => root.render(<CvContextModes initialMode="refine"
    auto={<p>Auto content</p>} refine={<label>Instruction <textarea defaultValue="" /></label>}
    manual={<p>Manual content</p>} />));
  const instruction = container.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => { instruction.value = "Use my exact project wording"; instruction.dispatchEvent(new Event("input", { bubbles: true })); });
  const choose = (label: string) => {
    const button = [...container.querySelectorAll("button")].find(item => item.textContent?.startsWith(label))!;
    act(() => button.click());
  };
  choose("Manual"); choose("Auto"); choose("Refine");
  expect(container.querySelector("textarea")).toBe(instruction);
  expect(instruction.value).toBe("Use my exact project wording");
  expect(container.querySelector('[aria-pressed="true"]')?.textContent).toContain("Refine");
});
