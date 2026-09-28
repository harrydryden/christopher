import { describe, expect, it } from "vitest";
import { postingOnCompanyHost } from "./posting-host";

const acme = { domain: "acme.com", homepageUrl: "https://www.acme.com/" };
const source = (fields: Partial<{ type: string; url: string; apiUrl: string | null; atsSlug: string | null; atsSite: string | null; status: string }>) =>
  ({ type: "greenhouse", url: "https://job-boards.greenhouse.io/acme", apiUrl: null, atsSlug: "acme", atsSite: null, status: "active", ...fields });

describe("postingOnCompanyHost", () => {
  it("accepts the company's own site and its subdomains", () => {
    expect(postingOnCompanyHost("https://acme.com/careers/ops-lead", acme, [])).toBe(true);
    expect(postingOnCompanyHost("https://careers.acme.com/jobs/1", acme, [])).toBe(true);
    expect(postingOnCompanyHost("https://www.acme.com/jobs/1", acme, [])).toBe(true);
  });

  it("refuses another site, however the name reads", () => {
    expect(postingOnCompanyHost("https://attacker.example/acme-senior-operations", acme, [])).toBe(false);
    expect(postingOnCompanyHost("https://acme.com.attacker.example/jobs/1", acme, [])).toBe(false);
    expect(postingOnCompanyHost("https://notacme.com/jobs/1", acme, [])).toBe(false);
    expect(postingOnCompanyHost("not a url", acme, [])).toBe(false);
  });

  it("accepts the company's own board on an ATS, and not another company's board on the same host", () => {
    const sources = [source({})];
    expect(postingOnCompanyHost("https://job-boards.greenhouse.io/acme/jobs/123", acme, sources)).toBe(true);
    expect(postingOnCompanyHost("https://boards.greenhouse.io/acme/jobs/123", acme, sources)).toBe(true);
    expect(postingOnCompanyHost("https://job-boards.greenhouse.io/rival/jobs/123", acme, sources)).toBe(false);
    // With no source naming that board, an ATS host proves nothing.
    expect(postingOnCompanyHost("https://job-boards.greenhouse.io/acme/jobs/123", acme, [])).toBe(false);
    // A board an administrator retired is not the company's any more.
    expect(postingOnCompanyHost("https://job-boards.greenhouse.io/acme/jobs/123", acme, [source({ status: "disabled" })])).toBe(false);
  });

  it("does not widen a homepage on a shared host to everything on that host", () => {
    const pages = { domain: "github.io", homepageUrl: "https://acme.github.io/" };
    expect(postingOnCompanyHost("https://acme.github.io/jobs/1", pages, [])).toBe(true);
    expect(postingOnCompanyHost("https://evil.github.io/jobs/1", pages, [])).toBe(false);
  });

  it("accepts the host of a careers page the company is scanned from", () => {
    const html = source({ type: "html", url: "https://jobs.acme-careers.net/listing", atsSlug: null });
    expect(postingOnCompanyHost("https://jobs.acme-careers.net/listing/42", acme, [html])).toBe(true);
    expect(postingOnCompanyHost("https://other.acme-careers.net/listing/42", acme, [html])).toBe(false);
  });

  // Ported from the worker's own copy of the rule, which this function replaced.
  it("knows a company's own hosts from its homepage, its careers pages and its own boards", () => {
    const company = { domain: "acme.example", homepageUrl: "https://www.acme.example/" };
    const sources = [
      source({ apiUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs" }),
      source({ type: "html", url: "https://careers.acmejobs.example/listing", atsSlug: null }),
    ];
    expect(postingOnCompanyHost("https://acme.example/jobs/1", company, sources)).toBe(true);
    expect(postingOnCompanyHost("https://jobs.acme.example/1", company, sources)).toBe(true);
    expect(postingOnCompanyHost("https://careers.acmejobs.example/role/9", company, sources)).toBe(true);
    expect(postingOnCompanyHost("https://job-boards.greenhouse.io/acme/jobs/4001", company, sources)).toBe(true);
    // A vendor's host is shared by every customer: another company's board on it is not this one's.
    expect(postingOnCompanyHost("https://job-boards.greenhouse.io/someone-else/jobs/4001", company, sources)).toBe(false);
    expect(postingOnCompanyHost("https://notacme.example/jobs/1", company, sources)).toBe(false);
    expect(postingOnCompanyHost("https://evil.example/acme.example/jobs/1", company, sources)).toBe(false);
    expect(postingOnCompanyHost("not a url", company, sources)).toBe(false);
  });

  it("trusts the registrable domain only when the homepage is on it", () => {
    const company = { domain: "acme.example", homepageUrl: "https://www.acme-robotics.example/" };
    expect(postingOnCompanyHost("https://www.acme-robotics.example/careers/1", company, [])).toBe(true);
    expect(postingOnCompanyHost("https://jobs.acme.example/1", company, [])).toBe(false);
  });

  it("reads only an html source's host as the company's, and a Greenhouse EU board apart from the US one", () => {
    const monitored = source({ type: "rss", url: "https://feeds.example/acme.xml", atsSlug: null });
    expect(postingOnCompanyHost("https://feeds.example/acme/1", acme, [monitored])).toBe(false);
    expect(postingOnCompanyHost("https://job-boards.eu.greenhouse.io/acme/jobs/1", acme, [source({})])).toBe(false);
    expect(postingOnCompanyHost("https://job-boards.eu.greenhouse.io/acme/jobs/1", acme, [source({ atsSite: "eu" })])).toBe(true);
  });
});
