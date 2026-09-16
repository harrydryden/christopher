import { describe, expect, it } from "vitest";
import { createFakeFetchContext } from "../testing";
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
