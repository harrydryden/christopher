// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CvAboutContactForm } from "./CvAboutContactForm";

const refresh = vi.fn();
const save = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/cv-about", () => ({ saveCvAbout: (...args: unknown[]) => save(...args) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initial = { version: 3, values: { name: "Alex", email: "alex@example.com", phone: "", location: "London",
  linkedinUrl: "", websiteUrl: "", contact: "", profile: "Original profile" } };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); save.mockReset(); refresh.mockReset(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function typeIn(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("keeps an unsaved profile through an incoming version and offers explicit recovery", async () => {
  await act(async () => root.render(<CvAboutContactForm initial={initial} />));
  act(() => typeIn("profile", "My unsaved profile"));
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  await act(async () => root.render(<CvAboutContactForm initial={{ version: 4, values: { ...initial.values, profile: "Elsewhere" } }} />));
  expect(host.querySelector<HTMLTextAreaElement>('[name="profile"]')?.value).toBe("My unsaved profile");
  expect(host.textContent).toContain("Saved details changed elsewhere");
  save.mockResolvedValue({ ok: false, error: "The library changed. Reload before saving." });
  await act(async () => host.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledWith(3, expect.objectContaining({ profile: "My unsaved profile" }));
  expect(host.querySelector<HTMLTextAreaElement>('[name="profile"]')?.value).toBe("My unsaved profile");
  expect(host.getAttribute("aria-busy")).toBeNull();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Load saved version")!.click());
  expect(host.querySelector<HTMLTextAreaElement>('[name="profile"]')?.value).toBe("Elsewhere");
});

it("renders a focused form with accessible contact fields and no legacy Experience editor", async () => {
  await act(async () => root.render(<CvAboutContactForm initial={initial} />));
  expect([...host.querySelectorAll("input, textarea")].map(node => node.getAttribute("name"))).toEqual([
    "name", "email", "phone", "location", "linkedinUrl", "websiteUrl", "contact", "profile",
  ]);
  expect(host.querySelector("details")).toBeNull();
  expect(host.querySelector('[name="entries"]')).toBeNull();
  expect(host.textContent).toContain("Save contact details");
});
