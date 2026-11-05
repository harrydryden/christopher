import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/app/login/actions", () => ({ requestReset: vi.fn() }));
vi.mock("@/lib/email", () => ({ emailConfigured: () => false }));

import ForgotPasswordPage from "./page";

it("offers help instead of a reset form when email cannot be delivered", async () => {
  const page = await ForgotPasswordPage({ searchParams: Promise.resolve({}) });
  const html = renderToStaticMarkup(createElement("div", null, page));
  expect(html).toContain("Email reset is temporarily unavailable");
  expect(html).not.toContain("Send reset link");
  expect(html).not.toContain("server log");
});
