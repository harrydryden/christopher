// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const route = vi.hoisted(() => ({ path: "/applications" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path }));
vi.mock("next/link", () => ({ default: ({ children, prefetch: _prefetch, ...props }: { children: ReactNode; prefetch?: boolean }) => <a {...props}>{children}</a> }));
import { CvActivityBanner } from "./CvActivityBanner";
import type { CvActivityReading } from "@/lib/cv-activity";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const active: CvActivityReading = { id: "draft:a", draftId: "a", contextId: null, company: "Acme", jobTitle: "Analyst", status: "generating", stage: "writing", createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", completedAt: null, read: true, unread: false };
const ready: CvActivityReading = { ...active, id: "event-a", status: "ready", unread: true, read: false };
const answer = (items: CvActivityReading[], ok = true) => ({ ok, json: async () => items }) as Response;
let root: Root; let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers(); route.path = "/applications";
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = async (initial: CvActivityReading[]) => { await act(async () => root.render(<CvActivityBanner initial={initial}>Monitoring</CvActivityBanner>)); };
it("tracks a build across navigation and announces completion without replacing the page", async () => {
  const fetcher = vi.fn().mockResolvedValue(answer([active])); vi.stubGlobal("fetch", fetcher);
  await render([active]);
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe("Writing your CV");
  expect(host.textContent).not.toContain("Monitoring");
  route.path = "/companies"; fetcher.mockResolvedValue(answer([ready])); await render([active]);
  expect(host.querySelector('[role="status"]')?.textContent).toContain("CV ready: Acme");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/cv/a");
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
});
it("does not announce historical notices, preserves failed acknowledgements and dismisses only after success", async () => {
  const fetcher = vi.fn().mockResolvedValue(answer([ready])); vi.stubGlobal("fetch", fetcher);
  await render([ready]); expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  fetcher.mockResolvedValue(answer([], false));
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Could not dismiss"); expect(host.textContent).toContain("CV ready");
  fetcher.mockResolvedValue(answer([])); await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Monitoring"); expect(host.textContent).not.toContain("CV ready");
});
it("pauses network work while hidden and catches a completion on return", async () => {
  const fetcher = vi.fn().mockResolvedValue(answer([active])); vi.stubGlobal("fetch", fetcher); await render([active]);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => vi.advanceTimersByTimeAsync(60_000)); expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(answer([ready]));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(host.textContent).toContain("CV ready"); expect(fetcher).toHaveBeenCalledTimes(2);
});
