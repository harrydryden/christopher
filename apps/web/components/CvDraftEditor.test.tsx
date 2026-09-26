// @vitest-environment jsdom
/**
 * The CV editor's preview loads the content check on first use. When that chunk cannot be fetched
 * (offline, or a deployment that replaced it), the button must say so, not quietly do nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CV_THEME } from "@ava/core/cv-theme-values";
import type { CvContent } from "@ava/core/cv";

vi.mock("@/app/actions/cv", () => ({ saveCvDraft: vi.fn() }));
// The lazily loaded check, unreachable: `import("@ava/core/cv")` rejects as a failed chunk would.
vi.mock("@ava/core/cv", () => { throw new Error("Failed to fetch dynamically imported module"); });

import { CvDraftEditor } from "./CvDraftEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const content = {
  name: "Ada Lovelace", contact: "ada@example.com", summary: "Analyst.", gaps: [],
  sections: [{ entryId: "e-1", kind: "experience", heading: "Analyst, Engines Ltd", bullets: ["Wrote the first program."] }],
} as unknown as CvContent;

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
});

it("says the preview could not load when its check cannot be fetched", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  try {
    act(() => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} />));
    const button = [...container.querySelectorAll("button")].find(el => el.textContent === "Preview current edits")!;
    await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load the preview");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
