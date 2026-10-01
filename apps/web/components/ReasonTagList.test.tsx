// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/validation";

const actions = vi.hoisted(() => ({ saveDecisionTagsSetting: vi.fn() }));
vi.mock("@/app/actions/decisions", () => actions);

import { ReasonTagList, type ReasonTagDecision } from "./ReasonTagList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const decision = (id: string): ReasonTagDecision => ({
  id, jobTitle: `Role ${id}`, companyName: "Acme", decision: "skip", reason: "Too far away", tags: ["Remote"], tagsEdited: false,
});
const first = decision("first");
const second = decision("second");
const newcomer = decision("new");
const options = [{ tag: "Remote" }, { tag: "Growth" }];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  actions.saveDecisionTagsSetting.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = (recent: ReasonTagDecision[]) => act(async () => root.render(<ReasonTagList recent={recent} options={options} disabled={false} />));
const section = (id: string) => [...container.querySelectorAll("section")].find(row => row.textContent?.includes(`Role ${id} ·`));
const checkbox = (row: Element, tag: string) => row.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${tag}"]`)!;
const guard = (row: Element) => row.querySelector<HTMLInputElement>('input[name="expectedTags"]')!.value;
const save = (row: Element) => [...row.querySelectorAll("button")].find(button => button.textContent === "Save tags")!;

it("keeps a dirty decision and its original guard when it leaves the recent list, while pristine rows disappear", async () => {
  await render([first, second]);
  act(() => checkbox(section("first")!, "Growth").click());
  await render([newcomer]);

  const kept = section("first")!;
  expect(kept).toBeTruthy();
  expect(section("second")).toBeUndefined();
  expect(checkbox(kept, "Growth").checked).toBe(true);
  expect(JSON.parse(guard(kept))).toEqual({ tags: ["Remote"], tagsEdited: false });
  expect(kept.textContent).toContain("no longer in the recent list");
  const discard = kept.querySelector<HTMLButtonElement>('button[aria-label="Discard tag draft for Role first at Acme"]')!;
  expect(discard).toBeTruthy();
  act(() => discard.click());
  expect(section("first")).toBeUndefined();
});

it("keeps a refused stale draft and does not submit a removed decision without its original guard", async () => {
  actions.saveDecisionTagsSetting.mockResolvedValue({ ok: false, error: "This decision's tags changed since this page loaded." } satisfies ActionResult);
  await render([first]);
  act(() => checkbox(section("first")!, "Growth").click());
  await render([newcomer]);
  await act(async () => save(section("first")!).click());

  expect(actions.saveDecisionTagsSetting).toHaveBeenCalledWith("first", expect.any(Object), expect.any(FormData));
  const submitted = actions.saveDecisionTagsSetting.mock.calls[0]![2] as FormData;
  expect(submitted.get("expectedTags")).toBe(JSON.stringify({ tags: ["Remote"], tagsEdited: false }));
  expect(submitted.getAll("tags")).toEqual(["Remote", "Growth"]);
  expect(section("first")?.querySelector('[role="alert"]')?.textContent).toContain("changed since this page loaded");
  expect(checkbox(section("first")!, "Growth").checked).toBe(true);
});

it("keeps a pristine row mounted if its save is pending when it leaves the recent list", async () => {
  let resolve!: (value: ActionResult) => void;
  actions.saveDecisionTagsSetting.mockImplementation(() => new Promise<ActionResult>(done => { resolve = done; }));
  await render([first]);
  act(() => save(section("first")!).click());
  await act(async () => {});
  await render([newcomer]);
  expect(section("first")).toBeTruthy();
  expect(section("first")?.querySelector<HTMLButtonElement>('button[aria-label^="Discard tag draft"]')?.disabled).toBe(true);
  expect(JSON.parse(guard(section("first")!))).toEqual({ tags: ["Remote"], tagsEdited: false });

  await act(async () => resolve({ ok: true, nextSnapshot: { expectedTags: JSON.stringify({ tags: ["Remote"], tagsEdited: true }) } }));
  expect(section("first")).toBeUndefined();
  const notice = container.querySelector<HTMLElement>('[role="status"]')!;
  expect(notice.textContent).toBe("Tags saved for Role first at Acme.");
  expect(document.activeElement).toBe(notice);
});

it("keeps a newer edit made while an earlier save is pending, then removes the retained row on its own confirmed save", async () => {
  let resolve!: (value: ActionResult) => void;
  actions.saveDecisionTagsSetting.mockImplementationOnce(() => new Promise<ActionResult>(done => { resolve = done; }))
    .mockResolvedValueOnce({ ok: true, nextSnapshot: { expectedTags: JSON.stringify({ tags: ["Remote", "Growth"], tagsEdited: true }) } } satisfies ActionResult);
  await render([first]);
  act(() => checkbox(section("first")!, "Growth").click());
  act(() => save(section("first")!).click());
  await act(async () => {});
  expect(actions.saveDecisionTagsSetting).toHaveBeenCalledOnce();
  await render([newcomer]);
  expect(section("first")).toBeTruthy();
  expect(section("first")?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(section("first")?.querySelector<HTMLButtonElement>('button[aria-label^="Discard tag draft"]')?.disabled).toBe(true);

  act(() => checkbox(section("first")!, "Growth").click());
  await act(async () => resolve({ ok: true, nextSnapshot: { expectedTags: JSON.stringify({ tags: ["Remote", "Growth"], tagsEdited: true }) } }));
  expect(section("first")).toBeTruthy();
  expect(checkbox(section("first")!, "Growth").checked).toBe(false);
  expect(JSON.parse(guard(section("first")!))).toEqual({ tags: ["Remote", "Growth"], tagsEdited: true });

  await act(async () => save(section("first")!).click());
  expect(section("first")).toBeUndefined();
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Tags saved for Role first at Acme.");
});
