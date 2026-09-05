import { describe, expect, it } from "vitest";
import { createFakeFetchContext } from "../testing";
import * as fx from "../fixtures";
import { adapters, findAtsSpecsInText, getAdapter, isAtsHost, specFromAnyUrl } from "./registry";
import { extractJsonLdPostings } from "./jsonld";
import { applyRecipe, compactDomForModel, extractPostingsFromHtml, findJobLinks, validateRecipe } from "./html";
import type { HtmlRecipe } from "../types";

const ctx = createFakeFetchContext({
  routes: {
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": { body: fx.GREENHOUSE_JOBS },
    "https://boards-api.greenhouse.io/v1/boards/acme": { body: fx.GREENHOUSE_BOARD },
    "https://boards-api.greenhouse.io/v1/boards/missing/jobs?content=true": { status: 404, body: { error: "not found" } },
    "https://api.lever.co/v0/postings/acme?mode=json": { body: fx.LEVER_POSTINGS },
    "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true": { body: fx.ASHBY_BOARD },
    "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=100&offset=0": { body: fx.SMARTRECRUITERS_PAGE },
    "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=1&offset=0": { body: fx.SMARTRECRUITERS_PAGE },
    "https://api.smartrecruiters.com/v1/companies/acme/postings/744000000000001": { body: fx.SMARTRECRUITERS_DETAIL },
    "https://acme.recruitee.com/api/offers/": { body: fx.RECRUITEE_OFFERS },
    "https://acme.jobs.personio.de/xml": { body: fx.PERSONIO_XML },
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
    expect(ops.department).toBe("Operations");
    expect(ops.postedAt?.toISOString()).toBe("2026-08-28T09:00:00.000Z");
    expect(ops.url).toBe("https://job-boards.greenhouse.io/acme/jobs/4001001");
    expect(ops.salaryText).toBe("£70,000 - £90,000");
    expect(ops.descriptionText).toContain("Operations Manager");
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
    const { fetchDescriptionFor } = await import("./registry");
    const description = await fetchDescriptionFor(spec, postings[0]!, ctx);
    expect(description).toContain("Coordinate day-to-day operations.");
    expect(description).toContain("3+ years in operations.");
  });
  it("recruitee skips unpublished offers", async () => {
    const postings = await getAdapter("recruitee").fetchPostings(specFromAnyUrl("https://acme.recruitee.com")!, ctx);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.descriptionText).toContain("Run operations.");
  });
  it("personio parses the XML feed", async () => {
    const postings = await getAdapter("personio").fetchPostings(specFromAnyUrl("https://acme.jobs.personio.de")!, ctx);
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
