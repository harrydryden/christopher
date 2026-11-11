// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/cv", () => ({ saveCvLibrary: vi.fn(), rescoreLibrary: vi.fn() }));

import { CvAboutEditor } from "./CvAboutEditor";

it("opens a named contact task without mounting the large library editor on Experience", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<CvAboutEditor library={null} version={0} scopeId="account" careerManaged />));
  expect(host.querySelector('input[name="version"]')).toBeNull();

  expect(host.querySelector("details")).toBeNull();
  expect(host.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe("/library/about");
  expect(host.textContent).toBe("About you and contact");

  await act(async () => root.unmount());
  host.remove();
});
