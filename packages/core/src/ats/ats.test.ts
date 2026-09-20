import { describe, expect, it } from "vitest";
import { createFakeFetchContext } from "../testing";
import * as fx from "../fixtures";
import { adapters, descriptionsFetchedPerPosting, fetchDescriptionFor, findAtsSpecsInText, getAdapter, isAtsHost, specFromAnyUrl } from "./registry";
import { extractJsonLdPostings } from "./jsonld";
import { applyRecipe, compactDomForModel, extractPostingsFromHtml, findJobLinks, validateRecipe } from "./html";
import { IncompleteListingError, type HtmlRecipe } from "../types";

const ctx = createFakeFetchContext({
  routes: {
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { body: fx.GREENHOUSE_JOBS },
    "https://boards-api.greenhouse.io/v1/boards/acme/departments": { body: fx.GREENHOUSE_DEPARTMENTS },
    "https://boards-api.greenhouse.io/v1/boards/acme/offices": { body: fx.GREENHOUSE_OFFICES },
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4001001": { body: fx.GREENHOUSE_JOB_DETAIL },
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4001003": { body: fx.GREENHOUSE_JOB_DETAIL_NO_CONTENT },
    "https://boards-api.greenhouse.io/v1/boards/acme": { body: fx.GREENHOUSE_BOARD },
    "https://boards-api.greenhouse.io/v1/boards/missing/jobs": { status: 404, body: { error: "not found" } },
    "https://api.lever.co/v0/postings/acme?mode=json": { body: fx.LEVER_POSTINGS },
    "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true": { body: fx.ASHBY_BOARD },
    "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100&offset=0": { body: fx.SMARTRECRUITERS_PAGE },
    "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=1&offset=0": { body: fx.SMARTRECRUITERS_PAGE },
    "https://api.smartrecruiters.com/v1/companies/acme/postings/744000000000001": { body: fx.SMARTRECRUITERS_DETAIL },
    "https://acme.recruitee.com/api/offers/": { body: fx.RECRUITEE_OFFERS },
    "https://acme.jobs.personio.de/xml?language=en": { body: fx.PERSONIO_XML },
    "https://acme.bamboohr.com/careers/list": { body: fx.BAMBOOHR_LIST },
    "https://acmecorp.wd1.myworkdayjobs.com/wday/cxs/acmecorp/External/jobs": [
      { body: fx.WORKDAY_PAGE_1, bodyContains: '"offset":0' },
      { body: fx.WORKDAY_PAGE_2, bodyContains: '"offset":20' },
    ],
    "https://acme.pinpointhq.com/postings.json": { body: fx.PINPOINT_POSTINGS },
    "https://acme.breezy.hr/json": { body: fx.BREEZY_JSON },
    "https://apply.workable.com/api/v3/accounts/acme/jobs": { body: fx.WORKABLE_V3 },
    "https://www.workable.com/api/accounts/acme": { body: { name: "Acme Robotics" } },
  },
});

describe("specFromAnyUrl", () => {
  const cases: Array<[string, string, string | undefined]> = [
    ["https://boards.greenhouse.io/acme", "greenhouse", "acme"],
    ["https://job-boards.greenhouse.io/acme/jobs/4001001", "greenhouse", "acme"],
    ["https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true", "greenhouse", "acme"],
    ["https://boards.greenhouse.io/embed/job_board/js?for=acme", "greenhouse", "acme"],
    ["https://jobs.lever.co/acme", "lever", "acme"],
    ["https://jobs.eu.lever.co/acme/1234", "lever", "acme"],
    ["https://api.lever.co/v0/postings/acme?mode=json", "lever", "acme"],
    ["https://jobs.ashbyhq.com/acme", "ashby", "acme"],
    ["https://api.ashbyhq.com/posting-api/job-board/acme", "ashby", "acme"],
    ["https://apply.workable.com/acme/", "workable", "acme"],
    ["https://jobs.smartrecruiters.com/acme", "smartrecruiters", "acme"],
    ["https://acme.recruitee.com/o/role", "recruitee", "acme"],
    ["https://acme.jobs.personio.de/job/1", "personio", "acme"],
    ["https://acme.bamboohr.com/careers", "bamboohr", "acme"],
    ["https://acmecorp.wd1.myworkdayjobs.com/en-US/External", "workday", "acmecorp"],
    ["https://acme.pinpointhq.com/en/postings/1", "pinpoint", "acme"],
    ["https://acme.breezy.hr/p/role", "breezy", "acme"],
  ];
  for (const [url, type, slug] of cases) {
    it(`recognises ${url}`, () => {
      const spec = specFromAnyUrl(url);
      expect(spec?.type).toBe(type);
      expect(spec?.atsSlug).toBe(slug);
    });
  }
  it("rejects non-ATS and reserved-path URLs", () => {
    expect(specFromAnyUrl("https://www.acme.com/careers")).toBeNull();
    expect(specFromAnyUrl("https://boards.greenhouse.io/embed")).toBeNull();
    expect(specFromAnyUrl("not a url")).toBeNull();
  });
  it("knows ATS hosts", () => {
    expect(isAtsHost("boards.greenhouse.io")).toBe(true);
    expect(isAtsHost("acme.breezy.hr")).toBe(true);
    expect(isAtsHost("www.acme.com")).toBe(false);
  });
});

