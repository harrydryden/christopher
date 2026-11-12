// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/cv", () => ({ saveCvLibrary: vi.fn(), rescoreLibrary: vi.fn() }));

import { CvLibraryEditor } from "./CvLibraryEditor";

it("keeps About you while career facts have one editor", () => {
  const html = renderToStaticMarkup(<CvLibraryEditor library={null} version={0} scopeId="account" careerManaged />);
  expect(html).toContain("About you");
  expect(html).not.toContain("Education, training &amp; skills");
  expect(html).toContain("Name");
  expect(html).not.toContain("Add job");
  expect(html).not.toContain("Confirm all");
  expect(html).not.toContain("library-panel-experience");
  expect(html).not.toContain("library-panel-education");
  expect(html).not.toContain("Your confirmed evidence");
});

it("adopts a newer compatibility version when the About content is unchanged", () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<CvLibraryEditor library={null} version={0} scopeId="account" careerManaged />));
  expect(host.querySelector<HTMLInputElement>('input[name="version"]')?.value).toBe("0");
  act(() => root.render(<CvLibraryEditor library={null} version={2} scopeId="account" careerManaged />));
  expect(host.querySelector<HTMLInputElement>('input[name="version"]')?.value).toBe("2");
  act(() => root.unmount()); host.remove();
});
