// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { CvPendingSkillView } from "@/lib/cv-pending-skills-view";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/app/actions/cv-pending-skills", () => ({ decideCvPendingSkill: vi.fn() }));
import { decideCvPendingSkill } from "@/app/actions/cv-pending-skills";
import { CvPendingSkillPanel } from "./CvPendingSkillPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const view = { draftId: "draft-1", revision: 3,
  proposals: [{ id: "proposal-1", label: "Supplier negotiation", category: "Commercial", origin: "model", status: "pending" }],
  eligibleEvidenceRows: [{ id: "entry:role-1:row:0", text: "Negotiated a renewal." }],
  eligibleDestinations: [{ entryId: "role-1", heading: "Operations Manager" }],
} as CvPendingSkillView;
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CvPendingSkillPanel view={view} />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("requires an explicit factual example before accepting a saved skill", async () => {
  const accept = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Accept into Experience"))!;
  expect(accept.disabled).toBe(true);
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Confirmed example for Supplier negotiation"]')!;
  act(() => { select.value = "entry:role-1:row:0"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const confirm = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  act(() => { confirm.click(); });
  expect(accept.disabled).toBe(false);
  vi.mocked(decideCvPendingSkill).mockResolvedValue({ ok: true, destination: "/cv/child-1" });
  await act(async () => { accept.click(); });
  expect(decideCvPendingSkill).toHaveBeenCalledWith("draft-1", "proposal-1", expect.objectContaining({
    decision: "accept", expectedRevision: 3, confirmFactual: true,
    evidence: { kind: "link_existing", evidenceEntryId: "entry:role-1:row:0" },
  }));
  expect(push).toHaveBeenCalledWith("/cv/child-1");
});

it("keeps the same request key after an unknown outcome so retry cannot duplicate acceptance", async () => {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Confirmed example for Supplier negotiation"]')!;
  act(() => { select.value = "entry:role-1:row:0"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  act(() => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  vi.mocked(decideCvPendingSkill).mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce({ ok: true, destination: "/cv/child-1" });
  const accept = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Accept into Experience"))!;
  await act(async () => { accept.click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
  await act(async () => { accept.click(); });
  const calls = vi.mocked(decideCvPendingSkill).mock.calls;
  expect(calls[0]![2].requestKey).toBe(calls[1]![2].requestKey);
});

it("accepts a member's new factual example only with a selected Experience role", async () => {
  const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  act(() => radios[1]!.click());
  const accept = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Accept into Experience"))!;
  expect(accept.disabled).toBe(true);
  const role = container.querySelector<HTMLSelectElement>('select[aria-label="Experience role for Supplier negotiation"]')!;
  const example = container.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => { role.value = "role-1"; role.dispatchEvent(new Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(example,
      "I negotiated a supplier renewal that protected service levels.");
    example.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(accept.disabled).toBe(false);
  vi.mocked(decideCvPendingSkill).mockResolvedValue({ ok: true, destination: "/cv/child-2" });
  await act(async () => accept.click());
  expect(decideCvPendingSkill).toHaveBeenCalledWith("draft-1", "proposal-1", expect.objectContaining({
    evidence: { kind: "new_confirmed_row", destinationEntryId: "role-1",
      factualExample: "I negotiated a supplier renewal that protected service levels." },
  }));
});
