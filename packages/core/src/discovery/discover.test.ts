import { describe, expect, it } from "vitest";
import { createFakeDiscoveryContext } from "../testing";
import * as fx from "../fixtures";
import { discoverCareersSources, probeUrlAsSource } from "./discover";
import { harvestLinks, scoreLink } from "./links";
import { companyNameFromTitle, companyNamesMatch, diceCoefficient, isPlaceholderName, looksLikeSoft404, nameFromDomain, nameFromSlug } from "./text";
import { AUTO_ACCEPT_CONFIDENCE } from "./confidence";

const GH_JOBS = "https://boards-api.greenhouse.io/v1/boards/acme/jobs";
const GH_BOARD = "https://boards-api.greenhouse.io/v1/boards/acme";
const GH_IND_JOBS = "https://boards-api.greenhouse.io/v1/boards/acmeindustries/jobs";

const greenhouseRoutes = { [GH_JOBS]: { body: fx.GREENHOUSE_JOBS }, [GH_BOARD]: { body: fx.GREENHOUSE_BOARD } };
const industriesJobs = {
  jobs: [
    { id: 5001, title: "Operations Manager", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5001", location: { name: "Costa Mesa, CA" }, first_published: "2026-09-01T00:00:00Z" },
    { id: 5002, title: "Mission Operations Lead", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5002", location: { name: "London, UK" }, first_published: "2026-09-02T00:00:00Z" },
    { id: 5003, title: "Supply Chain Operations", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5003", location: { name: "Costa Mesa, CA" }, first_published: "2026-08-20T00:00:00Z" },
  ],
};

describe("discovery: an Anthropic-style careers landing page", () => {
  it("follows Careers to the listing and resolves the Greenhouse board behind it", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK },
        "https://www.acme.example/careers": { body: fx.LANDING_PAGE_HTML },
        "https://www.acme.example/careers/jobs": { body: fx.LISTING_PAGE_HTML },
        ...greenhouseRoutes,
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.companyName).toBe("Acme Robotics");
    expect(result.faviconUrl).toBe("https://www.acme.example/favicon.png");
    expect(result.best?.spec.type).toBe("greenhouse");
    expect(result.best?.spec.atsSlug).toBe("acme");
    expect(result.best?.confidence).toBeGreaterThanOrEqual(AUTO_ACCEPT_CONFIDENCE);
    expect(result.best?.method).toBe("ats_link");
    expect(result.best?.count).toBe(6);
    expect(result.best?.sample.length).toBeGreaterThan(0);
    expect(result.log.join("\n")).toContain("landing page");
  });
});

describe("discovery: an Anduril-style JavaScript shell", () => {
  it("resolves the board from the API call the page makes", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acmeind.example/": { body: fx.HOMEPAGE_WITH_OPEN_ROLES_LINK },
        "https://www.acmeind.example/open-roles": { body: fx.SHELL_PAGE_HTML },
        "https://www.acmeind.example/static/app.js": { body: "// no ats reference here" },
        [GH_IND_JOBS]: { body: industriesJobs },
        "https://boards-api.greenhouse.io/v1/boards/acmeindustries": { body: { name: "Acme Industries" } },
      },
      renders: {
        "https://www.acmeind.example/open-roles": {
          html: fx.RENDERED_SHELL_HTML,
          requests: ["https://www.acmeind.example/static/app.js", GH_IND_JOBS],
        },
      },
    });
    const result = await discoverCareersSources("https://www.acmeind.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.atsSlug).toBe("acmeindustries");
    expect(result.best?.method).toBe("ats_network");
    expect(result.best?.confidence).toBeGreaterThanOrEqual(0.97);
  });

  it("renders a client-driven careers page even when its static navigation is substantial", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK },
        "https://www.acme.example/careers": { body: fx.CLIENT_RENDERED_CAREERS_STATIC_HTML },
      },
      renders: {
        "https://www.acme.example/careers": { html: fx.CLIENT_RENDERED_CAREERS_RENDERED_HTML },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/careers");
    expect(result.best?.count).toBe(3);
    expect(result.log.join("\n")).toContain("rendered https://www.acme.example/careers");
  });

  it("falls back to the JavaScript bundle when no browser is available", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acmeind.example/": { body: fx.HOMEPAGE_WITH_OPEN_ROLES_LINK.replace("</nav>", '<script src="/static/app.js"></script></nav>') },
        "https://www.acmeind.example/open-roles": { body: fx.SHELL_PAGE_HTML },
        "https://www.acmeind.example/static/app.js": { body: fx.SHELL_BUNDLE_JS },
        [GH_IND_JOBS]: { body: industriesJobs },
        "https://boards-api.greenhouse.io/v1/boards/acmeindustries": { body: { name: "Acme Industries" } },
      },
    });
    const result = await discoverCareersSources("https://www.acmeind.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.atsSlug).toBe("acmeindustries");
    expect(["ats_bundle", "ats_script"]).toContain(result.best?.method);
  });
});

