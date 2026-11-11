// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { DEFAULT_CV_THEME, type CvTheme } from "@col/core/cv-theme-values";
import { CvAppearance } from "./CvAppearance";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps the selected CV structure when a colour preset changes", () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  let theme: CvTheme = { ...DEFAULT_CV_THEME, experienceLayout: "project" };
  function render() { act(() => root.render(<CvAppearance value={theme} onChange={next => { theme = next; render(); }} name="theme" />)); }
  render();
  const structure = container.querySelector<HTMLSelectElement>('select[aria-label="Structure"]')!;
  expect(structure.value).toBe("project");
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Navy")!.click());
  expect(theme.experienceLayout).toBe("project");
  expect(JSON.parse(container.querySelector<HTMLInputElement>('input[name="theme"]')!.value).experienceLayout).toBe("project");
  act(() => root.unmount()); container.remove();
});
