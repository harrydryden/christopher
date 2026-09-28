import { describe, expect, it } from "vitest";
import { nextListingPage } from "./html";
import { completeListing, readOffsetPages } from "./common";
import { IncompleteListingError } from "../types";

describe("listing pagination", () => {
  const url = "https://acme.example/careers";
  it("resolves explicit next-page links", () => {
    expect(nextListingPage('<link rel="next" href="?page=2">', url)).toBe("https://acme.example/careers?page=2");
    expect(nextListingPage('<a href="/more" aria-label="Next page">→</a>', url)).toBe("https://acme.example/more");
  });
  it("does not follow off-site, disabled, self or ordinary job links", () => {
    expect(nextListingPage('<a rel="next" href="https://elsewhere.example/jobs">Next</a>', url)).toBeNull();
    expect(nextListingPage('<a rel="next" aria-disabled="true" href="?page=2">Next</a>', url)).toBeNull();
    expect(nextListingPage('<a rel="next" href="#page">Next</a>', url)).toBeNull();
    expect(nextListingPage('<a href="/jobs/one">Operations Manager</a>', url)).toBeNull();
  });
});

describe("offset-paged feeds", () => {
  const role = (i: number) => ({ title: `Role ${i}`, url: `https://acme.example/jobs/${i}` });
  /** Three pages of two; the total is reported on the first page only, as some Workday tenants do. */
  const pages = [{ items: [role(1), role(2)], total: 5 }, { items: [role(3), role(4)], total: 0 }, { items: [role(5)], total: 0 }];
  const read = (totalPolicy: "first" | "latest", maxPages = 10) =>
    readOffsetPages({ pageSize: 2, maxPages, totalPolicy, fetchPage: async (offset) => pages[offset / 2] ?? { items: [] }, map: (r) => r });

  it("keeps the first positive total when told to, and reads every page", async () => {
    const all = await read("first");
    expect(all).toMatchObject({ total: 5, more: false, nextOffset: 6 });
    expect(all.postings).toHaveLength(5);
  });
  it("takes each page's own total otherwise, so a later zero ends the read", async () => {
    expect(await read("latest")).toMatchObject({ total: 0, more: false, nextOffset: 4 });
  });
  it("reports a read the page budget cut short as incomplete", async () => {
    const short = await read("first", 1);
    expect(short).toMatchObject({ more: true, nextOffset: 2 });
    expect(() => completeListing("Acme", short)).toThrow(IncompleteListingError);
    expect(completeListing("Acme", await read("first"))).toHaveLength(5);
  });
});