describe("discovery: other shapes", () => {
  it("does not auto-accept careers-content calls to action as job postings", async () => {
    const contentLinks = [
      ["Learn about remote working", "/careers/company-culture/remote-work"],
      ["Learn about our company culture", "/careers/company-culture"],
      ["Read our diversity statement", "/careers/company-culture/identity"],
      ["Read about career progression", "/careers/company-culture/progression"],
    ].map(([title, href]) => `<article><a href="${href}">${title} ›</a></article>`).join("");
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers/hiring-process">Hiring process</a><a href="/careers">Careers</a></body></html>' },
        "https://www.acme.example/careers/hiring-process": { body: `<main>${contentLinks}</main>` },
        "https://www.acme.example/careers": { body: '<main><a href="https://jobs.ashbyhq.com/acme/role-1">Open roles</a></main>' },
      },
      verify: { "ashby:acme": { ok: true, count: 4, sample: [], companyName: "Acme" } },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.type).toBe("ashby");
    expect(result.candidates.some(candidate => candidate.spec.url.endsWith("/careers/hiring-process"))).toBe(false);
  });

  it("interleaves independent jobs hosts before the same-origin path budget is exhausted", async () => {
    const jobs = Array.from({ length: 4 }, (_, i) => `<article><a href="/jobs/role-${i}">Role ${i}</a></article>`).join("");
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://jobs.acme.example/": { body: `<main>${jobs}</main>` },
      },
      maxFetches: 5,
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://jobs.acme.example/");
    expect(result.fetches).toBeLessThanOrEqual(5);
    expect(ctx.requestLog.some(request => request.url === "https://jobs.acme.example/")).toBe(true);
  });

  it("does not follow off-domain job URLs promoted by a first-party sitemap", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: "<html><head><title>Acme</title></head><body><p>Company homepage</p></body></html>" },
        "https://www.acme.example/robots.txt": { body: "Sitemap: https://www.acme.example/sitemap.xml" },
        "https://www.acme.example/sitemap.xml": { body: `<urlset>
          <url><loc>https://jobs.unrelated.example/jobs/one</loc></url>
          <url><loc>https://jobs.unrelated.example/jobs/two</loc></url>
          <url><loc>https://jobs.unrelated.example/jobs/three</loc></url>
        </urlset>` },
        "https://jobs.unrelated.example/jobs": { body: '<a href="https://jobs.ashbyhq.com/unrelated/role">Engineer</a>' },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("not_found");
    expect(ctx.requestLog.some(request => request.url === "https://jobs.unrelated.example/jobs")).toBe(false);
  });

  it("holds an ATS reached only through sitemap redirects for confirmation", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: "<html><head><title>Acme</title></head><body><p>Company homepage</p></body></html>" },
        "https://www.acme.example/robots.txt": { body: "Sitemap: https://www.acme.example/sitemap.xml" },
        "https://www.acme.example/sitemap.xml": { body: `<urlset>
          <url><loc>https://www.acme.example/vacancies/open/one</loc></url>
          <url><loc>https://www.acme.example/vacancies/open/two</loc></url>
          <url><loc>https://www.acme.example/vacancies/open/three</loc></url>
        </urlset>` },
        "https://www.acme.example/vacancies/open": { url: "https://recruiting.example.net/search", body: '<a href="https://jobs.ashbyhq.com/acme/role">Engineer</a>' },
      },
      verify: { "ashby:acme": { ok: true, count: 3, sample: [], companyName: "Acme" } },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.method).toBe("ats_sitemap");
    expect(result.best?.confidence).toBeLessThan(0.85);
  });

  it("resolves a first-party jobs page with an explicit zero-opening state", async () => {
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/jobs">Jobs</a></body></html>' },
      "https://www.acme.example/jobs": { body: fx.EMPTY_CAREERS_LISTING_HTML },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.method).toBe("listing_empty");
    expect(result.best?.spec.url).toBe("https://www.acme.example/jobs");
    expect(result.best?.count).toBe(0);
  });

  it("does not accept an empty-state phrase on a general company page", async () => {
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/about">About</a><p>We do not have any job openings right now.</p></body></html>' },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("not_found");
  });

  it("does not accept a filtered or department-scoped empty state", async () => {
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/jobs?department=sales">Sales jobs</a></body></html>' },
      "https://www.acme.example/jobs?department=sales": { body: '<main><div class="jobs-empty">No jobs available.</div></main>' },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).not.toBe("resolved");
  });

  it("follows an all-jobs link instead of accepting a landing page's empty message", async () => {
    const jobs = fx.LISTING_PAGE_HTML.replace(/https:\/\/job-boards\.greenhouse\.io\/acme\/jobs\//g, "https://www.acme.example/jobs/");
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers">Careers</a></body></html>' },
      "https://www.acme.example/careers": { body: '<main><div class="jobs-empty">Sorry, we don\u2019t have any job openings right now.</div><a href="/jobs">View all jobs</a></main>' },
      "https://www.acme.example/jobs": { body: jobs },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/jobs");
    expect(result.best?.count).toBeGreaterThan(0);
  });

  it("does not accept an archive message outside the posting region", async () => {
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/jobs">Jobs</a></body></html>' },
      "https://www.acme.example/jobs": { body: '<main><div class="jobs"><h1>Our teams</h1><p>Learn about life at Acme.</p></div><aside>No jobs available.</aside></main>' },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).not.toBe("resolved");
  });

  it("treats a JSON-LD careers page as a listing source", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://acmefoods.example.com/": { body: '<html><head><title>Acme Foods</title></head><body><nav><a href="/">Home</a><a href="/menu">Menu</a><a href="/about">About</a><a href="/press">Press</a><a href="/careers">Careers</a></nav></body></html>' },
        "https://acmefoods.example.com/careers": { body: fx.JSONLD_LISTING_HTML },
      },
    });
    const result = await discoverCareersSources("https://acmefoods.example.com/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.type).toBe("html");
    expect(result.best?.spec.url).toBe("https://acmefoods.example.com/careers");
    expect(result.best?.method).toBe("listing_jsonld");
    expect(result.best?.confidence).toBe(0.85);
    expect(result.best?.count).toBe(4);
  });

  it("follows a landing page through to a Lever board", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><nav><a href="/">Home</a><a href="/product">Product</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/join-us">Join us</a></nav></body></html>' },
        "https://www.acme.example/join-us": { body: '<html><body><h1>Join us</h1><p>We are hiring across the company.</p><a href="https://jobs.lever.co/acme">View openings</a></body></html>' },
        "https://api.lever.co/v0/postings/acme?mode=json": { body: fx.LEVER_POSTINGS },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.type).toBe("lever");
    expect(result.best?.spec.atsSlug).toBe("acme");
  });

  it("finds Careers through an About page when the homepage does not link to it", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme Robotics</title></head><body><nav><a href="/about">About</a><a href="/products">Products</a></nav></body></html>' },
        "https://www.acme.example/about": { body: '<html><body><h1>About Acme</h1><footer><a href="/company/people/open-roles">Open roles</a></footer></body></html>' },
        "https://www.acme.example/company/people/open-roles": { body: fx.LISTING_PAGE_HTML },
        ...greenhouseRoutes,
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.type).toBe("greenhouse");
    expect(result.log.join("\n")).toContain("careers-like link(s) on /about");
    // The listing was reached from the hub page, not from a blind path probe.
    expect(ctx.requestLog.some((r) => r.url === "https://www.acme.example/careers")).toBe(false);
  });

  it("probes well-known paths when the homepage has no careers link", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><nav><a href="/">Home</a><a href="/product">Product</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/blog">Blog</a></nav></body></html>' },
        "https://www.acme.example/careers": { status: 404, body: "nope" },
        "https://www.acme.example/careers/": { status: 404, body: "nope" },
        "https://www.acme.example/careers/jobs": { status: 404, body: "nope" },
        "https://www.acme.example/careers/open-roles": { status: 404, body: "nope" },
        "https://www.acme.example/careers/openings": { status: 404, body: "nope" },
        "https://www.acme.example/career": { status: 404, body: "nope" },
        "https://www.acme.example/jobs": { body: fx.LISTING_PAGE_HTML.replace(/job-boards\.greenhouse\.io\/acme\/jobs/g, "www.acme.example/jobs") },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/jobs");
    expect(result.best?.confidence).toBe(0.85);
    expect(result.log.join("\n")).toContain("listing");
  });

  it("prefers a complete jobs page over featured roles on the homepage", async () => {
    const jobs = (count: number, prefix: string) => Array.from({ length: count }, (_, i) =>
      `<article><h3><a href="/positions/${prefix}-${i + 1}">Role ${i + 1}</a></h3><span>London</span></article>`,
    ).join("");
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers-hub">Careers</a></body></html>' },
        "https://www.acme.example/careers-hub": { body: `<html><head><title>Acme careers</title></head><body><nav><a href="/about">About</a><a href="/jobs">All jobs</a></nav>${jobs(16, "featured")}</body></html>` },
        "https://www.acme.example/jobs": { body: `<html><head><title>Acme jobs</title></head><body>${jobs(12, "jobs")}</body></html>` },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/jobs");
    expect(result.best?.count).toBe(12);
    expect(ctx.requestLog.some(request => request.url === "https://www.acme.example/about")).toBe(false);
  });

  it("recognises an explicit positions-root link as the complete listing", async () => {
    const jobs = (count: number, prefix: string) => Array.from({ length: count }, (_, i) =>
      `<article><a href="/positions/${prefix}-${i + 1}">Role ${i + 1}</a></article>`,
    ).join("");
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers">Careers</a></body></html>' },
      "https://www.acme.example/careers": { body: `<main>${jobs(4, "featured")}<a href="/positions"><span aria-hidden="true">→</span></a></main>` },
      "https://www.acme.example/positions": { body: `<main>${jobs(8, "all")}</main>` },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/positions");
  });

  it("does not treat a filtered positions-root link as the complete listing", async () => {
    const jobs = Array.from({ length: 4 }, (_, i) => `<article><a href="/positions/featured-${i}">Role ${i}</a></article>`).join("");
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<a href="/careers">Careers</a>' },
      "https://www.acme.example/careers": { body: `<main>${jobs}<a href="/positions?office=london">London positions</a></main>` },
      "https://www.acme.example/positions?office=london": { body: jobs },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.best?.spec.url).toBe("https://www.acme.example/careers");
  });

  it("holds an ATS-backed HTML mirror for confirmation when the preferred feed cannot verify", async () => {
    const postings = Array.from({ length: 4 }, (_, i) =>
      `<article><a href="https://jobs.ashbyhq.com/acme/${i + 1}">Role ${i + 1}</a></article>`,
    ).join("");
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers">Careers</a></body></html>' },
        "https://www.acme.example/careers": { body: `<main>${postings}</main>` },
      },
      verify: { "ashby:acme": { ok: false, error: "temporarily unavailable" } },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.spec.url).toBe("https://www.acme.example/careers");
    expect(result.best?.evidence.join(" ")).toContain("posting links point to the same ashby board");
  });

  it("requires confirmation when a declared complete listing cannot be verified", async () => {
    const featured = fx.LISTING_PAGE_HTML
      .replace(/https:\/\/job-boards\.greenhouse\.io\/acme\/jobs\//g, "https://www.acme.example/jobs/")
      .replace("<main>", '<main><a href="/careers/all-jobs">View all jobs</a>');
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers-hub">Careers</a></body></html>' },
      "https://www.acme.example/careers-hub": { body: featured },
      "https://www.acme.example/careers/all-jobs": { status: 503, body: "try later" },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.spec.url).toBe("https://www.acme.example/careers-hub");
    expect(result.best?.confidence).toBe(0.5);
    expect(result.best?.evidence.join(" ")).toContain("declares a distinct complete listing");
  });

  it("follows a careers-content page's listing link instead of accepting its cards as postings", async () => {
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers">Careers</a></body></html>' },
      "https://www.acme.example/careers": { body: `<main>
        <a href="/careers/benefits">Read more about benefits</a>
        <a href="/careers/teams">View all teams</a>
        <a href="/careers/locations">Explore locations</a>
        <a href="/careers/listings">Find your role</a>
      </main>` },
      "https://www.acme.example/careers/listings": { body: fx.LISTING_PAGE_HTML.replace(/https:\/\/job-boards\.greenhouse\.io\/acme\/jobs\//g, "https://www.acme.example/positions/") },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/careers/listings");
    expect(result.best?.confidence).toBe(0.85);
  });

  it("checks a complete listing beyond the first two careers links on a landing page", async () => {
    const jobs = Array.from({ length: 4 }, (_, i) => `<article><a href="/positions/role-${i}">Role ${i}</a></article>`).join("");
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers">Careers</a></body></html>' },
      "https://www.acme.example/careers": { body: `<main>
        <a href="/careers/teams">Careers by team</a>
        <a href="/careers/locations">Careers by location</a>
        <a href="/careers/early-careers">Early careers</a>
        <a href="/all-jobs">View all jobs</a>
      </main>` },
      "https://www.acme.example/careers/teams": { body: "<main>Teams</main>" },
      "https://www.acme.example/careers/locations": { body: "<main>Locations</main>" },
      "https://www.acme.example/careers/early-careers": { body: "<main>Early careers</main>" },
      "https://www.acme.example/all-jobs": { body: `<main>${jobs}</main>` },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/all-jobs");
    expect(result.fetches).toBeLessThanOrEqual(40);
  });

  it("continues bounded path probes after finding only a weak landing page", async () => {
    const jobs = Array.from({ length: 4 }, (_, i) => `<article><a href="/jobs/role-${i}">Role ${i}</a></article>`).join("");
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/work-with-us">Work with us</a></body></html>' },
      "https://www.acme.example/work-with-us": { body: '<main><a href="/careers/culture">Careers and culture</a></main>' },
      "https://www.acme.example/careers/culture": { body: "<main>Our culture</main>" },
      "https://www.acme.example/careers": { status: 404, body: "missing" },
      "https://www.acme.example/careers/": { status: 404, body: "missing" },
      "https://www.acme.example/careers/jobs": { status: 404, body: "missing" },
      "https://www.acme.example/careers/open-roles": { status: 404, body: "missing" },
      "https://www.acme.example/careers/openings": { status: 404, body: "missing" },
      "https://www.acme.example/career": { status: 404, body: "missing" },
      "https://www.acme.example/jobs": { body: `<main>${jobs}</main>` },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/jobs");
    expect(result.candidates.some(candidate => candidate.method === "landing")).toBe(true);
    expect(result.fetches).toBeLessThanOrEqual(40);
  });

  it("does not treat an external all-jobs link as the company's complete listing", async () => {
    const featured = fx.LISTING_PAGE_HTML
      .replace(/https:\/\/job-boards\.greenhouse\.io\/acme\/jobs\//g, "https://www.acme.example/jobs/")
      .replace("<main>", '<main><a href="https://jobs.unrelated.example/jobs">View all jobs</a>');
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers-hub">Careers</a></body></html>' },
      "https://www.acme.example/careers-hub": { body: featured },
    } });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.url).toBe("https://www.acme.example/careers-hub");
    expect(ctx.requestLog.some(request => request.url.includes("unrelated.example"))).toBe(false);
  });

  it("asks for confirmation when the slug is only a guess from the domain", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: "<html><head><title>Acme</title></head><body><p>Nothing here</p><a href='/product'>Product</a><a href='/pricing'>Pricing</a><a href='/docs'>Docs</a><a href='/blog'>Blog</a><a href='/about'>About</a></body></html>" },
        ...greenhouseRoutes,
      },
      verify: { "greenhouse:acme": { ok: true, count: 6, sample: [], companyName: "Acme Robotics" } },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.method).toBe("ats_guess");
    expect(result.best?.confidence).toBe(0.7);
  });

  it("still finds the careers subdomain when the homepage is bot-protected", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { status: 403, body: "Access denied" },
        "https://www.acme.example/careers": { status: 403, body: "Access denied" },
        "https://careers.acme.example/": { body: fx.LISTING_PAGE_HTML },
        ...greenhouseRoutes,
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.type).toBe("greenhouse");
    expect(result.log.join("\n")).toContain("could not fetch the homepage");
    expect(result.log.join("\n")).toContain("probing careers paths");
  });

  it("renders a bot-protected homepage with the browser before probing", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { status: 403, body: "Access denied" },
        "https://www.acme.example/careers": { body: fx.LANDING_PAGE_HTML },
        "https://www.acme.example/careers/jobs": { body: fx.LISTING_PAGE_HTML },
        ...greenhouseRoutes,
      },
      renders: { "https://www.acme.example/": { html: fx.HOMEPAGE_WITH_CAREERS_LINK, requests: [] } },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.log.join("\n")).toContain("rendering with the browser");
    expect(result.companyName).toBe("Acme Robotics");
  });

  it("falls back to an ATS slug guess when the whole site is bot-protected", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { status: 403, body: "Access denied" },
        ...greenhouseRoutes,
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.best?.method).toBe("ats_guess");
    expect(result.outcome).toBe("needs_confirmation");
  });

  it("reports not_found and explains itself when there is nothing to find", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.nothing.example/": { body: "<html><head><title>Nothing Ltd</title></head><body><a href='/a'>A</a><a href='/b'>B</a><a href='/c'>C</a><a href='/d'>D</a><a href='/e'>E</a></body></html>" },
      },
    });
    const result = await discoverCareersSources("https://www.nothing.example/", ctx);
    expect(result.outcome).toBe("not_found");
    expect(result.candidates).toEqual([]);
    expect(result.log.join("\n")).toContain("no careers source found");
  });

  it("stops when the fetch budget is spent", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: { "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK } },
      maxFetches: 2,
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.fetches).toBeLessThanOrEqual(2);
    expect(result.log.join("\n")).toContain("fetch budget");
  });

  it("penalises a verified board whose company name does not match the site", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK },
        "https://www.acme.example/careers": { body: '<html><body><a href="https://boards.greenhouse.io/acme">Open roles</a></body></html>' },
        ...greenhouseRoutes,
      },
      verify: { "greenhouse:acme": { ok: true, count: 4, sample: [], companyName: "Zebra Logistics" } },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.best?.companyName).toBe("Zebra Logistics");
    // 0.95 base for ats_link, +0.02 for a second corroborating method, -0.15 for the name mismatch.
    expect(result.best?.confidence).toBeCloseTo(0.82, 2);
    expect(result.outcome).toBe("needs_confirmation");
  });
});

