import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  counts: { "auto-matched": 0, "user-shortlisted": 0, "user-dismissed": 0, archived: 0 },
  options: [] as Array<{ id: string; name: string }>,
}));
vi.mock("@/lib/queries/jobs", () => ({
  DEFAULT_SORT_DIR: { company: "asc", title: "asc", location: "asc", fit: "desc" },
  appliedRoleCount: () => 0,
  buildRoleCompanies: () => [],
  buildRoleRowVM: () => { throw new Error("No role rows expected in this fixture"); },
  fetchRoleCounts: async () => state.counts,
  fetchRolePage: async () => ({ visible: [], total: 0, page: 1, pageCount: 1 }),
  filtersToQueryString: () => "",
  parseRolesFilters: (params: Record<string, string>) => ({ company: params.company ?? "", sort: "fit", dir: "desc" }),
  resolveRoleView: () => "auto-matched",
  roleTabFor: (params: Record<string, string>) => params.view ?? null,
}));
vi.mock("@/lib/queries/companies", () => ({ listCompanyOptions: async () => state.options }));
vi.mock("@/lib/queries/applications", () => ({
  pipelineCompany: async () => null,
  pipelineStageCounts: async () => ({}),
}));
vi.mock("@/lib/queries/setup", () => ({ setupStatus: async () => ({}) }));
vi.mock("@/lib/setup", () => ({ monitoringNotice: () => ({
  state: "no-companies", title: "Follow a company", description: "Choose a company.", href: "/suggestions", action: "Follow a company",
}) }));
vi.mock("./RolesFilterBar", () => ({ RolesFilterBar: () => createElement("div", { "data-role-filters": true }) }));
vi.mock("./RolesTable", () => ({ RolesTable: () => createElement("div", { "data-role-table": true }) }));
vi.mock("./RoleRefusalNotices", () => ({ RoleRefusalNotices: () => null }));

import { RoleWorkspace } from "./RoleWorkspace";

const rendered = async (searchParams: Record<string, string>, companyId?: string) => {
  const content = await RoleWorkspace({ userId: "user-1", searchParams, companyId });
  return renderToStaticMarkup(createElement("div", null, content));
};

it("leaves a genuinely empty first visit to Setup without rendering empty role controls", async () => {
  state.counts = { "auto-matched": 0, "user-shortlisted": 0, "user-dismissed": 0, archived: 0 };
  state.options = [];
  const html = await rendered({});
  expect(html).not.toContain('aria-label="Role status"');
  expect(html).not.toContain("data-role-filters");
  expect(html).not.toContain("data-role-table");
});

it("keeps the role workspace for an explicit search, a company view, or an existing company", async () => {
  state.counts = { "auto-matched": 0, "user-shortlisted": 0, "user-dismissed": 0, archived: 0 };
  state.options = [];
  expect(await rendered({ search: "operations" })).toContain('aria-label="Role status"');
  expect(await rendered({}, "company-1")).toContain("data-role-filters");
  state.options = [{ id: "company-1", name: "Example" }];
  expect(await rendered({})).toContain("data-role-table");
  state.counts = { "auto-matched": 0, "user-shortlisted": 0, "user-dismissed": 1, archived: 0 };
  state.options = [];
  expect(await rendered({})).toContain('aria-label="Role status"');
});
