// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DEFAULT_CV_THEME } from "@col/core/cv-theme-values";
import type { CvContent } from "@col/core/cv";

const schemaGate = vi.hoisted(() => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release: () => release() };
});
vi.mock("@/app/actions/cv", () => ({ saveCvDraft: vi.fn(), requestCvSkillSuggestions: vi.fn(), readCvSkillSuggestions: vi.fn() }));
vi.mock("@/app/actions/cv-targeting", () => ({ confirmCvTargetingPriorities: vi.fn() }));
vi.mock("@col/core/cv", async () => {
  await schemaGate.waiting;
  return { CvContentSchema: { safeParse: (data: unknown) => ({ success: true, data }) } };
});

import { CvDraftEditor } from "./CvDraftEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("does not POST a preview when the editor unmounts before lazy validation resolves", async () => {
  const content = { name: "Ada", contact: "ada@example.com", summary: "Supported work.", gaps: [],
    sections: [{ entryId: "role", kind: "experience", heading: "Analyst", bullets: ["Built reports."] }] } as CvContent;
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} />));
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === "Preview current edits")!;
    act(() => button.click());
    expect(container.textContent).toContain("Rendering preview");
    act(() => root.unmount());
    await act(async () => { schemaGate.release(); await schemaGate.waiting; });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    container.remove();
    vi.unstubAllGlobals();
  }
});