describe("probeUrlAsSource", () => {
  it("accepts a pasted board URL directly", async () => {
    const ctx = createFakeDiscoveryContext({ routes: greenhouseRoutes });
    const result = await probeUrlAsSource("https://boards.greenhouse.io/acme", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.method).toBe("pasted_ats");
    expect(result.best?.count).toBe(6);
  });

  it("names the company from the feed when the board reports one", async () => {
    const ctx = createFakeDiscoveryContext({ routes: greenhouseRoutes });
    const result = await probeUrlAsSource("https://boards.greenhouse.io/acme", ctx);
    expect(result.companyName).toBe("Acme Robotics");
  });

  it("names the company from the board slug when the feed carries no name", async () => {
    // Ashby's feed has no organisation name; hims.com was left called "hims.com" for weeks.
    const ctx = createFakeDiscoveryContext({ routes: {}, verify: { "ashby:hims-and-hers": { ok: true, count: 117, sample: [] } } });
    const result = await probeUrlAsSource("https://jobs.ashbyhq.com/hims-and-hers", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.method).toBe("pasted_ats");
    expect(result.companyName).toBe("Hims and Hers");
  });

  it("accepts a pasted listing page", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: { "https://www.acme.example/careers/jobs": { body: fx.LISTING_PAGE_HTML.replace(/job-boards\.greenhouse\.io\/acme\/jobs/g, "www.acme.example/jobs") } },
    });
    const result = await probeUrlAsSource("https://www.acme.example/careers/jobs", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.type).toBe("html");
    expect(result.best?.method).toBe("pasted_listing");
  });
});

