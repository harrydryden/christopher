import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  listPipeline: vi.fn(),
  pipelineCompany: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "member-one" }) }));
vi.mock("@/lib/work-status", () => ({ getCvWorkStatus: async () => ({ version: 0, improving: [] }) }));
vi.mock("@/lib/queries/applications", () => ({
  listPipeline: fakes.listPipeline,
  pipelineCompany: fakes.pipelineCompany,
  pipelineFilter: (value?: string) => value === "closed" || value === "all" ? value : "active",
  pipelineStaleHint: () => null,
  applicationStaleHint: () => null,
  PIPELINE_FILTERS: ["active", "closed", "all"],
  PIPELINE_FILTER_LABELS: { active: "Active", closed: "Closed", all: "All" },
}));
vi.mock("@/components/ApplicationsTable", () => ({ ApplicationsTable: ({ emptyState }: { emptyState: React.ReactNode }) => emptyState }));

import ApplicationsPage from "./page";

const emptyPage = {
  rows: [], page: 1, pageCount: 1, total: 0,
  counts: { active: 0, closed: 0, all: 0 },
  stages: { matched: 0, shortlisted: 0, applying: 0, applied: 0, in_process: 0, accepted: 0, rejected: 0, dismissed: 0 },
  due: 2, overdue: 1,
};
beforeEach(() => { vi.clearAllMocks(); fakes.listPipeline.mockResolvedValue(emptyPage); fakes.pipelineCompany.mockResolvedValue(null); });

it("loads the pipeline once and gives an empty first visit a direct route to roles", async () => {
  const html = renderToStaticMarkup(await ApplicationsPage({ searchParams: Promise.resolve({}) }));
  expect(fakes.listPipeline).toHaveBeenCalledTimes(1);
  expect(html).toContain('aria-label="Application filters"');
  expect(html).toContain('href="/applications/new"');
  expect(html).not.toContain('id="new-application-heading"');
  expect(html).toContain('aria-label="Progress"');
  expect(html).toContain('aria-label="Next steps"');
  expect(html).toContain('aria-label="Application stages"');
  expect(html).toContain('href="/applications?filter=active&amp;focus=due"');
  expect(html.match(/<a\b[^>]*href="\/applications\?filter=active&amp;focus=due"[^>]*>/)?.[0]).toContain(" underline ");
  expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Find roles<\/a>/);
  expect(html).not.toContain("Needs action ·");
});

it("preserves company scope and separate stage and due filters in shareable links", async () => {
  const company = { id: "8896e9d9-59e9-4690-a851-095e20dbb63a", name: "Example Works" };
  fakes.pipelineCompany.mockResolvedValue(company);
  const html = renderToStaticMarkup(await ApplicationsPage({ searchParams: Promise.resolve({
    filter: "all", company: company.id, stage: "applied", focus: "due",
  }) }));
  expect(fakes.listPipeline).toHaveBeenCalledTimes(1);
  expect(fakes.listPipeline).toHaveBeenCalledWith("member-one", expect.objectContaining({
    filter: "all", company, stage: "applied", focus: "due",
  }));
  expect(html).toContain(`href="/applications?filter=active&amp;focus=due&amp;company=${company.id}"`);
  expect(html).toContain(`href="/applications?filter=all&amp;stage=applied&amp;company=${company.id}"`);
  expect(html).toContain(`href="/applications?filter=all&amp;company=${company.id}"`);
  expect(html).toContain("View applications");
  expect(html).toContain("No applied steps due this week");
  const links = [...html.matchAll(/<a\b[^>]*>/g)].map(match => match[0]);
  expect(links.find(link => link.includes(`focus=due&amp;company=${company.id}`))).toContain('aria-current="page"');
  expect(links.find(link => link.includes(`stage=applied&amp;company=${company.id}`))).toContain('aria-current="page"');
});
