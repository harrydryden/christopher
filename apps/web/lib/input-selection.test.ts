// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { inputSelection } from "./input-selection";

afterEach(() => document.body.replaceChildren());

it.each(["input", "textarea"])("reads the latest %s selection rather than a previous render", tag => {
  const element = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
  element.id = "wording";
  element.value = "Selected words";
  document.body.append(element);
  element.setSelectionRange(0, 8);
  expect(inputSelection("wording")).toEqual({ start: 0, end: 8 });
  element.setSelectionRange(9, 14);
  expect(inputSelection("wording")).toEqual({ start: 9, end: 14 });
});

it("does not invent a selection for a missing field or unrelated element", () => {
  expect(inputSelection("missing")).toBeNull();
  const element = document.createElement("div");
  element.id = "heading";
  document.body.append(element);
  expect(inputSelection("heading")).toBeNull();
});
