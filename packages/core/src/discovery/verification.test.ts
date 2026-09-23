import { describe, expect, it, vi } from "vitest";
import { createFakeDiscoveryContext } from "../testing";
import * as fx from "../fixtures";
import type { FetchInit } from "../types";
import { _DiscoveryRunForTests, discoverCareersSources, probeUrlAsSource } from "./discover";
import { WELL_KNOWN_PATHS } from "./links";

const GH_JOBS = "https://boards-api.greenhouse.io/v1/boards/acme/jobs";
const GH_BOARD = "https://boards-api.greenhouse.io/v1/boards/acme";
const GH_IND_JOBS = "https://boards-api.greenhouse.io/v1/boards/acmeindustries/jobs";
const greenhouseRoutes = { [GH_JOBS]: { body: fx.GREENHOUSE_JOBS }, [GH_BOARD]: { body: fx.GREENHOUSE_BOARD } };
const industriesJobs = {
  jobs: [1, 2, 3].map((i) => ({ id: 5000 + i, title: `Operations Role ${i}`, absolute_url: `https://job-boards.greenhouse.io/acmeindustries/jobs/${5000 + i}`, location: { name: "London, UK" } })),
};
const listing = (count: number, prefix = "/jobs") =>
  `<main>${Array.from({ length: count }, (_, i) => `<article><a href="${prefix}/role-${i}">Operations Role ${i}</a><span>London</span></article>`).join("")}</main>`;

describe("verification has its own allowance", () => {
  it("still verifies a board the crawl found after its time budget ran out", async () => {
    let clock = 0;
    const ctx = createFakeDiscoveryContext({
      now: () => new Date(clock),
      routes: {
        "https://www.acmeind.example/": { body: fx.HOMEPAGE_WITH_OPEN_ROLES_LINK },
        "https://www.acmeind.example/open-roles": { body: fx.SHELL_PAGE_HTML },
        [GH_IND_JOBS]: { body: industriesJobs },
        "https://boards-api.greenhouse.io/v1/boards/acmeindustries": { body: { name: "Acme Industries" } },
      },
      renders: { "https://www.acmeind.example/open-roles": { html: fx.SHELL_PAGE_HTML, requests: [GH_IND_JOBS] } },
    });
    const render = ctx.render!;
    // A slow render behind a busy browser: the crawl's two minutes are gone when it returns.
    ctx.render = async (url, opts) => {
      if (url.endsWith("/open-roles")) clock += 150_000;
      return render(url, opts);
    };
    const result = await discoverCareersSources("https://www.acmeind.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.method).toBe("ats_network");
    expect(result.best?.spec.atsSlug).toBe("acmeindustries");
    expect(result.log.join("\n")).not.toContain("fetch budget exhausted");
  });

  it("verifies a board found on the crawl's last allowed fetch", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK },
        "https://www.acme.example/careers": { body: '<main><a href="https://jobs.lever.co/acme">Open roles</a></main>' },
        "https://api.lever.co/v0/postings/acme?mode=json": { body: fx.LEVER_POSTINGS },
      },
      maxFetches: 2,
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.fetches).toBe(2);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec).toMatchObject({ type: "lever", atsSlug: "acme" });
    expect(result.verifications).toBe(1);
  });

  it("verifies at most its allowance of boards", async () => {
    const boards = Array.from({ length: 15 }, (_, i) => `<a href="https://jobs.lever.co/stale-${i}">Careers ${i}</a>`).join("");
    const ctx = createFakeDiscoveryContext({ routes: { "https://www.acme.example/": { body: `<html><head><title>Acme</title></head><body>${boards}</body></html>` } } });
    const verifySpec = vi.spyOn(ctx, "verifySpec");
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.verifications).toBe(10);
    expect(verifySpec).toHaveBeenCalledTimes(10);
    expect(result.log.join("\n")).toContain("verification budget of 10 spent");
  });
});

