import { expect, it } from "vitest";
import { PRIMARY_NAV_ITEMS, SECONDARY_NAV_ITEMS, workspaceNavActive, workspaceSections } from "./workspace-navigation";

it("groups existing company and role routes beneath Find roles without losing their deep links", () => {
  expect(PRIMARY_NAV_ITEMS.map(item => item.label)).toEqual(["Find roles", "Applications", "Experience"]);
  for (const path of ["/", "/roles/add", "/roles/123", "/companies", "/companies/123", "/suggestions"])
    expect(workspaceNavActive("/", path)).toBe(true);
  expect(workspaceSections("/companies/123")?.map(([, label]) => label)).toEqual(["Matches", "Following", "Discover companies"]);
  expect(workspaceSections("/suggestions")?.map(([href]) => href)).toContain("/companies");
  expect(workspaceNavActive("/", "/applications")).toBe(false);
});

it("keeps CVs with Applications and search learning with Preferences", () => {
  expect(workspaceNavActive("/applications", "/cv/123/preparation")).toBe(true);
  expect(workspaceNavActive("/settings", "/learning")).toBe(true);
  expect(SECONDARY_NAV_ITEMS.map(item => item.label)).toContain("Preferences");
  expect(workspaceSections("/learning")?.map(([href]) => href)).toEqual(["/settings", "/learning"]);
  expect(workspaceSections("/admin/health")?.map(([href]) => href)).toContain("/admin/health");
});
