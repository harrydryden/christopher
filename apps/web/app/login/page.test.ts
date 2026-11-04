import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ login: vi.fn() }));
vi.mock("@/lib/google", () => ({ googleConfigured: () => true }));
vi.mock("@/lib/linkedin", () => ({ linkedinConfigured: () => true }));
vi.mock("@/lib/session", async original => ({
  ...(await original<typeof import("@/lib/session")>()),
  sessionSecret: () => "test-secret",
}));

import LoginPage from "./page";

it("explains Google email proof recovery and returns existing-account sign-in to Account", async () => {
  const page = await LoginPage({ searchParams: Promise.resolve({ error: "google_email_proof" }) });
  const html = renderToStaticMarkup(createElement("main", null, page));
  expect(html).toContain("We could not confirm this email through Google.");
  expect(html).toContain("confirm its email if needed, then link Google from Account");
  expect(html).toContain("create an account with email and confirm it first");
  expect(html).toContain('name="next" value="/account"');
  expect(html).toContain("/signup?next=%2Faccount");
});

it("preserves an explicit safe return path and rejects an external one", async () => {
  const safe = renderToStaticMarkup(createElement("main", null,
    await LoginPage({ searchParams: Promise.resolve({ error: "google_email_proof", next: "/applications" }) })));
  expect(safe).toContain('name="next" value="/applications"');
  const external = renderToStaticMarkup(createElement("main", null,
    await LoginPage({ searchParams: Promise.resolve({ error: "google_email_proof", next: "https://example.net" }) })));
  expect(external).not.toContain("https://example.net");
});
