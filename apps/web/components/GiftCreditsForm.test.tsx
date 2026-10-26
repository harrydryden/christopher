// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const gift = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/account", () => ({ giftAccountCvCredits: gift }));
import { GiftCreditsForm } from "./GiftCreditsForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actorId = "admin-1";
const userId = "member-1";
const email = "member@example.com";
const storageKey = `admin-credit-gift:${actorId}:${userId}`;
let container: HTMLDivElement;
let root: Root;

function saved() {
  return JSON.parse(sessionStorage.getItem(storageKey)!) as { requestId: string; credits: string; reason: string };
}

function field(label: string) {
  return [...container.querySelectorAll<HTMLInputElement>("input")].find(input => input.parentElement?.textContent?.includes(label))!;
}

async function edit(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function mount() {
  act(() => root.render(<GiftCreditsForm actorId={actorId} userId={userId} email={email} />));
}

beforeEach(() => {
  gift.mockReset();
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps controls disabled until the saved submission is restored", () => {
  const server = document.createElement("div");
  server.innerHTML = renderToStaticMarkup(<GiftCreditsForm actorId={actorId} userId={userId} email={email} />);
  expect([...server.querySelectorAll("input, button")].every(control => (control as HTMLInputElement).disabled)).toBe(true);

  sessionStorage.setItem(storageKey, JSON.stringify({ requestId: "saved-request", credits: "7", reason: "Pilot thank-you" }));
  mount();
  expect(saved()).toEqual({ requestId: "saved-request", credits: "7", reason: "Pilot thank-you" });
  expect(field("Credits").value).toBe("7");
  expect(field("Reason").value).toBe("Pilot thank-you");
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

it("preserves the request and entered details on rejection and on an unknown response", async () => {
  mount();
  await edit("Credits", "8");
  await edit("Reason", "Research pilot");
  const original = saved();

  gift.mockResolvedValueOnce({ ok: false, error: "Could not confirm the gift." });
  await submit();
  expect(gift.mock.calls[0]![0]).toBeInstanceOf(FormData);
  expect(gift.mock.calls[0]![0].get("requestId")).toBe(original.requestId);
  expect(saved()).toEqual(original);
  expect(field("Credits").value).toBe("8");
  expect(field("Reason").value).toBe("Research pilot");

  gift.mockRejectedValueOnce(new TypeError("Response lost"));
  await submit();
  expect(gift.mock.calls[1]![0].get("requestId")).toBe(original.requestId);
  expect(saved()).toEqual(original);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("result is unknown");

  act(() => root.unmount());
  root = createRoot(container);
  mount();
  expect(saved()).toEqual(original);
  expect(field("Credits").value).toBe("8");
  expect(field("Reason").value).toBe("Research pilot");
});

it("rotates the request only after confirmed success, including an already-applied replay", async () => {
  mount();
  await edit("Credits", "5");
  await edit("Reason", "Support gesture");
  const first = saved().requestId;
  gift.mockResolvedValueOnce({ ok: true, alreadyApplied: false });
  await submit();
  expect(gift.mock.calls[0]![0].get("requestId")).toBe(first);
  expect(saved()).toMatchObject({ credits: "", reason: "" });
  expect(saved().requestId).not.toBe(first);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("5 CV credits gifted");

  await edit("Credits", "2");
  await edit("Reason", "Prior gift replay");
  const second = saved().requestId;
  gift.mockResolvedValueOnce({ ok: true, alreadyApplied: true });
  await submit();
  expect(gift.mock.calls[1]![0].get("requestId")).toBe(second);
  expect(saved().requestId).not.toBe(second);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("No further credits were added");
});

it("keeps a conflicting request until an explicit new-gift click", async () => {
  mount();
  await edit("Credits", "3");
  await edit("Reason", "Launch pilot");
  const original = saved();
  gift.mockResolvedValueOnce({ ok: false, code: "conflict", error: "This request was already used." });
  await submit();
  expect(saved()).toEqual(original);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("already used");
  const reset = [...container.querySelectorAll("button")].find(button => button.textContent === "Start a new gift")!;
  await act(async () => reset.click());
  expect(saved().requestId).not.toBe(original.requestId);
  expect(saved()).toMatchObject({ credits: "", reason: "" });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain("Start a new gift");
});
