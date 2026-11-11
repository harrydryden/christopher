// @vitest-environment jsdom
/** Named company management preserves ownership, confirmation and capacity recovery. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  archiveCompany: vi.fn(), pauseCompany: vi.fn(), rediscoverCompany: vi.fn(),
  refreshCompany: vi.fn(), resumeCompany: vi.fn(), unfollowCompany: vi.fn(),
}));
vi.mock("@/app/actions/companies", () => actions);

import { CompanyManageMenu } from "./CompanyManageMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "5d1c7a2e-0f3b-4a8e-9c6d-2b7e1f4a3c90";
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset().mockResolvedValue(undefined);
  actions.resumeCompany.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("keeps a capacity refusal beside the controls with an Account recovery link", async () => {
  actions.resumeCompany.mockResolvedValue({ ok: false, error: "Free includes 25 active companies.", recovery: { href: "/account#plan-and-credits", label: "Manage company capacity" } });
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="paused" />));
  await act(async () => button("Resume scanning").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Free includes 25");
  expect(container.querySelector('a[href="/account#plan-and-credits"]')?.textContent).toBe("Manage company capacity");
  expect(button("Resume scanning").disabled).toBe(false);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const labels = () => [...container.querySelectorAll("button")].map((el) => el.textContent);
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((el) => el.textContent === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
};

it("links list rows to their company management destination without hidden controls", () => {
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="active" extra="refresh" />));
  expect(container.querySelector("details")).toBeNull();
  expect(container.querySelector("a")?.getAttribute("href")).toBe(`/companies/${COMPANY}#manage`);
  expect(labels()).toEqual([]);
});

it("calls the action with the row's company, and asks before taking the company away", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="active" />));
  await act(async () => button("Pause scanning").click());
  expect(actions.pauseCompany).toHaveBeenCalledWith(COMPANY);

  await act(async () => button("Stop following").click());
  expect(confirm).toHaveBeenCalledWith("Stop following Acme? Its roles leave your table. Your decision snapshots are retained.");
  expect(actions.unfollowCompany).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => button("Hide from my list").click());
  expect(actions.archiveCompany).toHaveBeenCalledWith(COMPANY);
});

it("offers status-specific controls and prevents unverified rediscovery", async () => {
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="archived" />));
  expect(labels()).toEqual(["Follow again", "Stop following"]);
  await act(async () => button("Follow again").click());
  expect(actions.resumeCompany).toHaveBeenCalledWith(COMPANY);
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="paused" extra="rediscover" blockedReason="Confirm your email address first." />));
  expect(button("Re-discover").disabled).toBe(true);
  expect(button("Re-discover").title).toBe("Confirm your email address first.");
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="paused" extra="rediscover" />));
  expect(labels()).toEqual(["Re-discover", "Resume scanning", "Hide from my list", "Stop following"]);
  await act(async () => button("Re-discover").click());
  expect(actions.rediscoverCompany).toHaveBeenCalledWith(COMPANY);
});