describe("an ATS reference that does not verify never stops the crawl", () => {
  it("finds the company's own listing behind a stale board link", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="https://jobs.lever.co/acme-old">Careers</a></body></html>' },
        "https://api.lever.co/v0/postings/acme-old?mode=json": { status: 404, body: "not found" },
        "https://www.acme.example/careers": { body: listing(4) },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec).toEqual({ type: "html", url: "https://www.acme.example/careers" });
    expect(result.log.join("\n")).toContain("dropped lever/acme-old");
  });

  it("follows a grnh.se short link to the board it redirects to", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme Robotics</title></head><body><a href="https://grnh.se/abc123us">Jobs</a></body></html>' },
        "https://grnh.se/abc123us": { url: "https://job-boards.greenhouse.io/acme/jobs/4001001", body: "<main><h1>Operations Manager</h1></main>" },
        ...greenhouseRoutes,
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec).toMatchObject({ type: "greenhouse", atsSlug: "acme" });
    expect(result.candidates.some((candidate) => candidate.spec.atsSlug === "abc123us")).toBe(false);
  });
});

describe("a verified board must be the company's", () => {
  const site = (board: string) => createFakeDiscoveryContext({
    routes: {
      "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK },
      "https://www.acme.example/careers": { body: `<main><a href="https://jobs.lever.co/${board}">Open roles</a></main>` },
      [`https://api.lever.co/v0/postings/${board}?mode=json`]: { body: fx.LEVER_POSTINGS },
    },
  });

  it("holds a board that names no company and matches neither name nor domain for confirmation", async () => {
    // A footer link to a partner's board verifies, and Lever's feed names no company at all.
    const result = await discoverCareersSources("https://www.acme.example/", site("othercorp"));
    expect(result.best?.spec.atsSlug).toBe("othercorp");
    expect(result.best?.confidence).toBeLessThan(0.85);
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.evidence.join(" ")).toContain("does not match the company's name or domain");
  });

  it("accepts a board whose slug is the company's", async () => {
    const result = await discoverCareersSources("https://www.acme.example/", site("acmerobotics"));
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.atsSlug).toBe("acmerobotics");
  });
});

describe("transient verification failures", () => {
  it("asks for a retry when the only good board could not be verified for now", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK },
        "https://www.acme.example/careers": { body: '<main><a href="https://boards.greenhouse.io/acme">Open roles</a></main>' },
        [GH_JOBS]: { status: 503, body: "unavailable" },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    // The page that linked to the board is all that is left, and it is only a landing page.
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.method).toBe("landing");
    expect(result.retry).toContain("greenhouse/acme");
    expect(result.retry).toContain("503");
  });

  it("records a board that is gone as final", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK },
        "https://www.acme.example/careers": { body: '<main><a href="https://boards.greenhouse.io/acme">Open roles</a></main>' },
        [GH_JOBS]: { status: 404, body: "gone" },
      },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.retry).toBeUndefined();
  });

  it("never treats a pasted board that failed as the vendor's homepage", async () => {
    const ctx = createFakeDiscoveryContext({ routes: { "https://api.lever.co/v0/postings/acme?mode=json": { status: 503, body: "unavailable" } } });
    const result = await probeUrlAsSource("https://jobs.lever.co/acme", ctx);
    expect(result.outcome).toBe("not_found");
    expect(result.candidates).toEqual([]);
    expect(result.retry).toContain("lever/acme");
    // Nothing on Lever's own site was crawled, and no guess at Lever's own board was offered.
    expect(ctx.requestLog.map((r) => r.url)).toEqual(["https://api.lever.co/v0/postings/acme?mode=json"]);
  });
});

