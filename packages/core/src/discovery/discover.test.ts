import { describe, expect, it } from "vitest";
import { createFakeDiscoveryContext } from "../testing";
import * as fx from "../fixtures";
import { discoverCareersSources, probeUrlAsSource } from "./discover";
import { harvestLinks, scoreLink } from "./links";
import { companyNameFromTitle, companyNamesMatch, diceCoefficient, looksLikeSoft404 } from "./text";
import { AUTO_ACCEPT_CONFIDENCE } from "./confidence";

const GH_JOBS = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true";
const GH_BOARD = "https://boards-api.greenhouse.io/v1/boards/acme";
const GH_IND_JOBS = "https://boards-api.greenhouse.io/v1/boards/acmeindustries/jobs?content=true";

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
