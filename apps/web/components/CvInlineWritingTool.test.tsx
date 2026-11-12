// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CvInlineWritingTool, type CvInlineQuotes } from "./CvInlineWritingTool";

const refresh = vi.fn();
const request = vi.fn();
const latest = vi.fn(async (..._args: unknown[]) => ({ ok: false, error: "No pending suggestion." }));
const dismiss = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/cv-inline-ai", () => ({
  requestCvInlineEdit: (...args: unknown[]) => request(...args),
  latestCvInlineEdit: (...args: unknown[]) => latest(...args),
  readCvInlineEdit: vi.fn(),
  dismissCvInlineEdit: (...args: unknown[]) => dismiss(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const source = { kind: "draft" as const, id: "11111111-1111-4111-8111-111111111111", revision: 3 };
const target = { type: "summary" as const, id: "22222222-2222-4222-8222-222222222222", field: "text" as const };
const quotes: CvInlineQuotes = {
  inline_correction: { charge: "role_credit", units: 0, priceVersion: 1 },
  inline_refine: { charge: "role_credit", units: 0, priceVersion: 1 },
  inline_tailor: { charge: "role_credit", units: 0, priceVersion: 1 },
};
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  request.mockReset(); latest.mockClear(); dismiss.mockReset(); refresh.mockClear(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

function button(name: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(row => row.getAttribute("aria-label") === name || row.textContent === name)!;
}

it("offers only the three quoted actions, sends the selected words, and saves only after Use change", async () => {
  const useChange = vi.fn(async () => true);
  request.mockResolvedValue({ ok: true, run: { id: "run-1", status: "ready", beforeText: "quick",
    proposedText: "swift", text: "A quick result", selectionStart: 2, selectionEnd: 7,
    error: null, target, source } });
  await act(async () => root.render(<CvInlineWritingTool contextId="33333333-3333-4333-8333-333333333333"
    source={source} target={target} label="Summary" text="A quick result" quotes={quotes}
    getSelection={() => ({ start: 2, end: 7 })} onUseChange={useChange} />));
  expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Help me write");
  await act(async () => button("Help me write: Summary").click());
  expect([...container.querySelectorAll('[role="menuitem"]')].map(row => row.getAttribute("aria-label"))).toEqual([
    "Fix spelling & grammar", "Refine wording", "Tailor to this role",
  ]);
  expect(container.textContent).toContain("1 role credit for the first successful AI result");
  await act(async () => button("Fix spelling & grammar").click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ source, target, text: "A quick result",
    selectionStart: 2, selectionEnd: 7, action: "inline_correction", acceptRoleCredit: true, priceVersion: 1 }));
  expect(useChange).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Current wording");
  expect(container.textContent).toContain("Suggested wording");
  await act(async () => button("Use change").click());
  expect(useChange).toHaveBeenCalledWith("A swift result");
});

it("keeps a selected range captured before the star takes focus", async () => {
  let selected: { start: number; end: number } | null = { start: 2, end: 7 };
  request.mockResolvedValue({ ok: false, error: "Try again." });
  await act(async () => root.render(<CvInlineWritingTool contextId="33333333-3333-4333-8333-333333333333"
    source={source} target={target} label="Summary" text="A quick result" quotes={quotes}
    getSelection={() => selected} onUseChange={async () => true} />));
  const star = button("Help me write: Summary");
  act(() => { star.dispatchEvent(new Event("pointerdown", { bubbles: true })); selected = null; star.click(); });
  await act(async () => button("Fix spelling & grammar").click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ selectionStart: 2, selectionEnd: 7 }));
});

it("retains a stale suggestion and typed wording after a failed save, then permits dismissal", async () => {
  const useChange = vi.fn(async () => false);
  request.mockResolvedValue({ ok: true, run: { id: "run-2", status: "ready", beforeText: "Original",
    proposedText: "Revised", text: "Original", selectionStart: 0, selectionEnd: 8,
    error: null, target, source } });
  dismiss.mockResolvedValue({ ok: true, run: { id: "run-2", status: "dismissed" } });
  const render = (text: string) => root.render(<CvInlineWritingTool contextId="33333333-3333-4333-8333-333333333333"
    source={source} target={target} label="Summary" text={text} quotes={quotes} onUseChange={useChange} />);
  await act(async () => render("Original"));
  await act(async () => button("Help me write: Summary").click());
  await act(async () => button("Refine wording").click());
  await act(async () => button("Use change").click());
  expect(container.textContent).toContain("Your wording and suggestion remain here");
  await act(async () => render("My newer text"));
  expect(button("Use change").disabled).toBe(true);
  expect(container.textContent).toContain("This text changed");
  await act(async () => button("Dismiss").click());
  expect(dismiss).toHaveBeenCalledWith("run-2");
  expect(container.textContent).toContain("Your wording is unchanged");
});

it("shows a usable credits or reset path after admission refusal while keeping editing available", async () => {
  const useChange = vi.fn(async () => true);
  request.mockResolvedValue({ ok: false, error: "No role credits remain.",
    recovery: { href: "/account#top-ups", label: "Add role credits" } });
  await act(async () => root.render(<CvInlineWritingTool contextId="33333333-3333-4333-8333-333333333333"
    source={source} target={target} label="Summary" text="Original" quotes={quotes} onUseChange={useChange} />));
  await act(async () => button("Help me write: Summary").click());
  await act(async () => button("Fix spelling & grammar").click());
  expect(container.querySelector<HTMLAnchorElement>('a[href="/account#top-ups"]')?.textContent).toBe("Add role credits");
  expect(container.textContent).toContain("You can still edit and save your CV");
  expect(refresh).toHaveBeenCalled();
  request.mockResolvedValue({ ok: false, error: "Five-hour allowance is full.",
    recovery: { resetAt: "2026-11-11T20:00:00.000Z" } });
  await act(async () => button("Help me write: Summary").click());
  await act(async () => button("Refine wording").click());
  expect(container.textContent).toContain("Resets");
  expect(container.querySelector('a[href="/account#top-ups"]')).toBeNull();
});
