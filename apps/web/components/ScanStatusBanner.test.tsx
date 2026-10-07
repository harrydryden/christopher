import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { ScanStatus } from "@/lib/scan-status";

vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
const route = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path }));

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

it("keeps scan exceptions outside the collapsed monitoring details while writing", () => {
  route.path = "/cv/example";
  try {
    const html = render("waiting");
    expect(html).toContain("<details>");
    expect(html.slice(html.indexOf("</details>"))).toContain("Scan waiting for monitoring");
    expect(html).toContain("Following 1 company");
    expect(html).not.toContain("<details open");
  } finally { route.path = "/"; }
});
