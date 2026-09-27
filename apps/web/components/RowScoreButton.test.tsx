// @vitest-environment jsdom
/**
 * A Library row's score cell, in a browser: the bar is a button, and what the row is missing opens
 * on a click, never on a hover, in a panel that Escape closes and hands the caret back from.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RowGuidance } from "@/lib/cv-library-evidence";
import { RowScoreButton } from "./RowScoreButton";

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
  document.body.innerHTML = "";
});

const TYPED: RowGuidance = {
  score: 50,
  heading: "50/100 · Scored as Responsibilities",
  missing: [{
    facet: "responsibility",
    label: "Responsibilities",
    asks: ["Say your part: led it, ran it, owned it, built it or supported it.", "Give the size: headcount, budget, revenue, sites, customers or how often."],
  }],
  footer: "From your own wording; Re-score for the full review.",
};

const UNTYPED: RowGuidance = {
  score: null,
  heading: "Select type",
  missing: [],
  footer: "Choose one or more types in the Type column; the row is scored against what each type needs.",
};

function render(guidance: RowGuidance, index = 3) {
  act(() => root.render(<RowScoreButton index={index} guidance={guidance} />));
  return container.querySelector("button")!;
}
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const press = (target: Element, key: string) =>
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

it("draws the bar inside a button named for what it opens, with no hover text anywhere", () => {
  const trigger = render(TYPED);
  expect(trigger.getAttribute("type")).toBe("button");
  expect(trigger.getAttribute("aria-label")).toBe("Score 50 of 100 for row 3: show what is missing");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.textContent).toBe("50");
  expect(trigger.querySelectorAll(".h-2")).toHaveLength(10);
  expect(container.querySelector("[title]")).toBeNull();
  act(() => trigger.click());
  expect(document.querySelector("[title]")).toBeNull();
});

it("opens on a click, not a hover, and lists only what is missing", () => {
  const trigger = render(TYPED);
  act(() => {
    trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
  expect(dialog()).toBeNull();
  act(() => trigger.click());
  const panel = dialog()!;
  expect(panel).not.toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-label")).toBe(TYPED.heading);
  expect(panel.getAttribute("aria-modal")).toBeNull();
  expect(panel.querySelector("p")!.textContent).toBe(TYPED.heading);
  expect(panel.textContent).toContain("Responsibilities");
  expect([...panel.querySelectorAll("li")].map(item => item.textContent)).toEqual(TYPED.missing[0]!.asks);
  expect(panel.textContent).toContain(TYPED.footer);
  // Laid out against the viewport, so the table's scroller cannot clip it.
  expect(panel.className).toContain("fixed");
  expect(panel.style.top).not.toBe("");
  // A second click closes it.
  act(() => trigger.click());
  expect(dialog()).toBeNull();
});

it("closes on Escape and gives the caret back to the score", () => {
  const trigger = render(TYPED);
  act(() => trigger.click());
  const panel = dialog()!;
  act(() => panel.focus());
  press(panel, "Escape");
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  // Escape on the score itself, where the caret is after a click, closes it too.
  act(() => trigger.click());
  press(trigger, "Escape");
  expect(dialog()).toBeNull();
});

it("closes on a click or a focus anywhere else", () => {
  const outside = document.createElement("textarea");
  document.body.append(outside);
  const trigger = render(TYPED);
  act(() => trigger.click());
  act(() => { outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  expect(dialog()).toBeNull();
  act(() => trigger.click());
  act(() => outside.focus());
  expect(dialog()).toBeNull();
});

it("asks for a type on a row that has none, and says why when opened", () => {
  const trigger = render(UNTYPED, 1);
  expect(trigger.textContent).toBe("Select type");
  expect(trigger.getAttribute("aria-label")).toBe("Select a type for row 1");
  expect(trigger.querySelector("span")!.className).toBe("text-12 text-muted underline");
  act(() => trigger.click());
  const panel = dialog()!;
  expect(panel.getAttribute("aria-label")).toBe("Select type");
  expect(panel.querySelector("ul")).toBeNull();
  expect(panel.textContent).toContain(UNTYPED.footer);
});
