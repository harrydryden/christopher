// @vitest-environment jsdom
/**
 * The roles table's decisions, in a browser: a decided row leaves the moment the person acts,
 * before the server answers, and comes back with the server's sentence if it refuses; the undo
 * returns it at once; a group decision does the same for the whole selection.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoleCompaniesVM, RoleRowVM } from "@/lib/queries/jobs";
import type { ActionResult } from "@/lib/validation";

const actions = vi.hoisted(() => ({
  decide: vi.fn(),
  decideRoles: vi.fn(),
  decideWithUndoToken: vi.fn(),
  decideRolesWithUndoTokens: vi.fn(),
  undoDecisionIfCurrent: vi.fn(),
  undoDecisionsIfCurrent: vi.fn(),
  archiveRoles: vi.fn(),
  roleDetails: vi.fn(),
  retryFailedScore: vi.fn(),
}));
vi.mock("@/app/actions/decisions", () => actions);
vi.mock("@/app/actions/scores", () => ({ retryFailedScore: actions.retryFailedScore }));
vi.mock("@/app/actions/cv", () => ({ requestCv: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { RolesTable } from "./RolesTable";
import { SKIP_REASON_REQUIRED } from "@/lib/decision-reason";
import { RoleRefusalNotices } from "./RoleRefusalNotices";
import { dismissRoleRefusal, roleRefusals } from "@/lib/role-refusals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function role(id: string, title: string): RoleRowVM {
  return {
    id, companyId: "company-1", companyName: "Meridian", title,
    url: `https://meridian.example/jobs/${id}`, location: "Manchester", locations: ["Manchester"], remote: false,
    department: null, employmentType: null, salaryText: null, status: "active", workflowStatus: "auto-matched",
    stage: "matched", applicationStatus: null, liveForText: "Live for 3 days", liveForBasis: "posted", seeded: false,
    fitScore: 72, scoreState: null, scoreStateText: null, fitVerdict: null, fitRationale: null, keywordTerms: [],
    addedByYou: false, manual: false, decision: null,
  };
}
const COMPANIES: RoleCompaniesVM = { "company-1": { iconSrc: null, domain: "meridian.example", homepageUrl: "https://meridian.example" } };
const FIRST = role("11111111-1111-4111-8111-111111111111", "Head of Operations");
const SECOND = role("22222222-2222-4222-8222-222222222222", "Operations Manager");

it("shows a saved PDF role without inventing a company page or vacancy link", async () => {
  const pdf = { ...FIRST, manual: true, url: null, companyId: FIRST.id, workflowStatus: "user-shortlisted" as const, stage: "shortlisted" as const,
    fitScore: null, scoreState: "requested" as const, scoreStateText: "Score pending; review manually" };
  await act(async () => root.render(<RolesTable rows={[pdf]} companies={{}} initiallyExpandedId={pdf.id} emptyState={null} />));
  expect(container.textContent).toContain("Added from PDF");
  expect(container.querySelector(`a[href="/companies/${pdf.id}"]`)).toBeNull();
  expect(container.textContent).not.toContain("View vacancy");
  expect(container.textContent).toContain("You added this role from a PDF");
  expect(container.textContent).toContain("Not scored");
  expect(container.textContent).not.toContain("Why it matched");
  expect(container.textContent).not.toContain("Score pending");
  expect(container.textContent).not.toContain("Score requested");
});

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
  sessionStorage.clear();
  for (const action of Object.values(actions)) action.mockReset();
  actions.decideWithUndoToken.mockImplementation(async (jobId: string, decision: string, reason: string) => {
    const result = await actions.decide(jobId, decision, reason);
    return result.ok ? { ok: true, decisionId: jobId } : result;
  });
  actions.undoDecisionIfCurrent.mockImplementation((jobId: string) => actions.decide(jobId, null, ""));
  actions.decideRolesWithUndoTokens.mockImplementation(async (ids: string[], decision: string, reason: string) => {
    const result = await actions.decideRoles(ids, decision, reason);
    return result.ok ? { ok: true, decisionIds: Object.fromEntries(ids.map(id => [id, id])) } : result;
  });
  actions.undoDecisionsIfCurrent.mockImplementation((expected: Array<{ jobId: string }>) => actions.decideRoles(expected.map(item => item.jobId), null, ""));
  actions.roleDetails.mockResolvedValue({ ok: false, error: "Could not load this role." });
  scrolled.mockReset();
  Element.prototype.scrollIntoView = scrolled;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("keeps several successful decisions available across filtered table remounts and retains a failed Undo", async () => {
  const scoped = (key: string, rows: RoleRowVM[]) => act(() => root.render(
    <RolesTable key={key} rows={rows} companies={COMPANIES} keyboard historyScope="person-1" emptyState={<p>Nothing to review</p>} />
  ));
  actions.decideWithUndoToken.mockImplementation(async (jobId: string) => ({ ok: true, decisionId: jobId }));
  scoped("first", [FIRST, SECOND]);
  press("a");
  press("Enter", reasonBox()!);
  await act(async () => {});
  scoped("filtered", [SECOND]);
  press("a");
  press("Enter", reasonBox()!);
  await act(async () => {});
  scoped("empty", []);
  expect(container.querySelectorAll('[aria-label^="Undo Shortlisted"]')).toHaveLength(2);
  expect(text()).toContain("Shortlisted Head of Operations");
  expect(text()).toContain("Shortlisted Operations Manager");

  actions.undoDecisionIfCurrent.mockResolvedValueOnce({ ok: false, error: "The decision changed. Reload and retry." });
  await act(async () => { container.querySelector<HTMLButtonElement>(`[aria-label="Undo Shortlisted Head of Operations at Meridian"]`)!.click(); });
  expect(text()).toContain("Could not undo");
  expect(text()).toContain("The decision changed. Reload and retry.");
  expect(container.querySelectorAll('[aria-label^="Undo Shortlisted"]')).toHaveLength(2);
  expect(actions.undoDecisionIfCurrent).toHaveBeenCalledWith(FIRST.id, FIRST.id);

  actions.undoDecisionIfCurrent.mockResolvedValueOnce({ ok: true });
  await act(async () => { container.querySelector<HTMLButtonElement>(`[aria-label="Undo Shortlisted Head of Operations at Meridian"]`)!.click(); });
  expect(container.querySelectorAll('[aria-label^="Undo Shortlisted"]')).toHaveLength(1);
  expect(text()).toContain("Shortlisted Operations Manager");
});

it("does not expose another account's recent decisions in the same browser tab", async () => {
  actions.decideWithUndoToken.mockResolvedValue({ ok: true, decisionId: FIRST.id });
  act(() => root.render(<RolesTable rows={[FIRST]} companies={COMPANIES} keyboard historyScope="person-1" emptyState={<p>Nothing</p>} />));
  press("a");
  press("Enter", reasonBox()!);
  await act(async () => {});
  act(() => root.render(<RolesTable key="other-account" rows={[]} companies={COMPANIES} keyboard historyScope="person-2" emptyState={<p>Nothing</p>} />));
  expect(text()).not.toContain("Head of Operations");
  expect(container.querySelector('[aria-label^="Undo Shortlisted"]')).toBeNull();
});

it("rejects older tokenless Undo history and offers a reload of the latest role state", () => {
  sessionStorage.setItem("ava:role-undo:person-1", JSON.stringify([{ jobId: FIRST.id, text: "Shortlisted Head of Operations", revision: "old" }]));
  act(() => root.render(<RolesTable rows={[]} companies={COMPANIES} keyboard historyScope="person-1" emptyState={<p>Nothing</p>} />));
  expect(text()).toContain("Older Undo entries cannot be checked against the latest decision");
  expect(button("Reload roles")).toBeTruthy();
  expect(container.querySelector('button[aria-label^="Undo Shortlisted"]')).toBeNull();
  expect(actions.undoDecisionIfCurrent).not.toHaveBeenCalled();
});

it("keeps a visible shortlisted row and its history when a stale Undo is refused", async () => {
  const decided: RoleRowVM = { ...FIRST, workflowStatus: "user-shortlisted", stage: "shortlisted",
    decision: { id: FIRST.id, decision: "apply", reason: "", createdLabel: "just now", createdTitle: "now" } };
  const entry = { jobId: FIRST.id, text: "Shortlisted Head of Operations at Meridian", revision: "rev-1", decisionId: FIRST.id };
  sessionStorage.setItem(`ava:role-undo-revision:person-1:${FIRST.id}`, entry.revision);
  sessionStorage.setItem("ava:role-undo:person-1", JSON.stringify([entry]));
  actions.undoDecisionIfCurrent.mockResolvedValue({ ok: false, error: "This decision changed in another tab. Reload roles before trying again." });
  act(() => root.render(<RolesTable rows={[decided]} companies={COMPANIES} keyboard historyScope="person-1" emptyState={<p>Nothing</p>} />));

  await act(async () => { container.querySelector<HTMLButtonElement>(`[aria-label="Undo ${entry.text}"]`)!.click(); });
  expect(titles()).toEqual([FIRST.title]);
  expect(text()).toContain("This decision changed in another tab");
  expect(container.querySelector(`[aria-label="Undo ${entry.text}"]`)).not.toBeNull();
  expect(actions.undoDecisionIfCurrent).toHaveBeenCalledWith(FIRST.id, FIRST.id);
});

it("keeps a bulk selection intact when one token changed and sends every expected decision id", async () => {
  const decided = (row: RoleRowVM): RoleRowVM => ({ ...row, workflowStatus: "user-shortlisted", stage: "shortlisted",
    decision: { id: row.id, decision: "apply", reason: "", createdLabel: "just now", createdTitle: "now" } });
  actions.undoDecisionsIfCurrent.mockResolvedValue({ ok: false, error: "A selected decision changed in another tab. Reload roles before trying again." });
  act(() => root.render(<RolesTable rows={[decided(FIRST), decided(SECOND)]} companies={COMPANIES}
    keyboard historyScope="person-1" emptyState={<p>Nothing</p>} />));
  act(() => container.querySelector<HTMLInputElement>(`input[aria-label="Select ${FIRST.title} at Meridian"]`)!.click());
  act(() => container.querySelector<HTMLInputElement>(`input[aria-label="Select ${SECOND.title} at Meridian"]`)!.click());
  await act(async () => { button("Undo").click(); });
  expect(actions.undoDecisionsIfCurrent).toHaveBeenCalledWith([
    { jobId: FIRST.id, decisionId: FIRST.id }, { jobId: SECOND.id, decisionId: SECOND.id },
  ]);
  expect(titles()).toEqual([FIRST.title, SECOND.title]);
  expect(text()).toContain("2 selected");
  expect(text()).toContain("A selected decision changed in another tab");
  expect(actions.decideRoles).not.toHaveBeenCalled();
});

it("uses the standing decision token when Reset is pressed in a review panel", async () => {
  const decided: RoleRowVM = { ...FIRST, workflowStatus: "user-shortlisted", stage: "shortlisted",
    decision: { id: FIRST.id, decision: "apply", reason: "", createdLabel: "just now", createdTitle: "now" } };
  actions.undoDecisionIfCurrent.mockResolvedValue({ ok: true });
  act(() => root.render(<RolesTable rows={[decided]} companies={COMPANIES} keyboard historyScope="person-1" emptyState={<p>Nothing</p>} />));
  act(() => button(FIRST.title).click());
  await act(async () => { button("Reset").click(); });
  expect(actions.undoDecisionIfCurrent).toHaveBeenCalledWith(FIRST.id, FIRST.id);
  expect(actions.decide).not.toHaveBeenCalled();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(rows: RoleRowVM[]) {
  act(() => root.render(<RolesTable rows={rows} companies={COMPANIES} keyboard emptyState={<p>Nothing to review</p>} />));
}

it("keeps an earlier fit score visible beside an honest pending update in the row and review", () => {
  const pending = { ...FIRST, scoreState: "requested" as const, scoreStateText: "Previous score; update pending" };
  render([pending]);
  const row = container.querySelector(`#role-row-${pending.id}`)!.closest("tr")!;
  expect(row.textContent).toContain("72");
  expect(row.textContent).toContain("Previous score; update pending");
  act(() => button("Review").click());
  const review = container.querySelector(`#role-review-${pending.id}`)!;
  expect(review.textContent).toContain("72");
  expect(review.textContent).toContain("Previous score; update pending");
});

it("offers one Retry score in a failed review and preserves the previous score and manual decision", async () => {
  const failed: RoleRowVM = { ...FIRST, scoreState: "failed", scoreStateText: "Previous score; update failed; review manually",
    workflowStatus: "user-shortlisted", stage: "shortlisted",
    decision: { id: FIRST.id, decision: "apply", reason: "Relevant work", createdLabel: "just now", createdTitle: "now" } };
  const request = deferred();
  actions.retryFailedScore.mockReturnValue(request.promise);
  render([failed]);
  expect([...container.querySelectorAll("button")].some(el => el.textContent === "Retry score")).toBe(false);
  act(() => button(FIRST.title).click());
  const review = container.querySelector(`#role-review-${failed.id}`)!;
  expect(review.textContent).toContain("72");
  expect(review.textContent).toContain("Previous score; update failed");
  expect(review.textContent).toContain("Relevant work");
  expect(review.querySelectorAll("button").length).toBeGreaterThan(1);
  expect(review.querySelector("button button")).toBeNull();
  await act(async () => { button("Retry score").click(); });
  expect(actions.retryFailedScore).toHaveBeenCalledOnce();
  expect(actions.retryFailedScore).toHaveBeenCalledWith(failed.id);
  expect(button("Requesting…").hasAttribute("disabled")).toBe(true);
  await act(async () => { request.resolve({ ok: true }); });
  expect(review.querySelector('[role="status"]')?.textContent).toContain("Score retry requested");
  expect(review.textContent).toContain("72");
  expect(button("Score requested").hasAttribute("disabled")).toBe(true);
  render([{ ...failed, scoreState: "requested", scoreStateText: "Previous score; update pending; review manually" }]);
  expect(container.querySelector(`#role-review-${failed.id} [role="status"]`)?.textContent).toContain("reviewing this role");
  expect(button("Score requested").hasAttribute("disabled")).toBe(true);
  render([failed]);
  expect(button("Retry score").hasAttribute("disabled")).toBe(false);
});

it("announces a retry refusal and allows another attempt", async () => {
  actions.retryFailedScore.mockResolvedValue({ ok: false, error: "This role is no longer eligible for scoring." });
  render([{ ...FIRST, fitScore: null, scoreState: "failed", scoreStateText: "Could not score; review manually" }]);
  act(() => button("Review").click());
  await act(async () => { button("Retry score").click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("no longer eligible");
  expect(button("Retry score").hasAttribute("disabled")).toBe(false);
  expect(text()).toContain("Could not score; review manually");
});

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

it("holds a returned row's actions while its undo is being saved, then lets it be decided again", async () => {
  actions.decide.mockResolvedValueOnce({ ok: true });
  render([FIRST, SECOND]);
  press("a");
  press("Enter", reasonBox()!);
  await act(async () => {});
  render([SECOND]);

  const undoing = deferred();
  actions.decide.mockReturnValueOnce(undoing.promise);
  act(() => button("Undo").click());
  expect(titles()).toEqual([FIRST.title, SECOND.title]);

  // The cursor is on the returned row: its shortcut does nothing, and its buttons say it is saving.
  press("a");
  expect(reasonBox()).toBeNull();
  // Its review is still open from the decision; the buttons in it are the ones pressed.
  expect(container.querySelector(`#role-review-${FIRST.id}`)).not.toBeNull();
  const saving = button("Saving…");
  expect(saving.disabled).toBe(true);
  act(() => saving.click());
  expect(actions.decide).toHaveBeenCalledTimes(2);

  await answer(undoing, { ok: true });
  render([FIRST, SECOND]);
  const shortlist = button("Shortlist");
  expect(shortlist.disabled).toBe(false);
  actions.decide.mockResolvedValueOnce({ ok: true });
  await act(async () => { shortlist.click(); });
  expect(actions.decide).toHaveBeenCalledTimes(3);
  expect(actions.decide).toHaveBeenLastCalledWith(FIRST.id, "apply", "");
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

it("shows a refusal that lands after the table was replaced beside the new one, which lists the row again", async () => {
  for (const refusal of roleRefusals()) dismissRoleRefusal(refusal.id);
  const workspace = (key: string, rows: RoleRowVM[]) => act(() => root.render(<>
    <RoleRefusalNotices />
    <RolesTable key={key} rows={rows} companies={COMPANIES} keyboard emptyState={<p>Nothing to review</p>} />
  </>));
  const saving = deferred();
  actions.decide.mockReturnValue(saving.promise);
  workspace("page-1", [FIRST, SECOND]);
  press("a");
  press("Enter", reasonBox()!);
  expect(titles()).toEqual([SECOND.title]);

  // The person pages on while it is saved: a new table, from a render that still lists the role.
  workspace("page-1:sorted", [FIRST, SECOND]);
  await answer(saving, { ok: false, error: "Could not save your decision. Please try again." });
  expect(text()).toContain("Could not save Head of Operations: Could not save your decision. Please try again.");
  expect(titles()).toEqual([FIRST.title, SECOND.title]);

  act(() => button("Dismiss").click());
  expect(text()).not.toContain("Could not save Head of Operations");
});

it("draws each row's company from the page's map and says in words what its live-for counts from", async () => {
  const other: RoleRowVM = { ...role("33333333-3333-4333-8333-333333333333", "Site Lead"), companyId: "company-2", companyName: "Northwind", liveForBasis: "first_seen", seeded: true };
  const companies: RoleCompaniesVM = { ...COMPANIES, "company-2": { iconSrc: "/api/companies/company-2/logo?v=1", domain: "northwind.example", homepageUrl: "https://northwind.example" } };
  act(() => root.render(<RolesTable rows={[FIRST, other]} companies={companies} keyboard emptyState={<p>Nothing to review</p>} />));
  const icons = [...container.querySelectorAll("tbody img")].map(img => img.getAttribute("src"));
  expect(icons).toContain("/api/companies/company-2/logo?v=1");
  const liveTitles = [...container.querySelectorAll("tbody p span[title]")].map(el => el.getAttribute("title"));
  expect(liveTitles).toEqual([
    "Counted from the date the source published for this role.",
    "Counted from when this tool first saw the role; the source publishes no posted date. (seeded on first scan)",
  ]);
  act(() => button(other.title).click());
  expect(container.querySelector<HTMLAnchorElement>(`#role-review-${other.id} a[href="https://northwind.example"]`)?.textContent).toBe("Website ↗");
});

it("keeps a long location list reviewable and exposes every place on demand", () => {
  const locations = ["USA, GA, Atlanta", ...Array.from({ length: 68 }, (_, i) => `Location ${i + 1}`), "USA, MA, Boston"];
  const multiLocation: RoleRowVM = { ...FIRST, location: locations[0]!, locations };
  act(() => root.render(<RolesTable rows={[multiLocation]} companies={COMPANIES} emptyState={<p>Nothing</p>} />));

  const details = container.querySelector<HTMLDetailsElement>("tbody details");
  const summary = details?.querySelector("summary");
  expect(details?.open).toBe(false);
  expect(summary?.textContent).toBe("USA, GA, Atlanta + 69 more locations");
  expect(details?.querySelectorAll("li")).toHaveLength(70);
  expect(details?.querySelector("li:last-child")?.textContent).toBe("USA, MA, Boston");
  expect(details?.querySelector("ul")?.className).not.toContain("overflow-y-auto");
  act(() => summary!.click());
  expect(details?.open).toBe(true);
});

it("shows a short location list directly", () => {
  const fewLocations: RoleRowVM = { ...FIRST, location: "London", locations: ["London", "Manchester"] };
  act(() => root.render(<RolesTable rows={[fewLocations]} companies={COMPANIES} emptyState={<p>Nothing</p>} />));
  expect(container.querySelector("tbody details")).toBeNull();
  expect(container.querySelector("tbody")?.textContent).toContain("London, Manchester");
});

it("brings an undone row back with its company even when the new page's map no longer holds it", async () => {
  const other: RoleRowVM = { ...role("33333333-3333-4333-8333-333333333333", "Site Lead"), companyId: "company-2", companyName: "Northwind" };
  const withBoth: RoleCompaniesVM = { ...COMPANIES, "company-2": { iconSrc: null, domain: "northwind.example", homepageUrl: "https://northwind.example" } };
  const saving = deferred();
  actions.decide.mockReturnValueOnce(saving.promise);
  const undoing = deferred();
  actions.decide.mockReturnValueOnce(undoing.promise);
  const draw = (rows: RoleRowVM[], companies: RoleCompaniesVM) => act(() => root.render(<RolesTable rows={rows} companies={companies} keyboard emptyState={<p>Nothing to review</p>} />));
  draw([other, FIRST], withBoth);
  press("s");
  type(reasonBox()!, "Not interested");
  press("Enter", reasonBox()!);
  await answer(saving, { ok: true });
  // The server's next page no longer lists the role, nor its company.
  draw([FIRST], COMPANIES);
  act(() => button("Undo").click());
  expect(titles()).toEqual([other.title, FIRST.title]);
  // Its review panel is still the open one, as it was when the row left.
  if (!container.querySelector(`#role-review-${other.id}`)) act(() => button(other.title).click());
  expect(container.querySelector(`#role-review-${other.id} a[href="https://northwind.example"]`)).not.toBeNull();
  await answer(undoing, { ok: true });
});

it("shows a role's archive notes once its review panel has loaded them, and ships none with the row", async () => {
  let resolve!: (value: unknown) => void;
  const loading = new Promise(done => { resolve = done; });
  actions.roleDetails.mockReturnValue(loading);
  expect(Object.keys(FIRST)).not.toContain("events");
  render([FIRST, SECOND]);
  act(() => button(FIRST.title).click());
  expect(actions.roleDetails).toHaveBeenCalledWith(FIRST.id);
  expect(text()).not.toContain("Archived:");

  await act(async () => {
    resolve({
      ok: true,
      details: {
        jobId: FIRST.id, description: "Runs twelve sites.", salaryText: null, department: null, employmentType: null,
        keywordTerms: [], fitVerdict: null, fitRationale: null, locationReason: "Your filter names no location, so every location passes.",
        cvQuote: null, cvBlocked: null, archiveNotes: ["Archived: No longer matches your criteria"],
      },
    });
    await loading;
  });
  const note = [...container.querySelectorAll(`#role-review-${FIRST.id} p`)].find(el => el.textContent === "Archived: No longer matches your criteria");
  expect(note).toBeTruthy();
  // The other row, never opened, says nothing of it.
  expect(container.querySelector(`#role-review-${SECOND.id}`)).toBeNull();
});
