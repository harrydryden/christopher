// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CvContextModes } from "./CvContextModes";
import { useCvContextLayout } from "./CvContextLayout";
import { resolveCvTheme } from "@col/core/cv";

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

it("uses one Layout control with separate mounted Refine and Manual appearance buffers", () => {
  const initial = resolveCvTheme(null);
  function Mode({ mode }: { mode: "refine" | "manual" }) {
    const [theme, setTheme] = useState(initial);
    useCvContextLayout(mode, theme, setTheme, mode === "refine" ? () => {} : undefined);
    return <p>{mode} font: {theme.font}</p>;
  }
  act(() => root.render(<CvContextModes initialMode="refine" auto={<p>Auto</p>}
    refine={<Mode mode="refine" />} manual={<Mode mode="manual" />} />));
  const choose = (label: string) => act(() => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.startsWith(label))!.click());
  const layout = container.querySelector<HTMLDetailsElement>("#cv-context-layout")!;
  act(() => { layout.open = true; });
  const font = () => container.querySelector<HTMLSelectElement>('select[aria-label="Font"]')!;
  act(() => { font().value = "Arial"; font().dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("refine font: Arial");
  choose("Manual");
  expect(font().value).toBe(initial.font);
  choose("Refine");
  expect(font().value).toBe("Arial");
  expect(container.querySelectorAll("#cv-context-layout")).toHaveLength(1);
});

it("maps a legacy fragment once and permits later mode switches without replaying the old hash", () => {
  window.history.replaceState(null, "", "#cv-panel-appearance");
  act(() => root.render(<CvContextModes initialMode="auto" auto={<p>Auto</p>}
    refine={<p>Refine</p>} manual={<p>Manual</p>} />));
  expect(container.querySelector<HTMLButtonElement>("#cv-mode-refine")?.getAttribute("aria-pressed")).toBe("true");
  const layout = container.querySelector<HTMLDetailsElement>("#cv-context-layout")!;
  expect(layout.open).toBe(true);
  act(() => container.querySelector<HTMLButtonElement>("#cv-mode-manual")!.click());
  expect(container.querySelector<HTMLButtonElement>("#cv-mode-manual")?.getAttribute("aria-pressed")).toBe("true");
  act(() => container.querySelector<HTMLButtonElement>("#cv-mode-auto")!.click());
  expect(container.querySelector<HTMLButtonElement>("#cv-mode-auto")?.getAttribute("aria-pressed")).toBe("true");
  window.history.replaceState(null, "", window.location.pathname);
});

it("disables only the active mode's shared Layout while its save is pending", () => {
  const theme = resolveCvTheme(null);
  function PendingMode() { useCvContextLayout("refine", theme, () => {}, () => {}, true); return <p>Refine pending</p>; }
  function ReadyMode() { useCvContextLayout("manual", theme, () => {}); return <p>Manual ready</p>; }
  act(() => root.render(<CvContextModes initialMode="refine" auto={<p>Auto</p>}
    refine={<PendingMode />} manual={<ReadyMode />} />));
  expect(container.querySelector<HTMLFieldSetElement>("#cv-context-layout > div > fieldset")?.disabled).toBe(true);
  act(() => container.querySelector<HTMLButtonElement>("#cv-mode-manual")!.click());
  expect(container.querySelector<HTMLFieldSetElement>("#cv-context-layout > div > fieldset")?.disabled).toBe(false);
});

it("opens the matching visible item for a legacy content fragment, then permits another mode", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const entry = "role:one";
  const hash = `#cv-content-section-${encodeURIComponent(entry)}`;
  act(() => root.render(<CvContextModes initialMode="auto" auto={<p>Auto</p>}
    refine={<section data-cv-source-entry={entry}><button type="button">Refine role one</button></section>}
    manual={<section data-cv-source-entry={entry}><button type="button">Manual role one</button></section>} />));
  act(() => { window.history.pushState(null, "", hash); window.dispatchEvent(new HashChangeEvent("hashchange")); });
  act(() => { for (const callback of frames.splice(0)) callback(0); });
  expect(container.querySelector<HTMLButtonElement>("#cv-mode-refine")?.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement?.textContent).toBe("Refine role one");
  act(() => container.querySelector<HTMLButtonElement>("#cv-mode-manual")!.click());
  expect(container.querySelector<HTMLButtonElement>("#cv-mode-manual")?.getAttribute("aria-pressed")).toBe("true");
  window.history.replaceState(null, "", window.location.pathname);
  vi.unstubAllGlobals();
});

it("focuses a cold Refine item when its lazy content arrives after the legacy fragment", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const entry = "role:later";
  const props = { initialMode: "auto" as const, auto: <p>Auto</p>, manual: <p>Manual</p> };
  act(() => root.render(<CvContextModes {...props} refine={<p>Loading Refine…</p>} />));
  act(() => { window.history.pushState(null, "", `#cv-content-section-${encodeURIComponent(entry)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange")); });
  act(() => { for (const callback of frames.splice(0)) callback(0); });
  expect(container.querySelector<HTMLButtonElement>("#cv-mode-refine")?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => root.render(<CvContextModes {...props} refine={<section data-cv-source-entry={entry}>
    <button type="button">Delayed source item</button></section>} />));
  expect(document.activeElement?.textContent).toBe("Delayed source item");
  window.history.replaceState(null, "", window.location.pathname);
  vi.unstubAllGlobals();
});

it("ignores a malformed fragment that replaces a scheduled item focus", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  act(() => root.render(<CvContextModes initialMode="auto" auto={<p>Auto</p>}
    refine={<section data-cv-source-entry="role:one"><button type="button">Refine role</button></section>}
    manual={<p>Manual</p>} />));
  act(() => { window.history.pushState(null, "", "#cv-content-section-role%3Aone");
    window.dispatchEvent(new HashChangeEvent("hashchange")); });
  window.history.replaceState(null, "", "#%ZZ");
  expect(() => act(() => { for (const callback of frames.splice(0)) callback(0); })).not.toThrow();
  window.history.replaceState(null, "", window.location.pathname);
  vi.unstubAllGlobals();
});
