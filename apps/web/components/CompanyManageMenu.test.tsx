// @vitest-environment jsdom
/**
 * A company's Manage menu, in a browser: closed, a row carries nothing but the summary; opened, it
 * offers what the follow's status allows and calls the action with the row's company, asking first
 * where the action takes something away.
 */
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
async function open() {
  const details = container.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

it("renders only its summary until it is opened", async () => {
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="active" extra="refresh" />));
  expect(container.textContent).toBe("Manage");
  expect(labels()).toEqual([]);
  await open();
  expect(labels()).toEqual(["Refresh", "Pause scanning", "Hide from my list", "Stop following"]);
});

it("calls the action with the row's company, and asks before taking the company away", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="active" extra="refresh" />));
  await open();
  await act(async () => button("Pause scanning").click());
  expect(actions.pauseCompany).toHaveBeenCalledWith(COMPANY);

  await act(async () => button("Stop following").click());
  expect(confirm).toHaveBeenCalledWith("Stop following Acme? Its roles leave your table. Your decision snapshots are retained.");
  expect(actions.unfollowCompany).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => button("Hide from my list").click());
  expect(actions.archiveCompany).toHaveBeenCalledWith(COMPANY);
});

it("offers what the status allows, and holds Refresh for an unconfirmed account or a running discovery", async () => {
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="archived" extra="refresh" />));
  await open();
  // No Refresh for a follow that is not active, no Hide for one already hidden.
  expect(labels()).toEqual(["Follow again", "Stop following"]);
  await act(async () => button("Follow again").click());
  expect(actions.resumeCompany).toHaveBeenCalledWith(COMPANY);

  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="active" extra="refresh" blockedReason="Confirm your email address first." />));
  expect(button("Refresh").disabled).toBe(true);
  expect(button("Refresh").title).toBe("Confirm your email address first.");
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="active" extra="refresh" running />));
  expect(button("Refreshing…").disabled).toBe(true);
  act(() => root.render(<CompanyManageMenu companyId={COMPANY} companyName="Acme" status="paused" extra="rediscover" />));
  expect(labels()).toEqual(["Re-discover", "Resume scanning", "Hide from my list", "Stop following"]);
  await act(async () => button("Re-discover").click());
  expect(actions.rediscoverCompany).toHaveBeenCalledWith(COMPANY);
});
