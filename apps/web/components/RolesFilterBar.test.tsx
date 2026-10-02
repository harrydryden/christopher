// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { parseRolesFilters } from "@/lib/queries/jobs";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { RolesFilterBar } from "./RolesFilterBar";

it("names the action and summarises applied filters while keeping phone controls in one disclosure", () => {
  const filters = { ...parseRolesFilters({ view: "auto-matched" }), company: "company-1", q: "Director",
    location: "London", minFit: 70, status: ["new" as const], sort: "fit" as const, dir: "desc" as const };
  const markup = renderToStaticMarkup(<RolesFilterBar filters={filters} companyOptions={[{ id: "company-1", name: "Meridian" }]}
    exportHref="/api/export.csv" />);
  const container = document.createElement("div");
  container.innerHTML = markup;
  expect(container.querySelector('[aria-label="Active filters"]')?.textContent).toContain("Company: Meridian · Title: Director · Availability: Newly opened");
  expect(container.querySelector('button[type="submit"]')?.textContent?.trim()).toBe("Update results");
  expect(container.querySelector('button[aria-controls="role-filter-fields"]')?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('#role-filter-fields')?.className).toContain("hidden");
  expect(container.querySelector('a[href="/?view=auto-matched#roles"]')?.textContent?.trim()).toBe("Clear filters");
});

it("clears filters without escaping a company-scoped role view", () => {
  const filters = { ...parseRolesFilters({ view: "user-shortlisted" }), company: "company-1", sinceDays: 7 };
  const markup = renderToStaticMarkup(<RolesFilterBar path="/companies/company-1" view="user-shortlisted" companyScoped
    filters={filters} companyOptions={[]} exportHref="/api/export.csv" />);
  const container = document.createElement("div");
  container.innerHTML = markup;
  expect(container.querySelector('a[href="/companies/company-1?view=user-shortlisted&company=company-1#roles"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Active filters"]')?.textContent).toContain("Decided: last 7 days");
});
