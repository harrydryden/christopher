import { describe, expect, it } from "vitest";
import { createFakeFetchContext } from "../testing";
import { IncompleteListingError } from "../types";
import * as fx from "../fixtures";
import { getAdapter, isAtsHost, specFromAnyUrl } from "./registry";
import { eightfoldSpec, icimsSpec, jazzhrSpec, jobviteSpec, ripplingSpec, successfactorsSpec, teamtailorSpec } from "./tier2";

const ctx = createFakeFetchContext({
  routes: {
    "https://careers.acme.example/api/apply/v2/jobs?domain=acme.example&start=0&num=100": { body: fx.EIGHTFOLD_PAGE },
    "https://acme.eightfold.ai/api/apply/v2/jobs?domain=acme.com&start=0&num=100": { body: fx.EIGHTFOLD_PAGE },
    "https://api.rippling.com/platform/api/ats/v1/board/acme/jobs": { body: fx.RIPPLING_BOARD },
    "https://api.rippling.com/platform/api/ats/v1/board/missing/jobs": { status: 404, body: "not found" },
    "https://acme.teamtailor.com/jobs": { body: fx.TEAMTAILOR_PAGE_1 },
    "https://acme.teamtailor.com/jobs?page=2": { body: fx.TEAMTAILOR_PAGE_2 },
    "https://acme.teamtailor.com/jobs?page=3": { body: fx.TEAMTAILOR_PAGE_3 },
    "https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1&pr=0": { body: fx.ICIMS_PAGE_0 },
    "https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1&pr=1": { body: fx.ICIMS_PAGE_1 },
    "https://career5.successfactors.com/acmecorp/search/?q=&startrow=0": { body: fx.SUCCESSFACTORS_PAGE_0 },
    "https://career5.successfactors.com/acmecorp/search/?q=&startrow=25": { body: fx.SUCCESSFACTORS_PAGE_25 },
    "https://career5.successfactors.com/acmecorp/search/?q=&startrow=50": { body: fx.SUCCESSFACTORS_PAGE_50 },
    "https://jobs.jobvite.com/acme/jobs": { body: fx.JOBVITE_PAGE },
    "https://jobs.jobvite.com/gone/jobs": { status: 404, body: "not found" },
    "https://acme.applytojob.com/apply/": { body: fx.JAZZHR_PAGE },
    "https://blank.applytojob.com/apply/": { body: "<html><body><p>Welcome</p></body></html>" },
  },
});

describe("tier-2 spec detection", () => {
  const positive: Array<[string, string, string | undefined]> = [
    ["https://acme.eightfold.ai/careers", "eightfold", "acme.com"],
    ["https://careers.acme.example/api/apply/v2/jobs?domain=acme.example&start=0&num=10", "eightfold", "acme.example"],
    ["https://ats.rippling.com/acme/jobs", "rippling", "acme"],
    ["https://ats.rippling.com/acme/jobs/rp-1", "rippling", "acme"],
    ["https://acme.teamtailor.com/jobs/4410001-operations-manager", "teamtailor", "acme"],
    ["https://careers-acme.icims.com/jobs/search?ss=1", "icims", "acme"],
    ["https://career5.successfactors.com/career?company=acmecorp", "successfactors", "acmecorp"],
    ["https://jobs.jobvite.com/acme/jobs", "jobvite", "acme"],
    ["https://acme.applytojob.com/apply/AbC123xyz/Operations-Director", "jazzhr", "acme"],
  ];
  it.each(positive)("%s -> %s", (url, type, slug) => {
    const spec = specFromAnyUrl(url);
    expect(spec?.type).toBe(type);
    expect(spec?.atsSlug).toBe(slug);
  });
  it("rejects vendor marketing hosts and unrelated URLs", () => {
    for (const url of ["https://www.teamtailor.com/", "https://www.icims.com/products", "https://app.applytojob.com/", "https://acme.example/careers", "https://www.rippling.com/ats"]) {
      expect(specFromAnyUrl(url)).toBeNull();
    }
  });
  it("counts tier-2 hosts as ATS hosts for discovery", () => {
    for (const host of ["acme.teamtailor.com", "careers-acme.icims.com", "jobs.jobvite.com", "acme.applytojob.com", "ats.rippling.com", "career5.successfactors.com", "acme.eightfold.ai"]) {
      expect(isAtsHost(host)).toBe(true);
    }
  });
});

