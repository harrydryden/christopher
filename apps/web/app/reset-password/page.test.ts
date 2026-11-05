import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/app/login/actions", () => ({ resetPassword: vi.fn() }));

import ResetPasswordPage from "./page";

it("does not offer the password form again after an invalid token", async () => {
  const page = await ResetPasswordPage({ searchParams: Promise.resolve({ token: "expired", error: "invalid_token" }) });
  const html = renderToStaticMarkup(createElement("div", null, page));
  expect(html).toContain("Request a new link");
  expect(html).toContain("This reset link is not valid any more.");
  expect(html).not.toContain("Set password and sign in");
  expect(html).not.toContain('name="token"');
});
