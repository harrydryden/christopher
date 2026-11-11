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

it("keeps every appearance control visible beside a compact, current-theme sample", () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<CvAppearance value={{ ...DEFAULT_CV_THEME, introPanel: true }} name="theme" />));
  const sample = container.querySelector('[aria-label="Palette sample"]')!;
  expect(sample.textContent).toContain("Profile · A concise introduction.");
  expect(sample.textContent).toContain("Experience");
  expect(sample.textContent?.match(/Healthcare/g)).toHaveLength(1);
  expect(sample.textContent).not.toContain("Executive Summary");
  expect(container.querySelectorAll("details")).toHaveLength(0);
  for (const name of ["Font", "Maximum pages", "Structure", "Profile card fill"])
    expect(container.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
  act(() => root.unmount()); container.remove();
});
