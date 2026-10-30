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

it("opens an unchanged preview without rendering it again and rejects missing page counts", async () => {
  const content = { name: "Ada", contact: "ada@example.com", summary: "Supported analyst work.", gaps: [],
    sections: [{ entryId: "role", kind: "experience", heading: "Analyst", bullets: ["Built reports."] }] } as CvContent;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:cv-preview"), revokeObjectURL: vi.fn() }));
  const fetch = vi.fn(async () => new Response(new Blob(["%PDF-"]), { headers: { "x-cv-page-count": "2" } }));
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} />));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Preview current edits")!.click());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLAnchorElement>('a[href="blob:cv-preview"]')?.textContent).toContain("Open current preview");
    expect(container.querySelector('iframe[title="Current CV PDF preview"]')).toBeNull();
    const toggle = [...container.querySelectorAll("button")].find(button => button.textContent === "Show preview on this page")!;
    await act(async () => toggle.click());
    expect(container.querySelector('iframe[title="Current CV PDF preview"]')).not.toBeNull();
    await act(async () => toggle.click());
    expect(container.querySelector('iframe[title="Current CV PDF preview"]')).toBeNull();
    await act(async () => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} />));
    expect(fetch).toHaveBeenCalledTimes(1);
    const summary = container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(summary, "Changed.");
      summary.dispatchEvent(new Event("input", { bubbles: true })); });
    fetch.mockImplementationOnce(async () => new Response(new Blob(["%PDF-"])));
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Preview current edits")!.click());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("no valid page count");
    expect(container.textContent).not.toContain("0 pages rendered");
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});

it("starts only one preview while lazy validation is still resolving", async () => {
  const content = { name: "Ada", contact: "ada@example.com", summary: "Supported analyst work.", gaps: [],
    sections: [{ entryId: "role", kind: "experience", heading: "Analyst", bullets: ["Built reports."] }] } as CvContent;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:cv-preview"), revokeObjectURL: vi.fn() }));
  const fetch = vi.fn(async () => new Response(new Blob(["%PDF-"]), { headers: { "x-cv-page-count": "1" } }));
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CvDraftEditor id="cv-1" content={content} theme={DEFAULT_CV_THEME} />));
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === "Preview current edits")!;
    // Both clicks happen before React rerenders the disabled button or the dynamic schema resolves.
    await act(async () => { button.click(); button.click(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("1 page rendered");
  } finally {
    await act(async () => root.unmount()); container.remove();
  }
});
