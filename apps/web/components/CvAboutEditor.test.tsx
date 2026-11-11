// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/cv", () => ({ saveCvLibrary: vi.fn(), rescoreLibrary: vi.fn() }));

import { CvAboutEditor } from "./CvAboutEditor";

// React's lazy boundary is resolved during the same act as the disclosure toggle.

it("loads the About editor only after opening its disclosure", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<CvAboutEditor library={null} version={0} scopeId="account" careerManaged />));
  expect(host.querySelector('input[name="version"]')).toBeNull();

  const details = host.querySelector("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));
    await import("./CvLibraryEditor");
  });
  expect(host.querySelector<HTMLInputElement>('input[name="version"]')?.value).toBe("0");

  await act(async () => root.unmount());
  host.remove();
});