describe("greenhouse adapter", () => {
  const spec = specFromAnyUrl("https://boards.greenhouse.io/acme")!;
  it("maps every posting with ids, locations and dates", async () => {
    const postings = await getAdapter("greenhouse").fetchPostings(spec, ctx);
    expect(postings).toHaveLength(6);
    const ops = postings[0]!;
    expect(ops.title).toBe("Operations Manager");
    expect(ops.externalId).toBe("4001001");
    expect(ops.location).toBe("London, UK");
    expect(ops.url).toBe("https://job-boards.greenhouse.io/acme/jobs/4001001");
    expect(ops.salaryText).toBe("£70,000 - £90,000");
    expect(ops.updatedAt?.toISOString()).toBe("2026-08-30T09:00:00.000Z");
    // `first_published` is only on the single-job response, so the listing cannot date a posting.
    expect(ops.postedAt).toBeUndefined();
    // The listing is fetched without descriptions; they arrive one role at a time.
    expect(ops.descriptionText).toBeUndefined();
    expect(ops.descriptionHtml).toBeUndefined();
  });
  it("fills department and offices from the index endpoints the plain listing lacks", async () => {
    const postings = await getAdapter("greenhouse").fetchPostings(spec, ctx);
    const byId = new Map(postings.map((p) => [p.externalId, p]));
    // A gate matching on department can only work if this survives the listing having none.
    expect(byId.get("4001001")!.department).toBe("Operations");
    expect(byId.get("4001003")!.department).toBe("Engineering");
    expect(byId.get("4001006")!.department).toBe("People");
    // Offices, parent office included, exactly as `content=true` used to list them.
    expect(byId.get("4001001")!.locations).toEqual(["London, UK", "Europe", "London"]);
    expect(byId.get("4001004")!.locations).toEqual(["New York, NY", "New York"]);
  });
  it("still lists every role when the department and office indexes fail", async () => {
    const listingOnly = createFakeFetchContext({ routes: { "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { body: fx.GREENHOUSE_JOBS } } });
    const postings = await getAdapter("greenhouse").fetchPostings(spec, listingOnly);
    expect(postings).toHaveLength(6);
    expect(postings[0]!.department).toBeUndefined();
    expect(postings[0]!.locations).toBeUndefined();
    expect(postings[0]!.title).toBe("Operations Manager");
  });
  it("treats a listing shorter than the board's own count as incomplete", async () => {
    const short = createFakeFetchContext({
      routes: {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { body: { jobs: fx.GREENHOUSE_JOBS.jobs.slice(0, 2), meta: { total: 6 } } },
      },
    });
    // Two of six roles returned as a complete listing would close the other four after two scans.
    const error = await getAdapter("greenhouse").fetchPostings(spec, short).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).message).toContain("2 of 6");
    expect((error as IncompleteListingError).postings).toHaveLength(2);
  });
  it("never asks the board for every description at once", async () => {
    const listing = createFakeFetchContext({
      routes: {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs": { body: fx.GREENHOUSE_JOBS },
        "https://boards-api.greenhouse.io/v1/boards/acme/departments": { body: fx.GREENHOUSE_DEPARTMENTS },
        "https://boards-api.greenhouse.io/v1/boards/acme/offices": { body: fx.GREENHOUSE_OFFICES },
      },
    });
    await getAdapter("greenhouse").fetchPostings(spec, listing);
    // The listing, the departments index and the offices index: three bounded requests, and not
    // one description among them.
    expect(listing.requestLog.map((r) => r.url)).toEqual([
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
      "https://boards-api.greenhouse.io/v1/boards/acme/departments",
      "https://boards-api.greenhouse.io/v1/boards/acme/offices",
    ]);
    expect(listing.requestLog.some((r) => r.url.includes("content=true"))).toBe(false);
    expect(spec.apiUrl).not.toContain("content=true");
  });
  it("fetches one role's description from the detail endpoint", async () => {
    const postings = await getAdapter("greenhouse").fetchPostings(spec, ctx);
    const manager = postings.find((p) => p.externalId === "4001001")!;
    const description = await fetchDescriptionFor(spec, manager, ctx);
    expect(description).toContain("We are looking for an Operations Manager in London.");
    // A posting the board has no description for resolves to nothing rather than to empty text,
    // so the caller falls back to the posting page instead of storing a blank description.
    const engineer = postings.find((p) => p.externalId === "4001003")!;
    expect(await fetchDescriptionFor(spec, engineer, ctx)).toBeUndefined();
    expect(await fetchDescriptionFor(spec, { title: "No id", url: "https://job-boards.greenhouse.io/acme/jobs/x" }, ctx)).toBeUndefined();
  });
  it("is declared as a per-role description source", () => {
    expect(descriptionsFetchedPerPosting("greenhouse")).toBe(true);
    expect(descriptionsFetchedPerPosting("lever")).toBe(false);
    expect(descriptionsFetchedPerPosting("html")).toBe(false);
  });
  it("flags remote roles from the location text", async () => {
    const postings = await getAdapter("greenhouse").fetchPostings(spec, ctx);
    expect(postings.find((p) => p.title.includes("Senior Operations"))?.remote).toBe(true);
  });
  it("verifies and reports the company name", async () => {
    const result = await getAdapter("greenhouse").verify(spec, ctx);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(6);
    expect(result.companyName).toBe("Acme Robotics");
    expect(result.sample).toHaveLength(3);
  });
  it("reports failure rather than throwing on a 404", async () => {
    const result = await getAdapter("greenhouse").verify(specFromAnyUrl("https://boards.greenhouse.io/missing")!, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
  });
});

describe("other adapters", () => {
  it("lever maps categories, epoch dates and salary", async () => {
    const postings = await getAdapter("lever").fetchPostings(specFromAnyUrl("https://jobs.lever.co/acme")!, ctx);
    expect(postings).toHaveLength(2);
    expect(postings[0]!.location).toBe("London");
    expect(postings[0]!.locations).toEqual(["London", "Bristol"]);
    expect(postings[0]!.department).toBe("Operations / Ops");
    expect(postings[0]!.postedAt?.getUTCFullYear()).toBe(2025);
    expect(postings[0]!.salaryText).toContain("GBP");
    expect(postings[1]!.remote).toBe(true);
  });
  it("lever folds the requirement lists and the closing note into the description text", async () => {
    // A description gate keys on `descriptionText` alone, and `descriptionPlain` is only the
    // opening paragraph: the requirements are where the words a search is written around live.
    const postings = await getAdapter("lever").fetchPostings(specFromAnyUrl("https://jobs.lever.co/acme")!, ctx);
    const text = postings[0]!.descriptionText!;
    expect(text).toContain("Own operations end to end.");
    expect(text).toContain("Requirements");
    expect(text).toContain("Five years running a warehouse");
    expect(text).toContain("Four-day week");
    expect(text).toContain("We interview in two rounds.");
    // A posting with neither lists nor a closing note is unchanged.
    expect(postings[1]!.descriptionText).toBe("Analyse data.");
  });
  it("ashby skips unlisted jobs and keeps secondary locations", async () => {
    const postings = await getAdapter("ashby").fetchPostings(specFromAnyUrl("https://jobs.ashbyhq.com/acme")!, ctx);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.locations).toEqual(["London, United Kingdom", "Dublin, Ireland"]);
    expect(postings[0]!.salaryText).toBe("£55K – £65K");
  });
  it("smartrecruiters builds public urls and fetches descriptions on demand", async () => {
    const spec = specFromAnyUrl("https://jobs.smartrecruiters.com/acme")!;
    const postings = await getAdapter("smartrecruiters").fetchPostings(spec, ctx);
    expect(postings).toHaveLength(2);
    expect(postings[0]!.url).toBe("https://jobs.smartrecruiters.com/acme/744000000000001");
    expect(postings[1]!.remote).toBe(true);
    const description = await fetchDescriptionFor(spec, postings[0]!, ctx);
    expect(description).toContain("Coordinate day-to-day operations.");
    expect(description).toContain("3+ years in operations.");
  });
  it("smartrecruiters defers descriptions instead of fetching them inside the scan", () => {
    // Without this the scan takes the inline branch and spends one 2-second detail request per
    // matching role inside a 180-second task; a 500-role board with a description gate never ends.
    expect(descriptionsFetchedPerPosting("smartrecruiters")).toBe(true);
  });
  it("smartrecruiters reports a board larger than its page budget as incomplete", async () => {
    // Ten pages of 100 with 1,500 roles on the board: the 500 unread roles must not look closed.
    const page = (offset: number) => ({
      body: {
        offset,
        limit: 100,
        totalFound: 1500,
        content: Array.from({ length: 100 }, (_, i) => ({ id: `sr-${offset + i}`, name: `Role ${offset + i}`, location: { city: "London", country: "UK" } })),
      },
    });
    const routes = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100&offset=${i * 100}`, page(i * 100)]),
    );
    const bigCtx = createFakeFetchContext({ routes });
    const spec = specFromAnyUrl("https://jobs.smartrecruiters.com/acme")!;
    const error = await getAdapter("smartrecruiters").fetchPostings(spec, bigCtx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).postings).toHaveLength(1000);
    expect((error as IncompleteListingError).message).toContain("500 roles unread");
    // The board still verifies: it exists and lists roles, it is only too long to read in one pass.
    const verified = await getAdapter("smartrecruiters").verify(spec, bigCtx);
    expect(verified.ok).toBe(true);
    expect(verified.count).toBe(1000);
  });
  it("workable reports a board with an eleventh page as incomplete", async () => {
    const paged = createFakeFetchContext({
      routes: {
        // Every page hands back another next-page token, so the loop always exits with more to read.
        "https://apply.workable.com/api/v3/accounts/acme/jobs": { body: { total: 400, nextPage: "more", results: fx.WORKABLE_V3.results } },
        "https://www.workable.com/api/accounts/acme?details=true": { body: { jobs: fx.WORKABLE_V3.results } },
      },
    });
    const error = await getAdapter("workable").fetchPostings(specFromAnyUrl("https://apply.workable.com/acme/")!, paged).catch((e: unknown) => e);
    // The legacy widget feed must not quietly stand in for the truncated listing either.
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).postings.length).toBeGreaterThan(0);
  });
  it("workday takes the total from the first page only", async () => {
    // Some tenants report the total once and send 0 on every page after it; believing the zero
    // ended the listing at page two and closed everything past it.
    const pages = [
      { total: 45, count: 20, offset: 0 },
      { total: 0, count: 20, offset: 20 },
      { total: 0, count: 5, offset: 40 },
    ];
    const routes = {
      "https://acmecorp.wd1.myworkdayjobs.com/wday/cxs/acmecorp/External/jobs": pages.map(({ total, count, offset }) => ({
        bodyContains: `"offset":${offset}`,
        body: {
          total,
          jobPostings: Array.from({ length: count }, (_, i) => ({
            title: `Role ${offset + i + 1}`,
            externalPath: `/job/London/Role-${offset + i + 1}_R-${offset + i}`,
            locationsText: "London, United Kingdom",
            bulletFields: [`R-${offset + i}`],
          })),
        },
      })),
    };
    const spec = specFromAnyUrl("https://acmecorp.wd1.myworkdayjobs.com/en-US/External")!;
    const postings = await getAdapter("workday").fetchPostings(spec, createFakeFetchContext({ routes }));
    expect(postings).toHaveLength(45);
  });
  it("workday reports a tenant larger than the posting cap as incomplete", async () => {
    const full = {
      total: 50_000,
      jobPostings: Array.from({ length: 20 }, (_, i) => ({
        title: `Role ${i}`,
        externalPath: `/job/London/Role-${i}_R-${i}`,
        locationsText: "London, United Kingdom",
      })),
    };
    const spec = specFromAnyUrl("https://acmecorp.wd1.myworkdayjobs.com/en-US/External")!;
    const capped = createFakeFetchContext({ routes: { "https://acmecorp.wd1.myworkdayjobs.com/wday/cxs/acmecorp/External/jobs": { body: full } } });
    const error = await getAdapter("workday").fetchPostings(spec, capped).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).postings).toHaveLength(10_000);
  });
  it("recruitee skips unpublished offers", async () => {
    const postings = await getAdapter("recruitee").fetchPostings(specFromAnyUrl("https://acme.recruitee.com")!, ctx);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.descriptionText).toContain("Run operations.");
  });
  it("personio parses the XML feed and asks for it in English", async () => {
    const postings = await getAdapter("personio").fetchPostings(specFromAnyUrl("https://acme.jobs.personio.de")!, ctx);
    // A German tenant's default feed would pass an English keyword gate nothing at all, and the
    // scan would succeed while doing it, so the language is always asked for.
    expect(ctx.requestLog.some(r => r.url === "https://acme.jobs.personio.de/xml?language=en")).toBe(true);
    expect(specFromAnyUrl("https://acme.jobs.personio.de")!.apiUrl).toBe("https://acme.jobs.personio.de/xml?language=en");
    expect(postings).toHaveLength(2);
    expect(postings[0]!.title).toBe("Operations Specialist");
    expect(postings[0]!.url).toBe("https://acme.jobs.personio.de/job/1234567");
    expect(postings[0]!.location).toBe("Berlin, Acme GmbH");
  });
  it("bamboohr handles remote rows without a city", async () => {
    const postings = await getAdapter("bamboohr").fetchPostings(specFromAnyUrl("https://acme.bamboohr.com/careers")!, ctx);
    expect(postings).toHaveLength(2);
    expect(postings[0]!.location).toBe("London, England");
    expect(postings[1]!.location).toBe("Remote");
  });
  it("workday paginates and parses relative posted dates", async () => {
    const now = new Date("2026-09-05T00:00:00Z");
    const pagedCtx = createFakeFetchContext({
      routes: {
        "https://acmecorp.wd1.myworkdayjobs.com/wday/cxs/acmecorp/External/jobs": [
          { body: fx.WORKDAY_PAGE_1, bodyContains: '"offset":0' },
          { body: fx.WORKDAY_PAGE_2, bodyContains: '"offset":20' },
        ],
      },
      now: () => now,
    });
    const spec = specFromAnyUrl("https://acmecorp.wd1.myworkdayjobs.com/en-US/External")!;
    const postings = await getAdapter("workday").fetchPostings(spec, pagedCtx);
    expect(postings).toHaveLength(25);
    expect(postings[0]!.title).toBe("Operations Program Manager");
    expect(postings[0]!.url).toBe("https://acmecorp.wd1.myworkdayjobs.com/External/job/London/Role-1_R-1000");
    expect(postings[0]!.postedAt?.toISOString()).toBe("2026-09-02T00:00:00.000Z");
    expect(postings[20]!.locations).toEqual(["London, United Kingdom", "Manchester, United Kingdom"]);
  });
  it("pinpoint accepts object or string locations", async () => {
    const postings = await getAdapter("pinpoint").fetchPostings(specFromAnyUrl("https://acme.pinpointhq.com")!, ctx);
    expect(postings.map((p) => p.location)).toEqual(["London, UK", "Remote, UK"]);
  });
  it("breezy maps nested location objects", async () => {
    const postings = await getAdapter("breezy").fetchPostings(specFromAnyUrl("https://acme.breezy.hr")!, ctx);
    expect(postings[0]!.location).toBe("London, United Kingdom");
  });
  it("workable builds apply urls and flags remote", async () => {
    const postings = await getAdapter("workable").fetchPostings(specFromAnyUrl("https://apply.workable.com/acme/")!, ctx);
    expect(postings).toHaveLength(2);
    expect(postings[0]!.url).toBe("https://apply.workable.com/acme/j/ABCDEF0123/");
    expect(postings[0]!.location).toBe("London, England, United Kingdom");
    expect(postings[1]!.remote).toBe(true);
  });
  it("registers every adapter type once", () => {
    const types = adapters.map((a) => a.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain("html");
  });
});

describe("findAtsSpecsInText", () => {
  it("finds a single greenhouse board across an embed script, escaped URL and board token", () => {
    const specs = findAtsSpecsInText(fx.EMBEDDED_GREENHOUSE_HTML);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.type).toBe("greenhouse");
    expect(specs[0]!.atsSlug).toBe("acme");
  });
  it("finds a slug inside a JavaScript bundle with escaped slashes", () => {
    const specs = findAtsSpecsInText(fx.SHELL_BUNDLE_JS);
    expect(specs[0]?.atsSlug).toBe("acmeindustries");
  });
  it("returns nothing for unrelated text", () => {
    expect(findAtsSpecsInText("<p>Contact us at hello@acme.com</p>")).toEqual([]);
  });
});

describe("JSON-LD extraction", () => {
  const postings = extractJsonLdPostings(fx.JSONLD_LISTING_HTML, "https://acmefoods.example.com/careers");
  it("extracts every JobPosting from an ItemList", () => {
    expect(postings).toHaveLength(4);
    expect(postings.map((p) => p.title)).toContain("Operations Manager");
  });
  it("builds locations from postal addresses and keeps multiples", () => {
    expect(postings[0]!.location).toBe("London, England, GB");
    expect(postings[3]!.locations).toEqual(["London, GB", "Dublin, IE"]);
  });
  it("flags telecommute roles and parses salary", () => {
    expect(postings[1]!.remote).toBe(true);
    expect(postings[0]!.salaryText).toBe("GBP 60000 - 75000 per year");
    expect(postings[0]!.externalId).toBe("REQ-1");
  });
  it("never throws on malformed JSON", () => {
    expect(extractJsonLdPostings('<script type="application/ld+json">{oops</script>', "https://x.example")).toEqual([]);
  });
});

describe("HTML extraction", () => {
  const url = "https://www.acme.example/careers/jobs";
  it("finds job links and ignores navigation", () => {
    const links = findJobLinks(fx.LISTING_PAGE_HTML, url);
    expect(links).toHaveLength(5);
    expect(links.map((l) => l.text)).toContain("Operations Manager");
    expect(links.map((l) => l.text)).not.toContain("Careers");
    expect(links.map((l) => l.text)).not.toContain("Back to careers");
  });
  it("reads locations from the surrounding markup", () => {
    const postings = extractPostingsFromHtml(fx.LISTING_PAGE_HTML, url);
    expect(postings).toHaveLength(5);
    expect(postings.find((p) => p.title === "Operations Manager")?.location).toBe("London, UK");
    expect(postings.find((p) => p.title === "Senior Operations Associate")?.remote).toBe(true);
  });
  it("removes accessibility target hints before rejecting apply controls", () => {
    // Reduced from OpenAI's live careers markup on 20 September 2026: every real role link was
    // followed by an Ashby application control whose hidden target hint became visible text.
    const html = `<main>
      <article><a href="/careers/research-engineer/">Research Engineer</a>
        <a href="https://jobs.ashbyhq.com/openai/application/123">Apply now<span>(opens in a new window)</span></a></article>
      <article><a href="https://jobs.ashbyhq.com/acme/456">Operations Lead<span>(opens in a new tab)</span></a></article>
    </main>`;
    expect(findJobLinks(html, "https://openai.com/careers/search/")).toEqual([
      expect.objectContaining({ text: "Research Engineer", url: "https://openai.com/careers/research-engineer/" }),
      expect.objectContaining({ text: "Operations Lead", url: "https://jobs.ashbyhq.com/acme/456" }),
    ]);
  });
  it("excludes career navigation without blacklisting words that can be role titles", () => {
    // Reduced from Mozilla's live careers sub-navigation on 20 September 2026.
    const html = `<nav aria-label="Careers">
      <a href="/en-US/careers/">Overview</a>
      <a href="/en-US/careers/diversity/">Diversity and Inclusion</a>
      <a href="/en-US/careers/benefits/">Benefits</a>
    </nav><main>
      <a href="/en-US/careers/listings/benefits-lead/">Benefits Lead</a>
      <a href="/en-US/careers/listings/diversity-director/">Diversity and Inclusion Director</a>
    </main>`;
    expect(findJobLinks(html, "https://www.mozilla.org/en-US/careers/listings/").map(link => link.text)).toEqual([
      "Benefits Lead", "Diversity and Inclusion Director",
    ]);
  });
  it("excludes listing roots, career content and RSS subscriptions while preserving derived role slugs", () => {
    const html = `<main>
      <a href="/careers/listings/">Find your role</a>
      <a href="/careers/search">Open roles</a>
      <a href="/careers/feed/">Subscribe to our open positions RSS feed</a>
      <a href="/careers/compatibility">Compatibility</a>
      <a href="/careers/emerging-talent">Emerging talent</a>
      <a href="/jobs/benefits-lead">Benefits Lead</a>
      <a href="/jobs/feed-engineer">Feed Engineer</a>
      <a href="/jobs/position?id=123">Position with identifier</a>
    </main>`;
    expect(findJobLinks(html, "https://acme.example/careers/").map(link => link.text)).toEqual([
      "Benefits Lead", "Feed Engineer", "Position with identifier",
    ]);
  });
  it("excludes global header navigation while preserving a role link in an article header", () => {
    const html = `<header><a href="/careers/company-overview/">Company overview</a></header>
      <article class="opening-card"><header><a href="/jobs/123">Engineer</a></header></article>`;
    expect(findJobLinks(html, "https://acme.example/careers/").map(link => link.text)).toEqual(["Engineer"]);
  });
  it("matches ATS domains on the hostname rather than arbitrary URL text", () => {
    const html = `<main>
      <a href="https://example.com/about?next=jobs.ashbyhq.com/acme">Company overview</a>
      <a href="https://jobs.ashbyhq.com/acme/123">Platform Engineer</a>
    </main>`;
    expect(findJobLinks(html, "https://example.com/about").map(link => link.text)).toEqual(["Platform Engineer"]);
  });
  it("prefers JSON-LD when present", () => {
    const postings = extractPostingsFromHtml(fx.JSONLD_LISTING_HTML, "https://acmefoods.example.com/careers");
    expect(postings).toHaveLength(4);
    expect(postings[0]!.postedAt).toBeInstanceOf(Date);
  });
  it("applies and validates a selector recipe", () => {
    const recipe: HtmlRecipe = { version: 1, listItem: "ul.roles li", title: "a", link: "a", location: ".loc" };
    const produced = applyRecipe(fx.LISTING_PAGE_HTML, url, recipe);
    expect(produced).toHaveLength(5);
    expect(produced[0]!.location).toBe("London, UK");
    expect(validateRecipe(fx.LISTING_PAGE_HTML, url, recipe, produced)).toEqual({ ok: true, coverage: 1 });
    const broken: HtmlRecipe = { ...recipe, listItem: "ul.nope li" };
    expect(validateRecipe(fx.LISTING_PAGE_HTML, url, broken, produced).ok).toBe(false);
  });
  it("compacts the DOM and lists every anchor for validation", () => {
    const { text, knownUrls } = compactDomForModel(fx.LISTING_PAGE_HTML, url);
    expect(knownUrls.length).toBeGreaterThanOrEqual(5);
    expect(knownUrls).toContain("https://job-boards.greenhouse.io/acme/jobs/4001001");
    expect(text).toContain("# Operations");
    expect(text.length).toBeLessThan(60_000);
  });
});

describe("large and incomplete Greenhouse boards", () => {
  it("retains every role on an Anduril-sized board", async () => {
    const jobs = Array.from({ length: 2212 }, (_, i) => ({ id: i + 1, title: `Operations Director ${i}`, absolute_url: `https://job-boards.greenhouse.io/large/jobs/${i + 1}` }));
    const ctx = createFakeFetchContext({ routes: { "https://boards-api.greenhouse.io/v1/boards/large/jobs": { body: { jobs } } } });
    const postings = await getAdapter("greenhouse").fetchPostings({ type: "greenhouse", url: "https://job-boards.greenhouse.io/large", atsSlug: "large" }, ctx);
    expect(postings).toHaveLength(2212);
    expect(postings.at(-1)?.externalId).toBe("2212");
  });
  it("rejects malformed responses instead of treating them as an empty board", async () => {
    for (const body of [{ error: "unavailable" }, { jobs: [{ id: 1, title: "Missing URL" }] }]) {
      const ctx = createFakeFetchContext({ routes: { "https://boards-api.greenhouse.io/v1/boards/large/jobs": { body } } });
      await expect(getAdapter("greenhouse").fetchPostings({ type: "greenhouse", url: "https://job-boards.greenhouse.io/large", atsSlug: "large" }, ctx)).rejects.toThrow();
    }
  });
});
