// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CvContent } from "@col/core/cv";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/cv", () => ({ requestCvSkillSuggestions: vi.fn(), readCvSkillSuggestions: vi.fn() }));
vi.mock("@/app/actions/cv-skills", () => ({ useCvSkillSuggestions: vi.fn() }));
import { requestCvSkillSuggestions } from "@/app/actions/cv";
import { useCvSkillSuggestions } from "@/app/actions/cv-skills";
import { CvModeSkillSuggestions } from "./CvModeSkillSuggestions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const content = { name: "Alex", contact: "alex@example.test", summary: "Analyst", gaps: [],
  sections: [{ entryId: "work", kind: "experience", heading: "Analyst", bullets: ["Analysed reports"] }] } as CvContent;
const quote = { charge: "allowance" as const, units: 3, priceVersion: 1 };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent === name)!;

it("quotes the selected saved edition and writes verified selected skills to Experience and CV once", async () => {
  const suggestionId = "27a3328d-44a9-4ea1-a841-86b3f81bb76b";
  vi.mocked(requestCvSkillSuggestions).mockResolvedValue({ ok: true, run: { id: "run-1", status: "ready", error: null,
    suggestions: [{ id: suggestionId, label: "Reporting", category: "Analysis", sourceId: "work",
      evidenceQuote: "Analysed reports", roleQuote: "Reporting" }] } });
  vi.mocked(useCvSkillSuggestions).mockResolvedValue({ ok: true, draftId: "child", version: 3, charged: false });
  act(() => root.render(<CvModeSkillSuggestions contextId="context" draftId="draft" revision={2}
    overlayVersion={2} content={content} libraryVersion={5} quote={quote} />));
  expect(container.textContent).toContain("3 AI units");
  await act(async () => button("Generate skills").click());
  expect(requestCvSkillSuggestions).toHaveBeenCalledWith("draft", false, 5, content, 2, quote);
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Save selected skills to Experience and CV · free").click());
  expect(useCvSkillSuggestions).toHaveBeenCalledWith("context", "draft", "run-1", 2, 2, [suggestionId], expect.any(String));
  expect(container.textContent).toContain("Selected skills saved to Experience and the current CV");
  expect(refresh).toHaveBeenCalled();
});

it("does not request skills without a selected, quoted, saved edition", () => {
  act(() => root.render(<CvModeSkillSuggestions contextId="context" draftId={null} revision={null}
    overlayVersion={1} content={null} libraryVersion={null} quote={null} />));
  expect(button("Generate skills").disabled).toBe(true);
  expect(container.textContent).toContain("Select a saved CV edition");
  expect(requestCvSkillSuggestions).not.toHaveBeenCalled();
});