describe("link scoring and page metadata", () => {
  const pageUrl = "https://www.acme.example/";
  const link = (href: string, text: string) => ({ href, text, kind: "a" });

  it("ranks an ATS link above careers text above a path match above noise", () => {
    const ats = scoreLink(link("https://boards.greenhouse.io/acme", "Openings"), pageUrl);
    const text = scoreLink(link("https://www.acme.example/x", "Careers"), pageUrl);
    const path = scoreLink(link("https://www.acme.example/careers", "Company"), pageUrl);
    const blog = scoreLink(link("https://www.acme.example/blog", "Blog"), pageUrl);
    expect(ats).toBe(1);
    expect(text).toBeGreaterThan(path);
    expect(path).toBeGreaterThan(blog);
    expect(blog).toBe(0);
  });

  it("scores non-English careers wording", () => {
    expect(scoreLink(link("https://www.acme.example/de/karriere", "Karriere"), pageUrl)).toBeGreaterThan(0.5);
  });

  it("harvests anchors, scripts, iframes and meta URLs", () => {
    const links = harvestLinks(fx.EMBEDDED_GREENHOUSE_HTML, "https://www.acme.example/careers");
    expect(links.some((l) => l.kind === "script" && l.href.includes("greenhouse"))).toBe(true);
  });

  it("extracts a company name from assorted title formats", () => {
    expect(companyNameFromTitle("Acme Robotics | Building the future", "acme.example")).toBe("Acme Robotics");
    expect(companyNameFromTitle("Careers – Acme Robotics", "acme.example")).toBe("Careers");
    expect(companyNameFromTitle(undefined, "acme.example")).toBe("Acme");
    expect(companyNameFromTitle("Home", "acme.example")).toBe("Acme");
  });

  it("derives placeholder names and recognises them", () => {
    expect(nameFromDomain("hims.com")).toBe("Hims");
    expect(nameFromDomain("www.acme.co.uk")).toBe("Acme");
    expect(nameFromSlug("hims-and-hers")).toBe("Hims and Hers");
    expect(nameFromSlug("acme_robotics")).toBe("Acme Robotics");
    expect(nameFromSlug("12345")).toBeUndefined();
    expect(isPlaceholderName("hims.com", "hims.com")).toBe(true);
    expect(isPlaceholderName("Hims", "hims.com")).toBe(true);
    expect(isPlaceholderName("", "hims.com")).toBe(true);
    expect(isPlaceholderName(null, "hims.com")).toBe(true);
    expect(isPlaceholderName("Hims & Hers Health", "hims.com")).toBe(false);
  });

  it("compares company names tolerantly", () => {
    expect(companyNamesMatch("Acme Robotics Ltd", "Acme Robotics")).toBe(true);
    expect(companyNamesMatch("Acme", "Acme Robotics")).toBe(true);
    expect(companyNamesMatch("Acme Robotics", "Zebra Logistics")).toBe(false);
    expect(companyNamesMatch(undefined, "Anything")).toBe(true);
    expect(diceCoefficient("night", "nacht")).toBeLessThan(0.5);
  });

  it("detects soft 404 pages", () => {
    expect(looksLikeSoft404("<html><head><title>Page not found</title></head><body></body></html>")).toBe(true);
    expect(looksLikeSoft404(fx.LISTING_PAGE_HTML)).toBe(false);
  });
});

