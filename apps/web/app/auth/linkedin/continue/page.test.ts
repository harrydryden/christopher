import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const view = vi.hoisted(() => ({
  pending: { status: "expired" as string, email: undefined as string | undefined },
  current: null as null | { user: { email: string; passwordHash: string | null; emailVerifiedAt: Date | null } },
  google: false,
}));
vi.mock("@/app/actions/linkedin", () => ({
  getLinkedInPendingView: async () => view.pending,
  beginLinkedInEmailVerification: vi.fn(),
  completeLinkedInEmailVerification: vi.fn(),
  completeLinkedInLink: vi.fn(),
  createLinkedInAccount: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => view.current }));
vi.mock("@/lib/google", () => ({ googleConfigured: () => view.google }));

import LinkedInContinuePage from "./page";

beforeEach(() => {
  view.pending = { status: "expired", email: undefined };
  view.current = null;
  view.google = false;
});

async function html(searchParams: Record<string, string> = {}) {
  return renderToStaticMarkup(await LinkedInContinuePage({ searchParams: Promise.resolve(searchParams) }));
}

it("shows a pending account choice without assuming sign-in imported a profile", async () => {
  view.pending = { status: "create_account", email: "chosen@example.test" };
  const rendered = await html();
  expect(rendered).toContain("Confirmed email: chosen@example.test");
  expect(rendered).toContain("Continue and create an account");
  expect(rendered).toContain("sign in and link instead");
  expect(rendered).toContain("Signing in does not import your profile or connections");
  expect(rendered).not.toContain("sign in with Google again");
});

it("offers explicit linking to the signed-in account, with a password field, without creating a second account", async () => {
  view.pending = { status: "create_account", email: "chosen@example.test" };
  view.current = { user: { email: "member@example.test", passwordHash: "hash", emailVerifiedAt: new Date() } };
  const rendered = await html();
  expect(rendered).toContain("Signed in as member@example.test");
  expect(rendered).toContain("Link to this existing account");
  expect(rendered).toContain('name="password"');
  expect(rendered).not.toContain("Continue and create an account");
  expect(rendered).not.toContain("sign in with Google again");
});

it("only offers Google reauthentication when configured and gives a specific safe error", async () => {
  view.pending = { status: "link_required", email: "provider@example.test" };
  view.current = { user: { email: "member@example.test", passwordHash: null, emailVerifiedAt: new Date() } };
  view.google = true;
  const rendered = await html({ error: "link_reauth" });
  expect(rendered).toContain("LinkedIn address: provider@example.test");
  expect(rendered).toContain("sign in with Google again");
  expect(rendered).toContain("Sign in again with this account&#x27;s password or Google");
  expect(rendered).toContain('role="alert"');
});

it("does not expose pending controls after the browser-bound flow expires", async () => {
  const rendered = await html({ error: "unknown-provider-detail" });
  expect(rendered).toContain("This LinkedIn sign-in has expired");
  expect(rendered).not.toContain("unknown-provider-detail");
  expect(rendered).not.toContain("Link LinkedIn to this account");
});

it("lets an existing verified account link when LinkedIn did not supply an email, without requiring a new-account proof", async () => {
  view.pending = { status: "verify_email", email: undefined };
  const unsigned = await html();
  expect(unsigned).toContain("Sign in and link LinkedIn");
  view.current = { user: { email: "member@example.test", passwordHash: "hash", emailVerifiedAt: new Date() } };
  const signed = await html();
  expect(signed).toContain("Link LinkedIn to this account");
  expect(signed).toContain("Send confirmation email");
  expect(signed).not.toContain("Continue and create an account");
});
