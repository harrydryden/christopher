import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { IncompleteListingError, type FetchContext, type RenderedPage } from "@ava/core";
import { observeHtmlListing } from "./live-acceptance-html";

const url = "https://example.test/jobs";
const spec = { type: "html" as const, url };
const role = (id: string) => `<article><a href="/jobs/${id}">Engineer ${id}</a></article>`;
const empty = '<main><section class="jobs">There are currently no positions.</section></main>';
const shell = '<main><div id="app"></div><script src="/app.js"></script></main>';
function context(pages: Record<string, string>, rendered?: Partial<RenderedPage>): FetchContext {
  return {
    fetchText: vi.fn(async u => {
      if (!(u in pages)) throw new Error("HTTP 503");
      return { url: u, status: 200, headers: {}, body: pages[u]! };
    }),
    ...(rendered ? { render: vi.fn(async () => ({ html: shell, finalUrl: url, status: 200, requests: [], ...rendered })) } : {}),
  };
}

describe("HTML acceptance completeness", () => {
  it("does not certify a JavaScript shell as a successful zero", async () => {
    await expect(observeHtmlListing(spec, context({ [url]: shell }))).rejects.toMatchObject({ name: "IncompleteListingError", postings: [] });
  });
  it("accepts an explicit empty listing but not an empty phrase in navigation", async () => {
    await expect(observeHtmlListing(spec, context({ [url]: empty }))).resolves.toEqual([]);
    await expect(observeHtmlListing(spec, context({ [url]: `<nav>${empty}</nav>` }))).rejects.toBeInstanceOf(IncompleteListingError);
  });
  it("renders shells and combines every captured listing page without duplicate roles", async () => {
    const ctx = context({ [url]: shell }, { listingPages: [{ html: role("one"), url }, { html: role("one") + role("two"), url }], incomplete: false });
    expect((await observeHtmlListing(spec, ctx)).map(r => r.url)).toEqual([`${url}/one`, `${url}/two`]);
    expect(ctx.render).toHaveBeenCalledWith(url, { scrollAndExpand: true });
  });
  it("merges locations for the same role across browser captures", async () => {
    const card = (location: string) => `<article><a href="/jobs/one">Engineer one</a><span class="location">${location}</span></article>`;
    const ctx = context({ [url]: shell }, { listingPages: [
      { html: card("London, UK"), url }, { html: card("Remote in Canada"), url },
    ], incomplete: false });
    expect(await observeHtmlListing(spec, ctx)).toMatchObject([{ location: "London, UK",
      locations: ["London, UK", "Remote in Canada"], remote: true }]);
  });
  it("refuses browser completion when a scoped distinct-job total exceeds captured identities", async () => {
    const counted = '<span class="ais-Stats-text">3 jobs available</span>' + role("one") + role("two");
    const ctx = context({ [url]: shell }, { listingPages: [{ html: counted, url }], incomplete: false });
    await expect(observeHtmlListing(spec, ctx)).rejects.toMatchObject({ name: "IncompleteListingError",
      postings: [{ url: `${url}/one` }, { url: `${url}/two` }] });
  });
  it("reads compressed captures one at a time and retains earlier roles after a corrupt later capture", async () => {
    const first = role("one");
    const second = role("two");
    const compressed = (html: string) => ({ gzip: gzipSync(html), decodedBytes: Buffer.byteLength(html), url });
    const complete = context({ [url]: shell }, { compressedListingPages: [compressed(first), compressed(second)], incomplete: false });
    expect((await observeHtmlListing(spec, complete)).map(posting => posting.url)).toEqual([`${url}/one`, `${url}/two`]);
    const corrupt = context({ [url]: shell }, { compressedListingPages: [compressed(first), { ...compressed(second), gzip: Buffer.from("broken") }], incomplete: false });
    await expect(observeHtmlListing(spec, corrupt)).rejects.toMatchObject({ name: "IncompleteListingError", postings: [{ url: `${url}/one` }] });
  });
  it("permits an initial loading capture followed by confirmed roles, but refuses unexplained later loss", async () => {
    const loaded = context({ [url]: shell }, { listingPages: [{ html: shell, url }, { html: role("one"), url }], incomplete: false });
    expect(await observeHtmlListing(spec, loaded)).toHaveLength(1);
    const lost = context({ [url]: shell }, { listingPages: [{ html: role("one"), url }, { html: shell, url }], incomplete: false });
    await expect(observeHtmlListing(spec, lost)).rejects.toMatchObject({ postings: [{ url: `${url}/one` }] });
  });
  it("preserves known postings but refuses an incomplete browser traversal", async () => {
    const ctx = context({ [url]: role("one") + '<button><span>Load more</span></button>' }, { html: role("one") + role("two"), incomplete: true });
    await expect(observeHtmlListing(spec, ctx)).rejects.toMatchObject({ name: "IncompleteListingError", postings: [{ url: `${url}/one` }, { url: `${url}/two` }] });
  });
  it("does not certify a browser challenge or error as empty", async () => {
    await expect(observeHtmlListing(spec, context({ [url]: shell }, { html: shell }))).rejects.toBeInstanceOf(IncompleteListingError);
    await expect(observeHtmlListing(spec, context({ [url]: shell }, { html: empty, status: 403 }))).rejects.toBeInstanceOf(IncompleteListingError);
  });
  it("traverses HTTP next pages and keeps useful results when the next page fails", async () => {
    const next = `${url}?page=2`;
    const first = role("one") + '<a rel="next" href="?page=2">Next</a>';
    const good = await observeHtmlListing(spec, context({ [url]: first, [next]: role("two") }));
    expect(good).toHaveLength(2);
    await expect(observeHtmlListing(spec, context({ [url]: first }))).rejects.toMatchObject({ postings: [{ url: `${url}/one` }] });
  });
  it("refuses a remaining expansion control without a browser", async () => {
    await expect(observeHtmlListing(spec, context({ [url]: role("one") + '<button>Show more</button>' }))).rejects.toMatchObject({ postings: [{ url: `${url}/one` }] });
  });
  it("refuses a final active expansion control even if the browser reports completion", async () => {
    await expect(observeHtmlListing(spec, context({ [url]: shell }, { html: role("one") + '<button>Show more</button>', incomplete: false })))
      .rejects.toMatchObject({ postings: [{ url: `${url}/one` }] });
  });
  it("follows a head next link that browser rendering cannot click", async () => {
    const second = `${url}?page=2`;
    const third = `${url}?page=3`;
    const ctx = context({ [url]: shell + '<link rel="next" href="?page=2">',
      [second]: role("two") + '<link rel="next" href="?page=3">', [third]: role("three") }, {
      listingPages: [{ html: role("one"), url }], incomplete: false,
    });
    expect((await observeHtmlListing(spec, ctx)).map(item => item.url)).toEqual([`${url}/one`, `${url}/two`, `${url}/three`]);
    expect(ctx.fetchText).toHaveBeenCalledWith(second);
    expect(ctx.fetchText).toHaveBeenCalledWith(third);
  });
  it("follows a next link from the last rendered capture", async () => {
    const second = `${url}?page=2`;
    const third = `${url}?page=3`;
    const ctx = context({ [url]: shell, [third]: role("three") }, {
      listingPages: [{ html: role("one"), url }, { html: role("two") + '<link rel="next" href="?page=3">', url: second }], incomplete: false,
    });
    expect(await observeHtmlListing(spec, ctx)).toHaveLength(3);
    expect(ctx.fetchText).toHaveBeenCalledWith(third);
  });
  it("refuses a cyclic pagination path", async () => {
    await expect(observeHtmlListing(spec, context({ [url]: role("one") + '<a rel="next" href="?page=2">Next</a>', [`${url}?page=2`]: role("two") + '<a rel="next" href="/jobs">Next</a>' }))).rejects.toMatchObject({ postings: [{ url: `${url}/one` }, { url: `${url}/two` }] });
  });
  it("retains roles but refuses a next page on another origin, before or after rendering", async () => {
    const crossOrigin = '<link rel="next" href="https://elsewhere.test/jobs?page=2">';
    await expect(observeHtmlListing(spec, context({ [url]: role("one") + crossOrigin })))
      .rejects.toMatchObject({ postings: [{ url: `${url}/one` }] });
    await expect(observeHtmlListing(spec, context({ [url]: shell + crossOrigin }, { html: role("one"), incomplete: false })))
      .rejects.toMatchObject({ postings: [{ url: `${url}/one` }] });
    await expect(observeHtmlListing(spec, context({ [url]: shell }, { html: role("one") + crossOrigin, incomplete: false })))
      .rejects.toMatchObject({ postings: [{ url: `${url}/one` }] });
  });
});
