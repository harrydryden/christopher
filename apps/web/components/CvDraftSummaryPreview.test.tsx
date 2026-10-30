// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CV_THEME } from "@col/core/cv-theme-values";
import type { CvContent } from "@col/core/cv";

vi.mock("@/app/actions/cv", () => ({ saveCvDraft: vi.fn(), requestCvSkillSuggestions: vi.fn(), readCvSkillSuggestions: vi.fn() }));
vi.mock("@/app/actions/cv-targeting", () => ({ confirmCvTargetingPriorities: vi.fn() }));
vi.mock("@col/core/cv", () => ({ CvContentSchema: { safeParse: (data: unknown) => ({ success: true, data }) } }));

import { CvDraftEditor } from "./CvDraftEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

it("shows measured summary lines only for the matching preview and leaves legacy wording intact", async () => {
  const content = { name: "Ada", contact: "ada@example.com", summary: "Supported analyst work.", gaps: [],
    sections: [{ entryId: "role", kind: "experience", heading: "Analyst", bullets: ["Built reports."] }] } as CvContent;
  const createObjectURL = vi.fn(() => "blob:cv-preview");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["%PDF-"]), { headers: {
    "x-cv-page-count": "1", "x-cv-summary-lines": "4",
  } })));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CvDraftEditor id="cv-1" content={content}
      theme={{ ...DEFAULT_CV_THEME, bodySizePt: 12, maxPages: 2 }} />));
    expect(container.textContent).toContain("Preview current edits to measure them");
    expect(container.textContent).toContain("Executive Summary");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Preview current edits")!.click());
    expect(container.textContent).toContain("takes 4 rendered lines");
    const summary = container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "Revised supported work.");
      summary.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Preview current edits to measure them");
    expect(container.textContent).not.toContain("takes 4 rendered lines");
    await act(async () => root.render(<CvDraftEditor key="legacy" id="legacy" content={content} theme={DEFAULT_CV_THEME} />));
    expect(container.querySelector('label:has(textarea[name="summary"])')?.textContent).toContain("Profile");
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
