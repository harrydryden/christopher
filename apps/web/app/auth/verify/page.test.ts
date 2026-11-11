import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ confirmEmail: vi.fn() }));
vi.mock("@/lib/accounts", () => ({ previewVerification: async () => ({
  userId: "person-1", email: "person@example.test", pending: true,
}) }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => null }));

import VerifyPage from "./page";

it("keeps a safe destination through the confirmation form", async () => {
  const page = await VerifyPage({ searchParams: Promise.resolve({ token: "one-time", next: "/roles/add" }) });
  const html = renderToStaticMarkup(createElement("div", null, page));
  expect(html).toContain('name="next" value="/roles/add"');
  expect(html).toContain("Confirm and sign in");
  expect(html).toContain('aria-describedby="verify-password-help"');
  const unsafe = await VerifyPage({ searchParams: Promise.resolve({ token: "one-time", next: "https://outside.example" }) });
  expect(renderToStaticMarkup(createElement("div", null, unsafe))).not.toContain("https://outside.example");
});
