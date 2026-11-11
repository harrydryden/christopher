import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", async original => ({
  ...(await original<typeof import("react-dom")>()),
  useFormStatus: () => status,
}));

import { AuthSubmitButton } from "./AuthSubmitButton";

it("disables a pending auth submission and announces progress", () => {
  status.pending = false;
  const ready = renderToStaticMarkup(createElement(AuthSubmitButton, { label: "Sign in", pendingLabel: "Signing in…" }));
  expect(ready).toContain("Sign in");
  expect(ready).not.toContain('disabled=""');
  status.pending = true;
  const pending = renderToStaticMarkup(createElement(AuthSubmitButton, { label: "Sign in", pendingLabel: "Signing in…" }));
  expect(pending).toContain('disabled=""');
  expect(pending).toContain("Signing in…");
  expect(pending).toContain('role="status"');
  status.pending = false;
});
