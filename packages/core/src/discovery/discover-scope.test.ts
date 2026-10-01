import { describe, expect, it, vi } from "vitest";
import { createFakeDiscoveryContext } from "../testing";
import { EMPTY_CAREERS_LISTING_HTML, LISTING_PAGE_HTML } from "../fixtures";
import { discoverCareersSources, hasEmptyJobsMount, isJsShell } from "./discover";
import { AUTO_ACCEPT_CONFIDENCE } from "./confidence";

const HOME = "https://www.acme.example/";
const CAREERS = "https://www.acme.example/careers";
const homepage = '<html><head><title>Acme Robotics</title></head><body><nav><a href="/careers">Careers</a></nav></body></html>';
const localRoles = LISTING_PAGE_HTML.replaceAll("https://job-boards.greenhouse.io/acme/jobs/", "https://www.acme.example/jobs/");

function throughCareers(href: string, listing = localRoles) {
  const target = new URL(href, CAREERS).toString();
  return { target, ctx: createFakeDiscoveryContext({ routes: {
    [HOME]: { body: homepage },
    [CAREERS]: { body: `<main><h1>Careers</h1><p>Find a role with Acme.</p><a href="${href}">View all jobs</a></main>` },
    [target]: { body: listing },
  } }) };
}

describe("held-out full-listing scope and provenance", () => {
  const mountedSearch = (heading: string, rootId: string) => `<html><body><main>
    <h2>${heading}</h2><p>${"Explore opportunities with our teams and learn about the work we do. ".repeat(12)}</p>
    <nav><a href="/about">About</a><a href="/culture">Culture</a><a href="/benefits">Benefits</a>
      <a href="/teams">Teams</a><a href="/locations">Locations</a><a href="/news">News</a></nav>
    <div id="${rootId}" class="ais-InstantSearch"><div id="searchbox"></div>
      <div id="hits"></div><div id="pagination"></div></div></main></body></html>`;

  it("renders a content-rich first-party job-search mount reached through an explicit complete-listing link", async () => {
    const target = "https://www.acme.example/careers/all-jobs";
    const staticHtml = mountedSearch("Job Openings", "job-openings");
    expect(isJsShell(staticHtml)).toBe(false);
    expect(hasEmptyJobsMount(staticHtml)).toBe(false);
    const ctx = createFakeDiscoveryContext({ routes: {
      [HOME]: { body: homepage },
      [CAREERS]: { body: '<main><a href="/careers/all-jobs">View all jobs</a></main>' },
      [target]: { body: staticHtml },
    }, renders: { [target]: { html: localRoles } } });
    const render = vi.fn(ctx.render!);
    const result = await discoverCareersSources(HOME, { ...ctx, render });
    expect(render.mock.calls.filter(([url]) => url === target)).toHaveLength(1);
    expect(render).toHaveBeenCalledWith(target, expect.objectContaining({ scrollAndExpand: false, allowHost: expect.any(Function) }));
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe(target);
    expect(result.best?.count).toBeGreaterThanOrEqual(3);
  });

  it("keeps a still-empty mounted job search for confirmation after its one render", async () => {
    const target = "https://www.acme.example/careers/all-jobs";
    const staticHtml = mountedSearch("Job Openings", "job-openings");
    const ctx = createFakeDiscoveryContext({ routes: {
      [HOME]: { body: homepage },
      [CAREERS]: { body: '<main><a href="/careers/all-jobs">View all jobs</a></main>' },
      [target]: { body: staticHtml },
    }, renders: { [target]: { html: staticHtml } } });
    const render = vi.fn(ctx.render!);
    const result = await discoverCareersSources(HOME, { ...ctx, render });
    expect(render.mock.calls.filter(([url]) => url === target)).toHaveLength(1);
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.spec.url).toBe(target);
    expect(result.best?.confidence).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
  });

  it("does not render a generic product search or a filtered job-search URL", async () => {
    const target = "https://www.acme.example/careers/all-jobs";
    const filtered = `${target}?office=London`;
    for (const [href, body] of [
      [target, mountedSearch("Product Search", "product-search")],
      [filtered, mountedSearch("Job Openings", "job-openings")],
    ] as const) {
      const ctx = createFakeDiscoveryContext({ routes: {
        [HOME]: { body: homepage },
        [CAREERS]: { body: `<main><a href="${href}">View all jobs</a></main>` },
        [href]: { body },
      }, renders: { [href]: { html: localRoles } } });
      const render = vi.fn(ctx.render!);
      const result = await discoverCareersSources(HOME, { ...ctx, render });
      expect(render.mock.calls.filter(([url]) => url === href), href).toHaveLength(0);
      expect(result.outcome, href).not.toBe("resolved");
    }
  });

  it.each([
    ["office filter", "/careers/all-jobs?office=london"],
    ["broad category filter", "/careers/all-jobs?bc=engineering"],
    ["unknown filter", "/careers/all-jobs?team=platform"],
    ["later pagination page", "/careers/all-jobs?page=2"],
  ])("holds an explicit all-jobs link with a %s for confirmation", async (_label, href) => {
    const { target, ctx } = throughCareers(href);
    const result = await discoverCareersSources(HOME, ctx);
    expect(result.outcome).not.toBe("resolved");
    const scoped = result.candidates.find(candidate => candidate.spec.url === target);
    if (scoped) expect(scoped.confidence).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
  });

  it.each([
    ["tracking", "/careers/all-jobs?utm_source=homepage"],
    ["locale", "/careers/all-jobs?locale=en-GB"],
    ["first pagination page", "/careers/all-jobs?page=1"],
  ])("accepts a verified complete listing with benign %s parameters", async (_label, href) => {
    const { target, ctx } = throughCareers(href);
    const result = await discoverCareersSources(HOME, ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe(target);
    expect(result.best?.count).toBeGreaterThanOrEqual(3);
  });

  it("follows two consecutive first-party complete-listing links to the actual roles", async () => {
    const search = "https://www.acme.example/careers/search";
    const all = "https://www.acme.example/careers/search/all-jobs";
    const ctx = createFakeDiscoveryContext({ routes: {
      [HOME]: { body: homepage },
      [CAREERS]: { body: '<main><a href="/careers/search">View all jobs</a></main>' },
      [search]: { body: '<main><h1>Search careers</h1><a href="/careers/search/all-jobs">See all jobs</a></main>' },
      [all]: { body: localRoles },
    } });
    const result = await discoverCareersSources(HOME, ctx);
    expect(ctx.requestLog.map(request => request.url)).toContain(all);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe(all);
  });

  it("bounds a cyclic branch even when each page says it links to all jobs", async () => {
    const a = "https://www.acme.example/careers/a";
    const b = "https://www.acme.example/careers/b";
    const ctx = createFakeDiscoveryContext({ maxFetches: 12, routes: {
      [HOME]: { body: homepage },
      [CAREERS]: { body: '<main><a href="/careers/a">View all jobs</a><a href="/careers/b">See all jobs</a></main>' },
      [a]: { body: '<main><a href="/careers/b">View all jobs</a></main>' },
      [b]: { body: '<main><a href="/careers/a">View all jobs</a></main>' },
    } });
    const result = await discoverCareersSources(HOME, ctx);
    expect(result.outcome).not.toBe("resolved");
    expect(result.fetches).toBeLessThanOrEqual(12);
    expect(ctx.requestLog.filter(request => request.url === a)).toHaveLength(1);
    expect(ctx.requestLog.filter(request => request.url === b)).toHaveLength(1);
  });

  it("renders a rich jobs-loading page but keeps it for confirmation when no roles mount", async () => {
    const loading = `<html><body><main><h1>Find jobs at Acme</h1><p>${"Build useful products with our teams. ".repeat(15)}</p>
      <nav><a href="/about">About</a><a href="/teams">Teams</a><a href="/culture">Culture</a><a href="/benefits">Benefits</a><a href="/news">News</a></nav>
      <div id="jobs-root" class="jobs-container"></div></main></body></html>`;
    const ctx = createFakeDiscoveryContext({ routes: { [HOME]: { body: homepage }, [CAREERS]: { body: loading } },
      renders: { [CAREERS]: { html: loading.replace('class="jobs-container"', 'class="jobs-container loaded"') } } });
    const render = vi.fn(ctx.render!);
    const result = await discoverCareersSources(HOME, { ...ctx, render });
    expect(render).toHaveBeenCalled();
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.spec.url).toBe(CAREERS);
    expect(result.best?.confidence).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
  });

  it("prefers a deeper listing over featured roles and does not certify the teaser alone", async () => {
    const all = "https://www.acme.example/careers/all-jobs";
    const featured = localRoles.replace("</main>", '<a href="/careers/all-jobs">View all jobs</a></main>');
    const ctx = createFakeDiscoveryContext({ routes: {
      [HOME]: { body: homepage }, [CAREERS]: { body: featured }, [all]: { body: localRoles },
    } });
    const result = await discoverCareersSources(HOME, ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe(all);
    expect(result.candidates.find(candidate => candidate.spec.url === CAREERS)?.confidence).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);

    const broken = createFakeDiscoveryContext({ routes: { [HOME]: { body: homepage }, [CAREERS]: { body: featured } } });
    const shortResult = await discoverCareersSources(HOME, broken);
    expect(shortResult.outcome).not.toBe("resolved");
    expect(shortResult.best?.confidence).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
  });

  it("does not give first-party trust to an off-domain careers probe redirect", async () => {
    const external = "https://jobs.unrelated.example/jobs";
    const ctx = createFakeDiscoveryContext({ routes: {
      [HOME]: { body: '<html><head><title>Acme Robotics</title></head><body><p>Acme products</p></body></html>' },
      [CAREERS]: { url: external, body: localRoles.replaceAll("www.acme.example", "jobs.unrelated.example") },
    } });
    const result = await discoverCareersSources(HOME, ctx);
    expect(ctx.requestLog.some(request => request.url === CAREERS)).toBe(true);
    expect(result.outcome).not.toBe("resolved");
    const redirected = result.candidates.find(candidate => candidate.spec.url === external);
    if (redirected) expect(redirected.confidence).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
  });

  it("does not accept an empty listing while a visible office filter is selected", async () => {
    const empty = EMPTY_CAREERS_LISTING_HTML;
    const filtered = empty.replace('<div class="jobs">',
      '<div class="job-filter"><label>Office<select name="office"><option value="all">All offices</option><option value="London" selected>London</option></select></label></div><div class="jobs">');
    const route = (body: string) => createFakeDiscoveryContext({ routes: {
      [HOME]: { body: homepage }, [CAREERS]: { body },
    } });
    const unfiltered = await discoverCareersSources(HOME, route(empty));
    expect(unfiltered.outcome).toBe("resolved");
    expect(unfiltered.best?.method).toBe("listing_empty");

    const scoped = await discoverCareersSources(HOME, route(filtered));
    expect(scoped.outcome).not.toBe("resolved");
    const candidate = scoped.candidates.find(item => item.spec.url === CAREERS);
    if (candidate) expect(candidate.confidence).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
  });

  it("keeps crawling past a verified board whose named company contradicts the homepage", async () => {
    const ctx = createFakeDiscoveryContext({ routes: {
      [HOME]: { body: '<html><head><title>Acme Robotics</title></head><body><a href="https://boards.greenhouse.io/zebra">Jobs</a><a href="/careers">Careers</a></body></html>' },
      [CAREERS]: { body: localRoles },
    }, verify: { "greenhouse:zebra": { ok: true, count: 20, sample: [], companyName: "Zebra Logistics" } } });
    const result = await discoverCareersSources(HOME, ctx);
    expect(ctx.requestLog.map(request => request.url)).toContain(CAREERS);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe(CAREERS);
    expect(result.candidates.find(candidate => candidate.spec.atsSlug === "zebra")?.confidence).toBeLessThan(AUTO_ACCEPT_CONFIDENCE);
  });

  it("does not treat two equivalent links found by one method as corroborating methods", async () => {
    const board = '<a href="https://boards.greenhouse.io/acme">Open jobs</a>';
    const alias = '<a href="https://job-boards.greenhouse.io/acme">View jobs</a>';
    const run = async (links: string) => {
      const ctx = createFakeDiscoveryContext({ routes: {
        [HOME]: { body: `<html><head><title>Acme Robotics</title></head><body>${links}</body></html>` },
      }, verify: { "greenhouse:acme": { ok: true, count: 12, sample: [], companyName: "Acme Robotics" } } });
      return discoverCareersSources(HOME, { ...ctx, findSpecsInText: () => [] });
    };
    const one = await run(board);
    const repeated = await run(board + alias);
    expect(one.best?.spec.atsSlug).toBe("acme");
    expect(repeated.best?.spec.atsSlug).toBe("acme");
    expect(repeated.best?.confidence).toBe(one.best?.confidence);
  });
});