describe("discovery: the model as a fallback", () => {
  it("follows a link the model picks when nothing on the page looks like careers", async () => {
    const calls: string[] = [];
    const ctx = createFakeDiscoveryContext({
      routes: {
        // Nothing here reads as a careers link: the wording is idiosyncratic and the path is opaque.
        "https://www.acme.example/": {
          body: `<html><head><title>Acme</title></head><body><nav>
            <a href="/p/1">Product</a><a href="/p/2">Platform</a><a href="/p/3">Company</a>
            <a href="/p/4">Grow with us</a><a href="/p/5">Contact</a></nav></body></html>`,
        },
        "https://www.acme.example/p/4": { body: fx.LISTING_PAGE_HTML },
        ...greenhouseRoutes,
      },
      ai: {
        chooseCareersLinks: async (input) => {
          calls.push("chooseCareersLinks");
          expect(input.companyName).toBe("Acme");
          expect(input.links.length).toBeGreaterThan(0);
          return [{ url: "https://www.acme.example/p/4", confidence: 0.7, reason: "\"Grow with us\" is careers wording" }];
        },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(calls).toEqual(["chooseCareersLinks"]);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.atsSlug).toBe("acme");
  });

  it("accepts a page the model classifies as a listing when the heuristics cannot tell", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": {
          body: `<html><head><title>Acme</title></head><body><nav><a href="/">Home</a><a href="/product">Product</a>
            <a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/careers">Careers</a></nav></body></html>`,
        },
        // Two roles only: below the three-posting bar the heuristics use, so the model decides.
        "https://www.acme.example/careers": {
          body: `<html><head><title>Careers</title></head><body><h1>Open roles</h1>
            <a href="/careers/ops-lead">Operations Lead</a><a href="/careers/engineer">Engineer</a></body></html>`,
        },
      },
      ai: {
        classifyPage: async (input) => {
          expect(input.url).toBe("https://www.acme.example/careers");
          expect(input.text).toContain("Open roles");
          return { kind: "listing", confidence: 0.9 };
        },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.best?.method).toBe("ai_listing");
    expect(result.best?.confidence).toBe(0.75);
    expect(result.outcome).toBe("needs_confirmation");
  });

  it("carries on when the model call fails", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: "<html><head><title>Acme</title></head><body><a href='/a'>A</a><a href='/b'>B</a><a href='/c'>C</a><a href='/d'>D</a><a href='/e'>E</a></body></html>" },
      },
      ai: {
        chooseCareersLinks: async () => {
          throw new Error("model unavailable");
        },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("not_found");
    expect(result.log.join("\n")).toContain("model link suggestion failed");
  });
});