describe("discovery cost caps", () => {
  it("inspects a page once however many pages link to it", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/work-with-us">Work with us</a><a href="/join-us">Join us</a></body></html>' },
        "https://www.acme.example/work-with-us": { body: '<main><a href="/careers/culture">Careers and culture</a></main>' },
        "https://www.acme.example/join-us": { body: '<main><a href="/careers/culture">Careers and culture</a></main>' },
        "https://www.acme.example/careers/culture": { body: "<main>Our culture</main>" },
      },
    });
    await discoverCareersSources("https://www.acme.example/", ctx);
    expect(ctx.requestLog.filter((r) => r.url === "https://www.acme.example/careers/culture")).toHaveLength(1);
  });

  it("classifies at most six pages with the model", async () => {
    const pages = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`https://www.acme.example/careers-${i}`, { body: `<main><p>Careers page ${i}</p></main>` }]));
    const classifyPage = vi.fn(async () => ({ kind: "other" as const, confidence: 0.2 }));
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: `<html><head><title>Acme</title></head><body>${Array.from({ length: 6 }, (_, i) => `<a href="/careers-${i}">Careers ${i}</a>`).join("")}</body></html>` },
        ...pages,
        "https://www.acme.example/careers": { body: "<main><p>Careers</p></main>" },
        "https://www.acme.example/jobs": { body: "<main><p>Jobs</p></main>" },
      },
      ai: { classifyPage },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(classifyPage).toHaveBeenCalledTimes(6);
    expect(result.log.join("\n")).toContain("model classification budget of 6 spent");
  });

  it("inspects, renders and classifies a catch-all shell once and stops probing it", async () => {
    const shell = '<html><head><title>Acme</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
    const ctx = createFakeDiscoveryContext({ routes: {}, renders: {} });
    const requested: string[] = [];
    ctx.fetchText = async (url) => {
      requested.push(url);
      const body = url === "https://www.acme.example/" ? fx.HOMEPAGE_WITH_CAREERS_LINK.replace(/\/careers/g, "/life") : shell;
      return { status: 200, url, headers: {}, body };
    };
    const home = fx.HOMEPAGE_WITH_CAREERS_LINK.replace(/\/careers/g, "/life");
    const render = vi.fn(async (url: string) => ({ html: url === "https://www.acme.example/" ? home : shell, finalUrl: url, requests: [], status: 200 }));
    ctx.render = render;
    const classifyPage = vi.fn(async () => ({ kind: "other" as const, confidence: 0.1 }));
    ctx.ai = { classifyPage };
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    // The first shell is read, rendered and classified; every path after it serves the same bytes.
    expect(classifyPage).toHaveBeenCalledTimes(1);
    expect(render.mock.calls.map((call) => call[0])).toEqual(["https://www.acme.example/", "https://www.acme.example/life"]);
    expect(result.log.join("\n")).toContain("8 probes in a row found nothing");
    // `/life` was read as the homepage's careers link, not as a probe.
    const probes = requested.filter((url) => /^https:\/\/(careers|jobs|join)\./.test(url) || WELL_KNOWN_PATHS.some((path) => path !== "/life" && url === `https://www.acme.example${path}`));
    expect(probes).toHaveLength(8);
  });

  it("stops blind path probes after eight 404s in a row", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: { "https://www.nothing.example/": { body: "<html><head><title>Nothing</title></head><body><a href='/a'>A</a><a href='/b'>B</a><a href='/c'>C</a><a href='/d'>D</a><a href='/e'>E</a></body></html>" } },
    });
    const result = await discoverCareersSources("https://www.nothing.example/", ctx);
    const probed = ctx.requestLog.filter((r) => !/\/(about|about-us|company|team|robots\.txt|sitemap\.xml)$/.test(r.url) && r.url !== "https://www.nothing.example/" && !r.url.includes("greenhouse") && !r.url.includes("lever") && !r.url.includes("ashby"));
    expect(probed).toHaveLength(8);
    expect(result.log.join("\n")).toContain("8 probes in a row found nothing");
  });

  it("keeps no body over 2 MB for the rest of the run", async () => {
    const ctx = createFakeDiscoveryContext({ routes: {
      "https://www.acme.example/big": { body: `<main>${"x".repeat(2_100_000)}</main>` },
      "https://www.acme.example/small": { body: "<main>small</main>" },
    } });
    const run = new _DiscoveryRunForTests(ctx);
    for (const url of ["https://www.acme.example/big", "https://www.acme.example/big", "https://www.acme.example/small", "https://www.acme.example/small"]) {
      expect(await run.fetch(url)).not.toBeNull();
    }
    expect(ctx.requestLog.filter((r) => r.url.endsWith("/big"))).toHaveLength(2);
    expect(ctx.requestLog.filter((r) => r.url.endsWith("/small"))).toHaveLength(1);
  });

  it("asks the fetcher to refuse a bundle over the size worth scanning", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acmeind.example/": { body: fx.HOMEPAGE_WITH_OPEN_ROLES_LINK.replace("</nav>", '<script src="/static/app.js"></script></nav>') },
        "https://www.acmeind.example/open-roles": { body: fx.SHELL_PAGE_HTML },
        "https://www.acmeind.example/static/app.js": { body: fx.SHELL_BUNDLE_JS },
        [GH_IND_JOBS]: { body: industriesJobs },
      },
    });
    const asked = new Map<string, FetchInit | undefined>();
    const fetchText = ctx.fetchText;
    ctx.fetchText = async (url, init) => {
      asked.set(url, init);
      return fetchText(url, init);
    };
    await discoverCareersSources("https://www.acmeind.example/", ctx);
    expect(asked.get("https://www.acmeind.example/static/app.js")?.maxBodyBytes).toBe(2_000_000);
  });
});

