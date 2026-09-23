import { describe, expect, it } from "vitest";
import { hasEmptyJobsMount, isJsShell, parseSitemapUrls, sitemapsFromRobots } from "./discover";
import { countAnchors } from "./links";

// Every heuristic here once rescanned the rest of the page from each repeated prefix: seconds on a
// 100 KB page and hours at the fetcher's 5 MB body cap, with the worker's event loop held throughout.
const hostile = (unit: string, length = 5_000_000) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
/**
 * Read a 5 MB page of `unit` in under 200 ms of CPU, after warming the same code path on 50 KB of
 * it. CPU time, not wall time, so a busy machine does not fail it; the quadratic versions of these
 * patterns spent minutes of CPU on a page this size.
 */
const within200ms = (unit: string, read: (page: string) => unknown) => {
  read(hostile(unit, 50_000));
  const page = hostile(unit);
  const started = process.cpuUsage();
  read(page);
  const { user, system } = process.cpuUsage(started);
  expect((user + system) / 1000).toBeLessThan(200);
};

describe("page heuristics on hostile input", () => {
  it("counts anchors on a page of unclosed tags in linear time", () => {
    within200ms("<a ", countAnchors);
    within200ms("<a ", isJsShell);
  });

  it("looks for an empty jobs mount on a page of unclosed divs in linear time", () => {
    within200ms("<div ", hasEmptyJobsMount);
    within200ms('<div class="jobs x', hasEmptyJobsMount);
  });

  it("parses a sitemap of containers without locations, and robots.txt of blank lines, in linear time", () => {
    within200ms("<url>", parseSitemapUrls);
    within200ms("\n", sitemapsFromRobots);
  });
});

describe("page heuristics still read ordinary pages", () => {
  it("counts anchors with an href", () => {
    expect(countAnchors('<a href="/a">A</a><A class="x" HREF="/b">B</A><a name="top"></a><area href="/c">')).toBe(2);
  });

  it("recognises an empty jobs mount and nothing else", () => {
    expect(hasEmptyJobsMount('<main><div id="jobs-root" class="app"></div></main>')).toBe(true);
    expect(hasEmptyJobsMount("<section class='open-positions'>\n </section>")).toBe(true);
    expect(hasEmptyJobsMount('<div id="jobs-root"><a href="/jobs/1">Engineer</a></div>')).toBe(false);
    expect(hasEmptyJobsMount('<div class="team"></div>')).toBe(false);
  });

  it("reads sitemap indexes, url sets and bare locations", () => {
    expect(parseSitemapUrls(`<sitemapindex><sitemap><loc> https://a.example/s1.xml </loc></sitemap>
      <sitemap><loc>https://a.example/s2.xml</loc></sitemap><sitemap><loc>https://a.example/s3.xml</loc></sitemap></sitemapindex>`))
      .toEqual({ sitemaps: ["https://a.example/s1.xml", "https://a.example/s2.xml"], urls: [] });
    expect(parseSitemapUrls("<urlset><url><loc>https://a.example/jobs/1</loc><lastmod>x</lastmod></url><url><loc>https://a.example/jobs/2</loc></url></urlset>"))
      .toEqual({ sitemaps: [], urls: ["https://a.example/jobs/1", "https://a.example/jobs/2"] });
    expect(parseSitemapUrls("<x><loc>https://a.example/one</loc></x>")).toEqual({ sitemaps: [], urls: ["https://a.example/one"] });
  });

  it("reads Sitemap lines from robots.txt whatever the line endings", () => {
    expect(sitemapsFromRobots("User-agent: *\r\nDisallow: /x\r\n  Sitemap: https://a.example/sitemap.xml  \r\nsitemap:https://a.example/jobs.xml\rNoise sitemap: no"))
      .toEqual(["https://a.example/sitemap.xml", "https://a.example/jobs.xml"]);
  });
});
