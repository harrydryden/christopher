// @vitest-environment jsdom
/**
 * The roles table's decisions, in a browser: a decided row leaves the moment the person acts,
 * before the server answers, and comes back with the server's sentence if it refuses; the undo
 * returns it at once; a group decision does the same for the whole selection.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoleRowVM } from "@/lib/queries/jobs";
import type { ActionResult } from "@/lib/validation";

const actions = vi.hoisted(() => ({
  decide: vi.fn(),
  decideRoles: vi.fn(),
  archiveRoles: vi.fn(),
  roleDetails: vi.fn(),
}));
vi.mock("@/app/actions/decisions", () => actions);
vi.mock("@/app/actions/cv", () => ({ requestCv: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { RolesTable } from "./RolesTable";
import { SKIP_REASON_REQUIRED } from "@/lib/decision-reason";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function role(id: string, title: string): RoleRowVM {
  return {
    id, companyId: "company-1", companyName: "Meridian", companyFaviconUrl: null, companyLogoUrl: null,
    companyDomain: "meridian.example", companyHomepageUrl: "https://meridian.example", title,
    url: `https://meridian.example/jobs/${id}`, location: "Manchester", locations: ["Manchester"], remote: false,
    department: null, employmentType: null, salaryText: null, status: "active", workflowStatus: "auto-matched",
    stage: "matched", applicationStatus: null, liveForText: "Live for 3 days", liveForTitle: "", seeded: false,
    fitScore: 72, scoreState: null, scoreStateText: null, fitVerdict: null, fitRationale: null, keywordTerms: [],
    locationOk: true, sourceType: "greenhouse", firstSeenLabel: "", firstSeenTitle: "", postedLabel: null,
    postedTitle: null, closedLabel: null, closedTitle: null, addedByYou: false, decision: null, events: [],
  } as RoleRowVM;
}
const FIRST = role("11111111-1111-4111-8111-111111111111", "Head of Operations");
const SECOND = role("22222222-2222-4222-8222-222222222222", "Operations Manager");

/** A server answer the test hands over when it chooses, so the page can be read in between. */
function deferred() {
  let resolve!: (value: ActionResult) => void;
  const promise = new Promise<ActionResult>(done => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLElement;
const scrolled = vi.fn();
beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  actions.roleDetails.mockResolvedValue({ ok: false, error: "Could not load this role." });
  scrolled.mockReset();
  Element.prototype.scrollIntoView = scrolled;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(rows: RoleRowVM[]) {
  act(() => root.render(<RolesTable rows={rows} keyboard emptyState={<p>Nothing to review</p>} />));
}
const titles = () => [...container.querySelectorAll('tbody td[id^="role-row-"] button')].map(el => el.textContent);
const text = () => container.textContent ?? "";
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(el => el.textContent === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
};
const reasonBox = () => container.querySelector<HTMLTextAreaElement>("tbody textarea");
function press(key: string, target: EventTarget = document.body) {
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
}
function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function answer(pending: ReturnType<typeof deferred>, result: ActionResult) {
  await act(async () => { pending.resolve(result); await pending.promise; });
}

it("takes a decided row off the page before the server answers, and keeps it off once saved", async () => {
  const saving = deferred();
  actions.decide.mockReturnValue(saving.promise);
  render([FIRST, SECOND]);

  press("a");
  press("Enter", reasonBox()!);
  expect(actions.decide).toHaveBeenCalledWith(FIRST.id, "apply", "");
  // Gone while the server is still answering, with the notice that says where it went.
  expect(titles()).toEqual([SECOND.title]);
  expect(text()).toContain("Shortlisted Head of Operations at Meridian");

  await answer(saving, { ok: true });
  expect(titles()).toEqual([SECOND.title]);
});

it("puts the row back with the server's sentence in the box it was typed in when the server refuses", async () => {
  const saving = deferred();
  actions.decide.mockReturnValue(saving.promise);
  render([FIRST, SECOND]);

  press("a");
  type(reasonBox()!, "Runs twelve sites");
  press("Enter", reasonBox()!);
  expect(titles()).toEqual([SECOND.title]);

  await answer(saving, { ok: false, error: "Could not save your decision. Please try again." });
  expect(titles()).toEqual([FIRST.title, SECOND.title]);
  expect(reasonBox()!.value).toBe("Runs twelve sites");
  expect(text()).toContain("Could not save your decision. Please try again.");
  expect(text()).not.toContain("Shortlisted Head of Operations");
});

it("asks for a dismissal's reason before sending anything, so the row never leaves", () => {
  render([FIRST, SECOND]);
  press("s");
  press("Enter", reasonBox()!);
  expect(actions.decide).not.toHaveBeenCalled();
  expect(titles()).toEqual([FIRST.title, SECOND.title]);
  expect(text()).toContain(SKIP_REASON_REQUIRED);
});

it("brings the row back the moment Undo is pressed, even after the page re-rendered without it", async () => {
  actions.decide.mockResolvedValueOnce({ ok: true });
  render([FIRST, SECOND]);
  press("a");
  press("Enter", reasonBox()!);
  await act(async () => {});
  // The action's own response re-renders the page without the decided role.
  render([SECOND]);

  const undoing = deferred();
  actions.decide.mockReturnValueOnce(undoing.promise);
  act(() => button("Undo").click());
  expect(actions.decide).toHaveBeenLastCalledWith(FIRST.id, null, "");
  expect(titles()).toEqual([FIRST.title, SECOND.title]);

  await answer(undoing, { ok: true });
  render([FIRST, SECOND]);
  expect(titles()).toEqual([FIRST.title, SECOND.title]);
});

it("waits for a decision still being saved before undoing it, and takes the row off again if the undo is refused", async () => {
  const saving = deferred();
  actions.decide.mockReturnValueOnce(saving.promise);
  render([FIRST, SECOND]);
  press("a");
  press("Enter", reasonBox()!);

  const undoing = deferred();
  actions.decide.mockReturnValueOnce(undoing.promise);
  act(() => button("Undo").click());
  expect(titles()).toEqual([FIRST.title, SECOND.title]);
  // The undo is not sent until the decision it undoes has been saved.
  expect(actions.decide).toHaveBeenCalledTimes(1);

  await answer(saving, { ok: true });
  expect(actions.decide).toHaveBeenCalledTimes(2);
  await answer(undoing, { ok: false, error: "Could not save your decision. Please try again." });
  expect(titles()).toEqual([SECOND.title]);
  expect(text()).toContain("Could not save your decision. Please try again.");
});

it("moves a whole selection at once, and brings it all back still selected if the server refuses", async () => {
  const saving = deferred();
  actions.decideRoles.mockReturnValue(saving.promise);
  render([FIRST, SECOND]);

  act(() => container.querySelector<HTMLInputElement>(`input[aria-label="Select ${FIRST.title} at Meridian"]`)!.click());
  act(() => container.querySelector<HTMLInputElement>(`input[aria-label="Select ${SECOND.title} at Meridian"]`)!.click());
  act(() => button("Dismiss").click());
  // A group dismissal needs its reason too, asked before anything is sent.
  act(() => button("Dismiss 2").click());
  expect(actions.decideRoles).not.toHaveBeenCalled();
  expect(text()).toContain(SKIP_REASON_REQUIRED);

  type(container.querySelector<HTMLTextAreaElement>("#group-reason")!, "Wrong seniority");
  act(() => button("Dismiss 2").click());
  expect(actions.decideRoles).toHaveBeenCalledWith([FIRST.id, SECOND.id], "skip", "Wrong seniority");
  expect(text()).toContain("Nothing to review");

  await answer(saving, { ok: false, error: "A selected role no longer exists." });
  expect(titles()).toEqual([FIRST.title, SECOND.title]);
  expect(text()).toContain("2 selected");
  expect(text()).toContain("A selected role no longer exists.");
  expect(container.querySelector<HTMLTextAreaElement>("#group-reason")!.value).toBe("Wrong seniority");
});

it("scrolls to the cursor only when j or k moves it, never while a reason is typed or a row is decided", async () => {
  const THIRD = role("33333333-3333-4333-8333-333333333333", "Operations Director");
  actions.decide.mockResolvedValue({ ok: true });
  render([FIRST, SECOND, THIRD]);
  expect(scrolled).not.toHaveBeenCalled();

  // Typing a reason re-renders the table on every keystroke; the page must stay where it is.
  press("s");
  for (const draft of ["W", "Wr", "Wrong", "Wrong location"]) type(reasonBox()!, draft);
  expect(scrolled).not.toHaveBeenCalled();

  // A decision changes the rows but not the cursor.
  press("Enter", reasonBox()!);
  await act(async () => {});
  expect(titles()).toEqual([SECOND.title, THIRD.title]);
  expect(scrolled).not.toHaveBeenCalled();

  press("j");
  expect(scrolled).toHaveBeenCalledTimes(1);
  expect((scrolled.mock.contexts[0] as HTMLElement).id).toBe(`role-row-${THIRD.id}`);
});

it("holds a returned row only until its undo's page arrives, so a row the server drops later stays gone", async () => {
  actions.decide.mockResolvedValueOnce({ ok: true });
  render([FIRST, SECOND]);
  press("a");
  press("Enter", reasonBox()!);
  await act(async () => {});
  render([SECOND]);

  actions.decide.mockResolvedValueOnce({ ok: true });
  await act(async () => { button("Undo").click(); });
  render([FIRST, SECOND]);
  expect(titles()).toEqual([FIRST.title, SECOND.title]);

  // Later the server stops listing it (decided in another tab, say): the table follows the server.
  render([SECOND]);
  expect(titles()).toEqual([SECOND.title]);
});

it("forgets an undo that had nothing to undo because its decision was refused", async () => {
  const saving = deferred();
  actions.decide.mockReturnValueOnce(saving.promise);
  render([FIRST, SECOND]);
  press("a");
  press("Enter", reasonBox()!);
  act(() => button("Undo").click());

  await answer(saving, { ok: false, error: "Could not save your decision. Please try again." });
  expect(actions.decide).toHaveBeenCalledTimes(1);
  expect(titles()).toEqual([FIRST.title, SECOND.title]);

  render([SECOND]);
  expect(titles()).toEqual([SECOND.title]);
});
