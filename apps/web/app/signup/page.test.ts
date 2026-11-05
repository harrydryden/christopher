import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/app/login/actions", () => ({ resendConfirmation: vi.fn(), signup: vi.fn() }));
vi.mock("@/lib/google", () => ({ googleConfigured: () => false }));
vi.mock("@/lib/linkedin", () => ({ linkedinConfigured: () => false }));
vi.mock("@/lib/settings", () => ({ getSystemSettings: async () => ({ registrationOpen: true }) }));

import SignupPage from "./page";

it("explains a failed confirmation delivery and keeps the requested destination", async () => {
  const page = await SignupPage({ searchParams: Promise.resolve({
    pending: "1", email: "person@example.test", error: "delivery_failed", next: "/roles/add",
  }) });
  const html = renderToStaticMarkup(createElement("div", null, page));
  expect(html).toContain("Confirm your email");
  expect(html).toContain("we could not send the confirmation link");
  expect(html).toContain("ask an administrator for help");
  expect(html).not.toContain("Administrator accounts");
  expect(html).not.toContain("server log");
  expect(html).toContain("Send the link again");
  expect(html).toContain('name="next" value="/roles/add"');
  expect(html).toContain("/login?next=%2Froles%2Fadd");
});

it("uses a neutral message after a public resend request", async () => {
  const page = await SignupPage({ searchParams: Promise.resolve({
    pending: "1", email: "person@example.test", sent: "1",
  }) });
  const html = renderToStaticMarkup(createElement("div", null, page));
  expect(html).toContain("If this address has an account waiting for confirmation and email is available");
  expect(html).not.toContain("Your account was created");
});