describe("eightfold", () => {
  it("paginates the positions feed and maps ids, locations and epoch dates", async () => {
    const postings = await getAdapter("eightfold").fetchPostings(eightfoldSpec("careers.acme.example", "acme.example"), ctx);
    expect(postings.map(p => p.title)).toEqual(["Head of Operations, EMEA", "Staff Engineer"]);
    expect(postings[0]).toMatchObject({ externalId: "563100001", location: "London, United Kingdom", locations: ["London, United Kingdom", "Dublin, Ireland"], department: "Operations", url: "https://careers.acme.example/careers/job/563100001", descriptionText: "Run EMEA operations." });
    expect(postings[0]!.postedAt?.toISOString()).toBe(new Date(1757000000 * 1000).toISOString());
    expect(postings[1]!.remote).toBe(true);
  });
});

describe("rippling", () => {
  it("maps labelled location, department and type", async () => {
    const postings = await getAdapter("rippling").fetchPostings(ripplingSpec("acme"), ctx);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({ externalId: "rp-1", title: "Director of Finance", location: "London, UK", department: "Finance", employmentType: "Full-time" });
    expect(postings[0]!.postedAt?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
    expect(postings[1]!.remote).toBe(true);
  });
  it("reports a 404 as a failed verification, not an empty board", async () => {
    const result = await getAdapter("rippling").verify(ripplingSpec("missing"), ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
  });
});

describe("teamtailor", () => {
  it("walks numbered pages until one adds nothing and splits department from location", async () => {
    const postings = await getAdapter("teamtailor").fetchPostings(teamtailorSpec("https://acme.teamtailor.com", "acme"), ctx);
    expect(postings.map(p => p.title)).toEqual(["Operations Manager", "VP Strategy", "Finance Lead"]);
    expect(postings[0]).toMatchObject({ externalId: "4410001", location: "London", department: "Operations", url: "https://acme.teamtailor.com/jobs/4410001-operations-manager" });
    expect(postings[1]!.remote).toBe(true);
    expect(ctx.requestLog.filter(r => r.url.includes("teamtailor")).map(r => r.url)).toEqual([
      "https://acme.teamtailor.com/jobs", "https://acme.teamtailor.com/jobs?page=2", "https://acme.teamtailor.com/jobs?page=3",
    ]);
  });
});

describe("icims", () => {
  it("reads the iframe listing and stops at the first empty page", async () => {
    const postings = await getAdapter("icims").fetchPostings(icimsSpec("careers-acme.icims.com", "acme"), ctx);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({ externalId: "9001", title: "Head of Operations", location: "UK-London", url: "https://careers-acme.icims.com/jobs/9001/head-of-operations/job" });
    expect(postings[0]!.postedAt?.toISOString().slice(0, 10)).toBe("2026-09-02");
  });
});

describe("successfactors", () => {
  it("pages by startrow and reads title, location and date cells", async () => {
    const postings = await getAdapter("successfactors").fetchPostings(successfactorsSpec("https://career5.successfactors.com/acmecorp", "acmecorp"), ctx);
    expect(postings.map(p => p.title)).toEqual(["Director of Operations", "Engineer", "Chief of Staff"]);
    expect(postings[0]).toMatchObject({ externalId: "1234567", location: "London, GB", url: "https://career5.successfactors.com/job/London-Director-of-Operations-SW1/1234567/" });
    expect(postings[0]!.postedAt?.getFullYear()).toBe(2026);
  });
});

describe("jobvite", () => {
  it("reads every table and takes the department from the preceding heading", async () => {
    const postings = await getAdapter("jobvite").fetchPostings(jobviteSpec("acme"), ctx);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toMatchObject({ externalId: "oXYZabc", title: "Head of Operations", location: "London, United Kingdom", department: "Operations", url: "https://jobs.jobvite.com/acme/job/oXYZabc" });
    expect(postings[1]!.remote).toBe(true);
  });
  it("fails verification on a 404", async () => {
    expect((await getAdapter("jobvite").verify(jobviteSpec("gone"), ctx)).ok).toBe(false);
  });
});

describe("jazzhr", () => {
  it("reads the list-group rows with location, department and type", async () => {
    const postings = await getAdapter("jazzhr").fetchPostings(jazzhrSpec("acme"), ctx);
    expect(postings[0]).toMatchObject({ externalId: "AbC123xyz", title: "Operations Director", location: "London, UK", department: "Operations", employmentType: "Full Time" });
    expect(postings[1]).toMatchObject({ location: "Austin, TX", department: "Logistics" });
  });
  it("treats a page with no listing markers as a parse failure, never an empty scan", async () => {
    await expect(getAdapter("jazzhr").fetchPostings(jazzhrSpec("blank"), ctx)).rejects.toThrow(/listing markers/);
  });
});

describe("tier-2 page budgets", () => {
  it("reports a listing the page budget stops while pages still add roles as incomplete", async () => {
    const page = (n: number) => `<body data-controller="teamtailor"><ul id="jobs_list_container"><li><a href="/jobs/${9000 + n}-role-${n}"><span>Role ${n}</span></a></li></ul></body>`;
    const routes = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [i === 0 ? "https://big.teamtailor.com/jobs" : `https://big.teamtailor.com/jobs?page=${i + 1}`, { body: page(i) }]));
    const error = await getAdapter("teamtailor").fetchPostings(teamtailorSpec("https://big.teamtailor.com", "big"), createFakeFetchContext({ routes })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).postings).toHaveLength(200);
  });

  it("verifies from the first page alone", async () => {
    const one = createFakeFetchContext({ routes: {
      "https://acme.teamtailor.com/jobs": { body: fx.TEAMTAILOR_PAGE_1 },
      "https://acme.teamtailor.com/jobs?page=2": { body: fx.TEAMTAILOR_PAGE_2 },
    } });
    expect(await getAdapter("teamtailor").verify(teamtailorSpec("https://acme.teamtailor.com", "acme"), one)).toMatchObject({ ok: true, count: 2 });
    expect(one.requestLog).toHaveLength(1);
  });

  it("pages SuccessFactors by the page size the tenant states", async () => {
    const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => `<tr><td><a class="jobTitle-link" href="/job/Role-${from + i}/${7000 + from + i}/">Role ${from + i}</a></td></tr>`).join("");
    const label = (from: number, to: number) => `<span class="paginationLabel">Results ${from} – ${to} of 23</span>`;
    const tenant = createFakeFetchContext({ routes: {
      "https://career2.successfactors.eu/small/search/?q=&startrow=0": { body: `<table>${label(1, 10)}${rows(0, 10)}</table>` },
      "https://career2.successfactors.eu/small/search/?q=&startrow=10": { body: `<table>${label(11, 20)}${rows(10, 10)}</table>` },
      "https://career2.successfactors.eu/small/search/?q=&startrow=20": { body: `<table>${label(21, 23)}${rows(20, 3)}</table>` },
      "https://career2.successfactors.eu/small/search/?q=&startrow=30": { body: `<table>${label(31, 30)}</table>` },
    } });
    // Stepping by a fixed 25 skipped rows 11 to 25 on a tenant that shows ten a page.
    const postings = await getAdapter("successfactors").fetchPostings(successfactorsSpec("https://career2.successfactors.eu/small", "small"), tenant);
    expect(postings).toHaveLength(23);
  });

  it("reads only career sites as SuccessFactors boards", () => {
    expect(specFromAnyUrl("https://performancemanager4.successfactors.com/login?company=acme")).toBeNull();
    expect(specFromAnyUrl("https://www.successfactors.com/")).toBeNull();
    expect(specFromAnyUrl("https://career10.successfactors.com/career?company=acme")?.type).toBe("successfactors");
  });

  it("keeps reading Eightfold pages when the feed gives no count", async () => {
    const positions = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `Role ${from + i}` }));
    const board = createFakeFetchContext({ routes: {
      "https://acme.eightfold.ai/api/apply/v2/jobs?domain=acme.com&start=0&num=100": { body: { positions: positions(0, 100) } },
      "https://acme.eightfold.ai/api/apply/v2/jobs?domain=acme.com&start=100&num=100": { body: { positions: positions(100, 30) } },
    } });
    const spec = eightfoldSpec("acme.eightfold.ai", "acme.com");
    expect(await getAdapter("eightfold").fetchPostings(spec, board)).toHaveLength(130);
    const counted = createFakeFetchContext({ routes: {
      "https://acme.eightfold.ai/api/apply/v2/jobs?domain=acme.com&start=0&num=100": { body: { count: 730, positions: positions(0, 100) } },
    } });
    expect(await getAdapter("eightfold").verify(spec, counted)).toMatchObject({ ok: true, count: 730 });
    expect(counted.requestLog).toHaveLength(1);
  });
});
