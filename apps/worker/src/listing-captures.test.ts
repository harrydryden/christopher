import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { RenderedPage } from "@col/core";
import { listingCaptureCount, listingCaptures } from "./listing-captures";

const url = "https://example.test/jobs";
const base = (html: string): RenderedPage => ({ html, finalUrl: url, requests: [], status: 200 });
const compressed = (html: string, captureUrl = url) => ({ gzip: gzipSync(html), decodedBytes: Buffer.byteLength(html), url: captureUrl });

describe("listing capture decoding", () => {
  it("reads compressed captures in order and keeps raw fixture compatibility", () => {
    const first = "<a href='/jobs/one'>One</a>";
    const second = "<a href='/jobs/two'>Two</a>";
    const rendered = { ...base(second), compressedListingPages: [compressed(first), compressed(second, `${url}?page=2`)] };
    expect([...listingCaptures(rendered)]).toEqual([{ html: first, url }, { html: second, url: `${url}?page=2` }]);
    expect(listingCaptureCount(rendered)).toBe(2);
    expect([...listingCaptures({ ...base(second), listingPages: [{ html: first, url }] })]).toEqual([{ html: first, url }]);
  });

  it("includes a changed final page that did not fit the compressed capture budget", () => {
    const first = "First page";
    const final = "Second page";
    const rendered = { ...base(final), compressedListingPages: [compressed(first)], finalCaptureUnstored: true };
    expect([...listingCaptures(rendered)].map(page => page.html)).toEqual([first, final]);
    expect(listingCaptureCount(rendered)).toBe(2);
  });

  it("refuses corruption, length mismatches and decompression beyond the decoded bound", () => {
    const bad = { ...base("final"), compressedListingPages: [{ ...compressed("good"), gzip: Buffer.from("not gzip") }] };
    expect(() => [...listingCaptures(bad)]).toThrow(/corrupt/);
    const mismatch = { ...base("final"), compressedListingPages: [{ ...compressed("good"), decodedBytes: 3 }] };
    expect(() => [...listingCaptures(mismatch)]).toThrow(/does not match/);
    const oversized = { ...base("final"), compressedListingPages: [compressed("x".repeat(101))] };
    expect(() => [...listingCaptures(oversized, 100)]).toThrow(/decoded byte limit/);
  });
});
