// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ add: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/actions/companies", () => ({ addCompaniesInline: mocks.add }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
import { AddCompanyHomepages } from "./AddCompanyHomepages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function enter(value: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

it("retains a refused batch and its Account recovery link without navigating or adding anything locally", async () => {
  mocks.add.mockResolvedValue({ ok: false, error: "Your plan currently has space for 100 active companies.", recovery: { href: "/account#plan-and-credits", label: "Manage company capacity" } });
  act(() => root.render(<AddCompanyHomepages userId="one" />));
  await enter("https://acme.example\nhttps://globex.example");
  await submit();
  expect(mocks.add.mock.calls[0]![0].get("urls")).toBe("https://acme.example\nhttps://globex.example");
  expect(container.querySelector("textarea")!.value).toBe("https://acme.example\nhttps://globex.example");
  expect(sessionStorage.getItem("company-homepages:v1:one")).toBe("https://acme.example\nhttps://globex.example");
  expect(container.querySelector('a[href="/account#plan-and-credits"]')).not.toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});

it("restores only this account's saved batch and clears it once following succeeds", async () => {
  sessionStorage.setItem("company-homepages:v1:one", "https://acme.example");
  sessionStorage.setItem("company-homepages:v1:two", "https://private.example");
  mocks.add.mockResolvedValue({ ok: true, redirectTo: "/suggestions?added=1" });
  act(() => root.render(<AddCompanyHomepages userId="one" />));
  expect(container.querySelector("textarea")!.value).toBe("https://acme.example");
  await submit();
  expect(sessionStorage.getItem("company-homepages:v1:one")).toBeNull();
  expect(sessionStorage.getItem("company-homepages:v1:two")).toBe("https://private.example");
  expect(mocks.push).toHaveBeenCalledWith("/suggestions?added=1");
});
