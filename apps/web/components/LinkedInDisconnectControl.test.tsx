// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/linkedin", () => ({ unlinkLinkedIn: vi.fn() }));

import { unlinkLinkedIn } from "@/app/actions/linkedin";
import { LinkedInDisconnectControl } from "./LinkedInDisconnectControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("does not offer disconnection when LinkedIn is the only available sign-in method", () => {
  act(() => root.render(<LinkedInDisconnectControl canDisconnect={false} />));
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Set a password or link another sign-in method");
});

it("keeps the link in place on a server refusal and reports success only after unlinking", async () => {
  vi.mocked(unlinkLinkedIn).mockResolvedValueOnce({ ok: false, error: "Another sign-in method is required." })
    .mockResolvedValueOnce({ ok: true });
  act(() => root.render(<LinkedInDisconnectControl canDisconnect />));
  const button = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { button.click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Another sign-in method is required.");
  expect(router.refresh).not.toHaveBeenCalled();
  await act(async () => { button.click(); });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Experience and CVs are unchanged");
  expect(router.refresh).toHaveBeenCalledOnce();
});
