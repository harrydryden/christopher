// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import WorkspaceError from "./error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });

it("keeps operational details private and submits one retry for rapid repeat clicks", () => {
  vi.stubEnv("NODE_ENV", "production");
  const reset = vi.fn();
  act(() => root.render(createElement(WorkspaceError, {
    error: Object.assign(new Error("Sensitive database detail"), { digest: "reference-123" }), reset,
  })));
  expect(container.textContent).toContain("Something went wrong");
  expect(container.textContent).toContain("Reference reference-123");
  expect(container.textContent).not.toContain("Sensitive database detail");
  const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Try again")!;
  act(() => { retry.click(); retry.click(); });
  expect(reset).toHaveBeenCalledTimes(1);
  expect(router.refresh).toHaveBeenCalledTimes(1);
});
