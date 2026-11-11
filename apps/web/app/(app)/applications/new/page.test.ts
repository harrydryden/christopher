import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireUser: vi.fn(async () => ({ id: "member-one" })) }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/components/CvPastedApplicationEntry", () => ({ CvPastedApplicationEntry: () => createElement("section", { "data-testid": "application-entry" }, "Form") }));

import NewApplicationPage from "./page";

it("requires an account before rendering the free application form and back route", async () => {
  const html = renderToStaticMarkup(await NewApplicationPage());
  expect(auth.requireUser).toHaveBeenCalledOnce();
  expect(html).toContain("New application");
  expect(html).toContain('href="/applications"');
  expect(html).toContain('data-testid="application-entry"');
});

it("does not expose the form when authentication fails", async () => {
  auth.requireUser.mockRejectedValueOnce(new Error("sign in"));
  await expect(NewApplicationPage()).rejects.toThrow("sign in");
});
