// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CatalogueRoleActions } from "./CatalogueRoleActions";

const decide = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/recommendations", () => ({ decideCatalogueRecommendation: decide }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; decide.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

it("keeps the choice visible on failure and enables a successful retry with a link to the shortlist", async () => {
  decide.mockResolvedValueOnce({ ok: false, error: "Could not save" }).mockResolvedValueOnce({ ok: true });
  await act(async () => root.render(<CatalogueRoleActions jobId="role" title="Operations Lead"/>));
  await act(async () => button("Shortlist Operations Lead").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save");
  expect(button("Shortlist Operations Lead").disabled).toBe(false);
  await act(async () => button("Shortlist Operations Lead").click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Shortlisted");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/?view=user-shortlisted");
});
it("prevents overlapping decisions while saving and acknowledges dismissal", async () => {
  let finish!: (value: { ok: true }) => void;
  decide.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<CatalogueRoleActions jobId="role" title="Operations Lead"/>));
  await act(async () => { button("Dismiss Operations Lead").click(); button("Shortlist Operations Lead").click(); });
  expect(decide).toHaveBeenCalledTimes(1);
  expect(button("Dismiss Operations Lead").disabled).toBe(true);
  expect(button("Dismiss Operations Lead").textContent).toBe("Saving…");
  await act(async () => finish({ ok: true }));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Dismissed");
});
