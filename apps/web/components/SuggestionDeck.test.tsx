// @vitest-environment jsdom
/**
 * The Discover deck, in a browser: a swiped card leaves at once and the next is ready while the
 * server answers, several swipes can be in flight together, and a refusal puts its card back on
 * top with the server's sentence.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DiscoveryActionResult } from "@/lib/discovery-ux";

const actions = vi.hoisted(() => ({ acceptSuggestion: vi.fn(), rejectSuggestion: vi.fn() }));
vi.mock("@/app/actions/suggestions", () => actions);

import { SuggestionDeck, type DeckCard } from "./SuggestionDeck";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (id: string, name: string): DeckCard => ({ id, name, body: <h3>{name}</h3> });
const CARDS = [card("s-1", "Acme"), card("s-2", "Globex"), card("s-3", "Initech")];

function deferred() {
  let resolve!: (value: DiscoveryActionResult) => void;
  const promise = new Promise<DiscoveryActionResult>(done => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  actions.acceptSuggestion.mockReset();
  actions.rejectSuggestion.mockReset();
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const top = () => container.querySelector("article")?.getAttribute("aria-label");
const text = () => container.textContent ?? "";
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(el => el.textContent === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
};

it("takes each swiped card off at once, lets the next be decided while the first is saved, and puts a refused one back on top", async () => {
  const dismissing = deferred();
  const following = deferred();
  actions.rejectSuggestion.mockReturnValue(dismissing.promise);
  actions.acceptSuggestion.mockReturnValue(following.promise);
  act(() => root.render(<SuggestionDeck cards={CARDS} total={12} empty={<p>No companies to review</p>} />));
  expect(top()).toBe("Acme");
  expect(text()).toContain("12 to review");

  act(() => button("⟵ Dismiss").click());
  expect(actions.rejectSuggestion).toHaveBeenCalledWith("s-1", expect.any(FormData));
  // The next card is on top and usable while the first is still being saved.
  expect(top()).toBe("Globex");
  expect(button("Follow ⟶").disabled).toBe(false);
  expect(text()).toContain("11 to review");

  act(() => button("Follow ⟶").click());
  expect(actions.acceptSuggestion).toHaveBeenCalledWith("s-2");
  expect(top()).toBe("Initech");

  // The server refuses the first: its card comes back on top with the sentence.
  await act(async () => { dismissing.resolve({ ok: false, error: "This suggestion has already been reviewed. Refresh to see its status." }); await dismissing.promise; });
  expect(top()).toBe("Acme");
  expect(text()).toContain("This suggestion has already been reviewed.");

  await act(async () => { following.resolve({ ok: true, message: "Globex added to tracked companies." }); await following.promise; });
  expect(top()).toBe("Acme");
  expect(text()).toContain("Globex added to tracked companies.");
});

it("keeps a follow at capacity on screen while checking, then offers Account without marking it accepted", async () => {
  const following = deferred();
  actions.acceptSuggestion.mockReturnValue(following.promise);
  act(() => root.render(<SuggestionDeck cards={CARDS} empty={<p>No companies</p>} remainingCompanySlots={0} />));
  act(() => button("Follow ⟶").click());
  expect(top()).toBe("Acme");
  expect(container.querySelector("[data-leaving]")).toBeNull();
  expect(button("Follow ⟶").disabled).toBe(true);
  await act(async () => {
    following.resolve({ ok: false, error: "Free includes 25 active companies.", recovery: { href: "/account#plan-and-credits", label: "Manage company capacity" } });
    await following.promise;
  });
  expect(top()).toBe("Acme");
  expect(text()).toContain("3 to review");
  expect(container.querySelector('a[href="/account#plan-and-credits"]')).not.toBeNull();
  actions.rejectSuggestion.mockResolvedValue({ ok: true });
  await act(async () => button("⟵ Dismiss").click());
  expect(top()).toBe("Globex");
});

it("uses the last optimistic company space only once across quick consecutive follows", async () => {
  const first = deferred();
  const second = deferred();
  actions.acceptSuggestion.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  act(() => root.render(<SuggestionDeck cards={CARDS} empty={<p>No companies</p>} remainingCompanySlots={1} />));
  act(() => button("Follow ⟶").click());
  expect(top()).toBe("Globex");
  act(() => button("Follow ⟶").click());
  expect(top()).toBe("Globex");
  await act(async () => { first.resolve({ ok: true }); await first.promise; });
  await act(async () => { second.resolve({ ok: false, error: "No company spaces left." }); await second.promise; });
  expect(top()).toBe("Globex");
  expect(text()).toContain("2 to review");
});

it("can accept an already-followed suggestion at capacity after the server confirms no extra slot is needed", async () => {
  actions.acceptSuggestion.mockResolvedValue({ ok: true, message: "Acme is already in your companies." });
  act(() => root.render(<SuggestionDeck cards={CARDS} empty={<p>No companies</p>} remainingCompanySlots={0} />));
  await act(async () => button("Follow ⟶").click());
  expect(top()).toBe("Globex");
  expect(text()).toContain("Acme is already in your companies.");
});

it("sends a decided card off the edge as a picture while the next card is already live", async () => {
  vi.useFakeTimers();
  try {
    actions.acceptSuggestion.mockReturnValue(new Promise(() => {}));
    act(() => root.render(<SuggestionDeck cards={CARDS} total={3} empty={<p>No companies to review</p>} />));
    act(() => button("Follow ⟶").click());
    expect(top()).toBe("Globex");
    const ghost = () => container.querySelector<HTMLElement>("[data-leaving]");
    expect(ghost()?.getAttribute("data-leaving")).toBe("s-1");
    expect(ghost()?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => { vi.advanceTimersByTime(50); });
    expect(ghost()?.style.transform).toContain(`translateX(${window.innerWidth}px)`);
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(ghost()).toBeNull();
    expect(top()).toBe("Globex");
  } finally { vi.useRealTimers(); }
});

it("drops a drag in progress when a refused card comes back on top, so letting go decides nothing", async () => {
  const dismissing = deferred();
  actions.rejectSuggestion.mockReturnValue(dismissing.promise);
  act(() => root.render(<SuggestionDeck cards={CARDS} total={3} empty={<p>No companies to review</p>} />));
  act(() => button("⟵ Dismiss").click());
  expect(top()).toBe("Globex");

  const article = () => container.querySelector("article")!;
  article().setPointerCapture = () => {};
  const pointer = (type: string, clientX: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    act(() => { article().dispatchEvent(event); });
  };
  pointer("pointerdown", 0);
  pointer("pointermove", 200);
  await act(async () => { dismissing.resolve({ ok: false, error: "Could not save. Try again." }); await dismissing.promise; });
  expect(top()).toBe("Acme");
  pointer("pointerup", 200);
  expect(actions.acceptSuggestion).not.toHaveBeenCalled();
});

it("waits for the next cards instead of claiming the deck is empty when every card on hand is in flight", async () => {
  const dismissing = deferred();
  actions.rejectSuggestion.mockReturnValue(dismissing.promise);
  act(() => root.render(<SuggestionDeck cards={[CARDS[0]!]} total={5} empty={<p>No companies to review</p>} />));
  act(() => button("⟵ Dismiss").click());
  expect(text()).toContain("Loading the next companies");
  expect(text()).not.toContain("No companies to review");

  await act(async () => { dismissing.resolve({ ok: true }); await dismissing.promise; });
  // The action's own render refills the deck.
  act(() => root.render(<SuggestionDeck cards={[CARDS[1]!]} total={4} empty={<p>No companies to review</p>} />));
  expect(top()).toBe("Globex");
  expect(text()).toContain("4 to review");
});