describe("what discovery follows and whom its model calls are for", () => {
  it("never follows a URL with credentials, even from the model", async () => {
    const ctx = createFakeDiscoveryContext({
      routes: { "https://www.acme.example/": { body: "<html><head><title>Acme</title></head><body><a href='/a'>A</a><a href='/b'>B</a><a href='/c'>C</a><a href='/d'>D</a><a href='/e'>E</a></body></html>" } },
      ai: { chooseCareersLinks: async () => [{ url: "https://admin:secret@www.acme.example/careers", confidence: 0.9, reason: "careers" }] },
    });
    const result = await discoverCareersSources("https://www.acme.example/", ctx);
    expect(ctx.requestLog.some((r) => r.url.includes("@"))).toBe(false);
    expect(result.log.join("\n")).toContain("not following https://admin:secret@www.acme.example/careers");
  });

  it("passes the requesting account to every model call", async () => {
    const ref = { refType: "company", refId: "company-1", userId: "user-1" };
    const seen: unknown[] = [];
    const ctx = createFakeDiscoveryContext({
      routes: {
        "https://www.acme.example/": { body: '<html><head><title>Acme</title></head><body><a href="/careers">Careers</a></body></html>' },
        "https://www.acme.example/careers": { body: "<main><h1>Open roles</h1><a href='/careers/one'>Operations Lead</a></main>" },
      },
      ai: {
        classifyPage: async (_input, callRef) => { seen.push(callRef); return { kind: "other", confidence: 0 }; },
        chooseCareersLinks: async (_input, callRef) => { seen.push(callRef); return []; },
      },
    });
    await discoverCareersSources("https://www.acme.example/", { ...ctx, aiRef: ref });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const callRef of seen) expect(callRef).toEqual(ref);
  });

  it("stops crawling and verifying once its task is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = createFakeDiscoveryContext({ routes: { "https://www.acme.example/": { body: fx.HOMEPAGE_WITH_CAREERS_LINK }, ...greenhouseRoutes } });
    const result = await discoverCareersSources("https://www.acme.example/", { ...ctx, signal: controller.signal });
    expect(ctx.requestLog).toHaveLength(0);
    expect(result.outcome).toBe("not_found");
    expect(result.log.join("\n")).toContain("its task was cancelled");
  });
});
