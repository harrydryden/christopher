import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { buildSetupChecklist } from "@/lib/setup";

vi.mock("@/app/actions/setup", () => ({ dismissSetupChecklist: vi.fn() }));

import { SetupChecklist } from "./SetupChecklist";

it("offers company, existing-role and optional Experience starts without repeating the next action", () => {
  const checklist = buildSetupChecklist({
    emailConfirmed: true, gateChosen: false, seedProfileWritten: false,
    companiesFollowed: 0, libraryFilled: false, dismissedAt: null,
    monitoring: { activeCompanies: 0, successfulCompanies: 0, attentionCompanies: 0,
      pendingCompanies: 0, lastSuccessAt: null },
  });
  const html = renderToStaticMarkup(createElement(SetupChecklist, { checklist, variant: "explanation" }));
  expect(html).toContain("Choose how to begin");
  expect(html).toContain("Find roles at companies I follow");
  expect(html).toContain("I already have a role");
  expect(html).toContain("Prepare Experience");
  expect(html).toContain('href="/roles/add"');
  expect(html).toContain('href="/library"');
  expect(html).not.toContain("Start here ·");
});
