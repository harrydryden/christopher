import { describe, expect, it } from "vitest";
import { createFakeFetchContext } from "../testing";
import { findAtsSpecsInText, getAdapter } from "./registry";
import { extractJsonLdPostings } from "./jsonld";

// Each of these patterns once rescanned the rest of the text from every repeated prefix, which is
// quadratic: a hostile page or feed at the 5 MB body cap held the worker's event loop for hours.
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

describe("ATS references in hostile text", () => {
  it.each([["job_board?"], ["Grnhse.Settings={"], ["//aaaaaaaaaa"]])("scans 5 MB of %s in linear time", (unit) => {
    within200ms(unit, (page) => findAtsSpecsInText(page));
  });

  it("still reads every embed style", () => {
    const specs = findAtsSpecsInText(`<script src="https://boards.greenhouse.io/embed/job_board/js?for=alpha"></script>
      <iframe src="/embed/job_board?b=1&for=bravo"></iframe>
      <script>Grnhse.Settings = { scrollOnLoad: true, for: "charlie" };</script>
      <script>var cfg = { "boardToken": "delta", jobBoardName: 'echo', leverSite: "foxtrot" };</script>`);
    expect(specs.map((spec) => `${spec.type}:${spec.atsSlug}`).sort()).toEqual([
      "ashby:echo", "greenhouse:alpha", "greenhouse:bravo", "greenhouse:charlie", "greenhouse:delta", "lever:foxtrot",
    ]);
  });
});

describe("JSON-LD and RSS on hostile input", () => {
  it("reads 5 MB of unclosed script tags in linear time and never truncates a real listing", () => {
    within200ms('<script type="application/ld+json">', (page) => extractJsonLdPostings(page, "https://acme.example/jobs"));
    const posting = (i: number) => `<script type="application/ld+json">{"@type":"JobPosting","title":"Role ${i}","url":"https://acme.example/jobs/${i}","description":"${"x".repeat(3000)}"}</script>`;
    const page = Array.from({ length: 900 }, (_, i) => posting(i)).join("\n");
    expect(page.length).toBeGreaterThan(2_000_000);
    expect(extractJsonLdPostings(page, "https://acme.example/jobs")).toHaveLength(900);
  });

  it("reads an RSS feed, and 5 MB of unclosed items in linear time", async () => {
    const feed = `<rss><channel><title>Acme jobs</title>
      <item><title><![CDATA[Operations Lead]]></title><link>https://acme.example/jobs/1</link><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate></item>
      <entry><title>Engineer</title><link rel="alternate" href="https://acme.example/jobs/2"/><updated>2026-09-02T00:00:00Z</updated></entry>
      <item><title>Analyst</title><guid>https://acme.example/jobs/3</guid></item>
      <itemize>not an item</itemize></channel></rss>`;
    const ctx = createFakeFetchContext({ routes: {
      "https://acme.example/jobs.rss": { body: feed },
      "https://acme.example/warm.rss": { body: hostile("<item><title>", 50_000) },
      "https://acme.example/hostile.rss": { body: hostile("<item><title>") },
    } });
    const rss = getAdapter("rss");
    const postings = await rss.fetchPostings({ type: "rss", url: "https://acme.example/jobs.rss" }, ctx);
    expect(postings.map((p) => [p.title, p.url, p.postedAt?.toISOString()])).toEqual([
      ["Operations Lead", "https://acme.example/jobs/1", "2026-09-01T00:00:00.000Z"],
      ["Engineer", "https://acme.example/jobs/2", "2026-09-02T00:00:00.000Z"],
      ["Analyst", "https://acme.example/jobs/3", undefined],
    ]);
    await rss.fetchPostings({ type: "rss", url: "https://acme.example/warm.rss" }, ctx);
    const started = process.cpuUsage();
    await rss.fetchPostings({ type: "rss", url: "https://acme.example/hostile.rss" }, ctx);
    const { user, system } = process.cpuUsage(started);
    expect((user + system) / 1000).toBeLessThan(200);
  });
});
