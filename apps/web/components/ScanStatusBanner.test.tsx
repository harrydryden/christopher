import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { ScanStatus } from "@/lib/scan-status";

vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { ScanStatusBanner } from "./ScanStatusBanner";

const initial: ScanStatus = {
  scanState: "idle", lastScanAt: null, following: 1, newRoleMatches: 0, newCompanyMatches: 0,
  live: true, wakeInMs: null,
};
const render = (scanState: ScanStatus["scanState"]) => renderToStaticMarkup(<ScanStatusBanner initial={{ ...initial, scanState }} />);

it("links a stopped or restarting unfinished scan to Health without claiming it is scanning", () => {
  for (const state of ["waiting", "restarting"] as const) {
    const html = render(state);
    expect(html).toContain('href="/health"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<a role="status"');
    expect(html).not.toContain("Scanning now");
    expect(html).toContain(state === "waiting" ? "Scan waiting for monitoring" : "Scan may be interrupted");
  }
  expect(render("scanning")).toContain("Scanning now");
  expect(render("idle")).not.toContain("Scanning now");
});
