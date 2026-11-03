import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LinkedInButton } from "./AuthShell";

it("sets the separate LinkedIn sign-in and account-link intents", () => {
  const signIn = renderToStaticMarkup(createElement(LinkedInButton, { next: "/applications" }));
  expect(signIn).toContain("Continue with LinkedIn");
  expect(signIn).toContain("/auth/linkedin?intent=sign_in&amp;next=%2Fapplications");
  const link = renderToStaticMarkup(createElement(LinkedInButton, { intent: "link", next: "/account" }));
  expect(link).toContain("/auth/linkedin?intent=link&amp;next=%2Faccount");
  expect(link).not.toContain("import");
});
