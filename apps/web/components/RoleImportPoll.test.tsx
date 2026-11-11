// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { RoleImportPoll } from "./RoleImportPoll";

afterEach(() => { vi.useRealTimers(); refresh.mockReset(); });

it("refreshes a visible queued import and stops when unmounted", () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<RoleImportPoll />));
  act(() => vi.advanceTimersByTime(4000));
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  act(() => vi.advanceTimersByTime(4000));
  expect(refresh).toHaveBeenCalledTimes(1);
  host.remove();
});
