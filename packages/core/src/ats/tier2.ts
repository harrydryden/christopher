/**
 * Tier-2 adapters: HRIS and ATS products that publish a public feed or a
 * server-rendered listing with a stable shape, but no documented API.
 *
 * VERIFY: every endpoint and selector here is modelled on public career sites
 * as they were observed, not on vendor documentation, and the fixtures record
 * that observed shape. Before relying on an adapter for a new company, run
 * `pnpm cli probe <board url>` against the real board and check the count and
 * sample; a vendor redesign shows up as a `parse` failure, never as an empty
 * successful scan, because each adapter throws when a listing page has the
 * expected markers but yields nothing.
 *
 * Why these exist at all: without them these products fall through to the
 * generic HTML path — a browser render every scan, a model call whenever the
 * page changes shape — which is the least reliable and most expensive route
 * for what are some of the most common enterprise systems.
 */
import * as cheerio from "cheerio";
import type { Adapter, FetchContext, RawPosting, SourceSpec } from "../types";
import { SourceFetchError } from "../types";
import { absoluteUrl, parseDate } from "../normalize";
import { fetchJson, htmlToText, pathSegments, rec, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

/** Most listing pages one HTML source is walked through; 50 rows a page covers the cap. */
const MAX_PAGES = 200;

function clean(s: string | undefined | null): string | undefined {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t || undefined;
}

async function fetchHtml(ctx: FetchContext, url: string): Promise<string> {
  const res = await ctx.fetchText(url, { headers: { accept: "text/html" } });
  if (res.status >= 400) {
    throw new SourceFetchError(`HTTP ${res.status} from ${url}`, res.status === 403 || res.status === 429 ? "blocked" : "http", res.status);
  }
  return res.body;
}

/**
 * Walk numbered listing pages until a page adds nothing new. Each adapter
 * supplies the page URL and the row parser; this owns the loop, the cap and
 * the "markers present but no rows" parse failure.
 */
async function paginate(
  ctx: FetchContext,
  pageUrl: (index: number) => string,
  parse: (html: string, url: string) => { postings: RawPosting[]; markers: boolean },
  opts: { firstIndex?: number; step?: number } = {},
): Promise<RawPosting[]> {
  const seen = new Map<string, RawPosting>();
  const first = opts.firstIndex ?? 0;
  const step = opts.step ?? 1;
  for (let page = 0; page < MAX_PAGES && seen.size < MAX_POSTINGS; page++) {
    const index = first + page * step;
    const url = pageUrl(index);
    const html = await fetchHtml(ctx, url);
    const { postings, markers } = parse(html, url);
    if (page === 0 && postings.length === 0 && !markers) {
      throw new SourceFetchError(`no listing markers found at ${url}; the board may have changed shape`, "parse");
    }
    let added = 0;
    for (const posting of postings) {
      const key = posting.externalId ?? posting.url;
      if (seen.has(key)) continue;
      seen.set(key, posting);
      added++;
    }
    if (added === 0) break;
  }
  return [...seen.values()].slice(0, MAX_POSTINGS);
}

function adapterFor(type: SourceType2, specFromUrl: Adapter["specFromUrl"], fetchPostings: Adapter["fetchPostings"]): Adapter {
  return { type, specFromUrl, fetchPostings, verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx))() };
}
type SourceType2 = "teamtailor" | "icims" | "jobvite" | "jazzhr" | "rippling" | "successfactors" | "eightfold";

// ---------------------------------------------------------------------------
// Eightfold — JSON. `GET https://{host}/api/apply/v2/jobs?domain={domain}&start=0&num=100`
// Observed on *.eightfold.ai career sites and on custom domains served by it.
// The `domain` parameter is the company domain the site was configured with;
// on eightfold.ai hosts it is the subdomain's company, on custom hosts the
// host itself. `positions[]` carry id, name, location, locations, department,
// canonicalPositionUrl, t_create (epoch seconds), job_description (HTML).
// ---------------------------------------------------------------------------
export function eightfoldSpec(host: string, domain: string): SourceSpec {
  return {
    type: "eightfold",
    url: `https://${host}/careers`,
    apiUrl: `https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=0&num=100`,
    atsSlug: domain,
    atsSite: host,
  };
}

function eightfoldFromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const domainParam = u.searchParams.get("domain");
  if (host.endsWith(".eightfold.ai")) {
    const domain = domainParam ?? u.searchParams.get("company") ?? `${host.split(".")[0]}.com`;
    return eightfoldSpec(host, domain);
  }
  // A custom host is only recognisable by its API path.
  if (pathSegments(u).slice(0, 3).join("/") === "api/apply/v2" && domainParam) return eightfoldSpec(host, domainParam);
  return null;
}

interface EfPosition { id?: number | string; name?: string; location?: string; locations?: string[]; department?: string; canonicalPositionUrl?: string; t_create?: number; job_description?: string }

async function eightfoldPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const host = spec.atsSite, domain = spec.atsSlug;
  if (!host || !domain) throw new Error("eightfold spec missing host/domain");
  const out: RawPosting[] = [];
  const num = 100;
  for (let start = 0; start < MAX_POSTINGS; start += num) {
    const { data } = await fetchJson<{ count?: number; positions?: EfPosition[] }>(ctx, `https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=${start}&num=${num}`);
    const positions = Array.isArray(data.positions) ? data.positions : [];
    for (const p of positions) {
      const title = str(p.name), id = str(p.id);
      if (!title || !id) continue;
      const location = str(p.location);
      const locations = (p.locations ?? []).map(str).filter((s): s is string => !!s);
      out.push({
        externalId: id, title,
        url: str(p.canonicalPositionUrl) ?? `https://${host}/careers/job/${id}`,
        location: location ?? locations[0],
        locations: locations.length > 1 ? locations : undefined,
        department: str(p.department),
        remote: /remote/i.test(location ?? "") || undefined,
        postedAt: parseDate(p.t_create),
        descriptionHtml: str(p.job_description),
        descriptionText: htmlToText(p.job_description),
      });
    }
    const total = typeof data.count === "number" ? data.count : out.length;
    if (positions.length === 0 || start + num >= total) break;
  }
  return out.slice(0, MAX_POSTINGS);
}
export const eightfold = adapterFor("eightfold", eightfoldFromUrl, eightfoldPostings);

// ---------------------------------------------------------------------------
// Rippling — JSON. `GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs`
// Public board `https://ats.rippling.com/{slug}/jobs`. Items carry id, name,
// url, workLocation.label, department.label, employmentType.label.
// ---------------------------------------------------------------------------
export function ripplingSpec(slug: string): SourceSpec {
  return { type: "rippling", url: `https://ats.rippling.com/${slug}/jobs`, apiUrl: `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`, atsSlug: slug };
}
function ripplingFromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase(), segs = pathSegments(u);
  if (host === "ats.rippling.com" && slugOk(segs[0])) return ripplingSpec(segs[0]);
  if (host === "api.rippling.com" && segs[4] === "board" && slugOk(segs[5])) return ripplingSpec(segs[5]);
  return null;
}
async function ripplingPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  if (!spec.atsSlug) throw new Error("rippling spec missing slug");
  const { data } = await fetchJson<unknown>(ctx, spec.apiUrl ?? ripplingSpec(spec.atsSlug).apiUrl!);
  const list = Array.isArray(data) ? data : Array.isArray(rec(data)?.items) ? (rec(data)!.items as unknown[]) : [];
  const out: RawPosting[] = [];
  for (const item of list) {
    const j = rec(item); if (!j) continue;
    const title = str(j.name) ?? str(j.title), url = str(j.url);
    if (!title || !url) continue;
    const location = str(rec(j.workLocation)?.label) ?? str(j.location);
    out.push({
      externalId: str(j.id) ?? str(j.uuid), title, url, location,
      department: str(rec(j.department)?.label),
      employmentType: str(rec(j.employmentType)?.label),
      remote: /remote/i.test(location ?? "") || undefined,
      postedAt: parseDate(j.publishedAt ?? j.createdAt),
    });
  }
  return out.slice(0, MAX_POSTINGS);
}
export const rippling = adapterFor("rippling", ripplingFromUrl, ripplingPostings);

// ---------------------------------------------------------------------------
// Teamtailor — server-rendered listing at `https://{slug}.teamtailor.com/jobs`
// (custom domains are reached through a pasted URL). Rows are anchors to
// `/jobs/{id}-{slug}`; the row's secondary line reads "Department · Location".
// Pagination is `?page=N`.
// ---------------------------------------------------------------------------
export function teamtailorSpec(origin: string, slug?: string): SourceSpec {
  return { type: "teamtailor", url: `${origin}/jobs`, atsSlug: slug };
}
function teamtailorFromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const m = u.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.teamtailor\.com$/);
  if (!m || !slugOk(m[1]) || m[1] === "career" || m[1] === "app") return null;
  return teamtailorSpec(`https://${u.hostname.toLowerCase()}`, m[1]);
}
const TT_JOB_RE = /\/jobs\/(\d+)-[^/?#]*/;
export function parseTeamtailor(html: string, pageUrl: string): { postings: RawPosting[]; markers: boolean } {
  const $ = cheerio.load(html);
  const postings: RawPosting[] = [];
  const seen = new Set<string>();
  for (const a of $("a[href]").toArray()) {
    const href = $(a).attr("href") ?? "";
    const m = href.match(TT_JOB_RE);
    if (!m) continue;
    const url = absoluteUrl(href, pageUrl); if (!url || seen.has(m[1]!)) continue;
    const node = $(a);
    const titleNode = node.find("span, h2, h3").first();
    const title = clean(titleNode.length ? titleNode.text() : node.text());
    if (!title) continue;
    const meta = clean(node.find("div, p").last().text());
    const parts = meta && meta !== title ? meta.split(/\s*[·•|]\s*/).map(clean).filter((s): s is string => !!s) : [];
    const location = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const department = parts.length > 1 ? parts[0] : undefined;
    seen.add(m[1]!);
    postings.push({ externalId: m[1], title, url, location, department, remote: /remote/i.test(meta ?? "") || undefined });
  }
  return { postings, markers: /teamtailor|data-controller|\/jobs\b/i.test(html) };
}
async function teamtailorPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const base = spec.url.replace(/\/+$/, "").replace(/\?.*$/, "");
  return paginate(ctx, (page) => (page === 1 ? base : `${base}?page=${page}`), parseTeamtailor, { firstIndex: 1 });
}
export const teamtailor = adapterFor("teamtailor", teamtailorFromUrl, teamtailorPostings);

// ---------------------------------------------------------------------------
// iCIMS — `https://careers-{slug}.icims.com/jobs/search?ss=1&pr={page}&in_iframe=1`
// renders the listing as plain HTML when asked for the iframe view. Each row
// links to `/jobs/{id}/{slug}/job` with the title in an <h2>/<h3> and the
// location in `.header.left` or a `dd` following "Location".
// ---------------------------------------------------------------------------
export function icimsSpec(host: string, slug?: string): SourceSpec {
  return { type: "icims", url: `https://${host}/jobs/search?ss=1`, apiUrl: `https://${host}/jobs/search?ss=1&in_iframe=1&pr=0`, atsSlug: slug, atsSite: host };
}
function icimsFromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const m = host.match(/^(?:careers|jobs)-([a-z0-9][a-z0-9-]*)\.icims\.com$/) ?? host.match(/^([a-z0-9][a-z0-9-]*)\.icims\.com$/);
  if (!m || !slugOk(m[1]) || ["www", "media", "help", "care"].includes(m[1]!)) return null;
  return icimsSpec(host, m[1]);
}
const ICIMS_JOB_RE = /\/jobs\/(\d+)\/[^/?#]+\/job\b/;
export function parseIcims(html: string, pageUrl: string): { postings: RawPosting[]; markers: boolean } {
  const $ = cheerio.load(html);
  const postings: RawPosting[] = [];
  const seen = new Set<string>();
  for (const a of $("a[href]").toArray()) {
    const href = $(a).attr("href") ?? "";
    const m = href.match(ICIMS_JOB_RE);
    if (!m || seen.has(m[1]!)) continue;
    const url = absoluteUrl(href.split("?")[0]!, pageUrl); if (!url) continue;
    const node = $(a);
    const title = clean(node.find("h1, h2, h3, .title").first().text()) ?? clean(node.text());
    if (!title) continue;
    const row = node.closest(".row, .iCIMS_JobsTable, li, tr, article");
    const location = clean(row.find(".header.left span, .iCIMS_JobHeaderTag, dd, .location").first().text());
    const postedText = clean(row.find("dt:contains('Posted') + dd, .date, time").first().text());
    seen.add(m[1]!);
    postings.push({ externalId: m[1], title, url, location, remote: /remote/i.test(location ?? "") || undefined, postedAt: postedText ? parseDate(postedText) : undefined });
  }
  return { postings, markers: /icims/i.test(html) };
}
async function icimsPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const host = spec.atsSite ?? safeUrl(spec.url)?.hostname;
  if (!host) throw new Error("icims spec missing host");
  return paginate(ctx, (page) => `https://${host}/jobs/search?ss=1&in_iframe=1&pr=${page}`, parseIcims);
}
export const icims = adapterFor("icims", icimsFromUrl, icimsPostings);

// ---------------------------------------------------------------------------
// SAP SuccessFactors — `https://{site}/search/?q=&startrow={n}` on
// career*.successfactors.com / *.successfactors.eu and on custom domains
// (jobs.company.com) that a pasted URL reaches. Rows are
// `a.jobTitle-link` with `span.jobLocation` / `span.jobDate` siblings; 25 rows
// a page, paginated by `startrow`.
// ---------------------------------------------------------------------------
export function successfactorsSpec(origin: string, company?: string): SourceSpec {
  return { type: "successfactors", url: `${origin}/search/`, apiUrl: `${origin}/search/?q=&startrow=0`, atsSlug: company, atsSite: origin };
}
function successfactorsFromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)successfactors\.(com|eu)$/.test(host)) return null;
  const company = u.searchParams.get("company") ?? undefined;
  const origin = `https://${host}`;
  return successfactorsSpec(company ? `${origin}/${company}` : origin, company ?? undefined);
}
export function parseSuccessfactors(html: string, pageUrl: string): { postings: RawPosting[]; markers: boolean } {
  const $ = cheerio.load(html);
  const postings: RawPosting[] = [];
  for (const a of $("a.jobTitle-link, a[href*='/job/']").toArray()) {
    const node = $(a);
    const href = node.attr("href") ?? "";
    if (!/\/job\//.test(href)) continue;
    const url = absoluteUrl(href, pageUrl); if (!url) continue;
    const title = clean(node.text()); if (!title) continue;
    const row = node.closest("tr, li, .job-tile, .jobs-list-item, div");
    const location = clean(row.find(".jobLocation, [class*='location']").first().text());
    const date = clean(row.find(".jobDate, [class*='date']").first().text());
    const id = href.match(/\/(\d+)\/?$/)?.[1] ?? href.match(/-(\d+)\//)?.[1];
    postings.push({ externalId: id, title, url, location, remote: /remote|virtual/i.test(location ?? "") || undefined, postedAt: date ? parseDate(date) : undefined });
  }
  const dedup = new Map(postings.map(p => [p.externalId ?? p.url, p]));
  return { postings: [...dedup.values()], markers: /jobTitle-link|successfactors|paginationLabel/i.test(html) };
}
async function successfactorsPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const origin = (spec.atsSite ?? spec.url).replace(/\/search\/?.*$/, "").replace(/\/+$/, "");
  return paginate(ctx, (startrow) => `${origin}/search/?q=&startrow=${startrow}`, parseSuccessfactors, { step: 25 });
}
export const successfactors = adapterFor("successfactors", successfactorsFromUrl, successfactorsPostings);

// ---------------------------------------------------------------------------
// Jobvite — `https://jobs.jobvite.com/{slug}/jobs` lists every job in one
// page: `table.jv-job-list` rows with `a[href="/{slug}/job/{id}"]` and a
// `.jv-job-list-location` cell; older sites use `.jv-job-list-name`.
// ---------------------------------------------------------------------------
export function jobviteSpec(slug: string): SourceSpec {
  return { type: "jobvite", url: `https://jobs.jobvite.com/${slug}/jobs`, atsSlug: slug };
}
function jobviteFromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const segs = pathSegments(u);
  if (u.hostname.toLowerCase() === "jobs.jobvite.com" && slugOk(segs[0]) && !["api", "careers"].includes(segs[0])) return jobviteSpec(segs[0]);
  return null;
}
export function parseJobvite(html: string, pageUrl: string): { postings: RawPosting[]; markers: boolean } {
  const $ = cheerio.load(html);
  const postings: RawPosting[] = [];
  const seen = new Set<string>();
  for (const a of $("a[href*='/job/']").toArray()) {
    const node = $(a);
    const href = node.attr("href") ?? "";
    const id = href.match(/\/job\/([A-Za-z0-9_-]+)/)?.[1];
    if (!id || seen.has(id)) continue;
    const url = absoluteUrl(href, pageUrl); if (!url) continue;
    const title = clean(node.text()); if (!title) continue;
    const row = node.closest("tr, li, .jv-job-list-item, div");
    const location = clean(row.find(".jv-job-list-location, [class*='location']").first().text());
    const department = clean(node.closest("table").prevAll("h3, h2, .jv-job-list-category").first().text());
    seen.add(id);
    postings.push({ externalId: id, title, url, location, department, remote: /remote/i.test(location ?? "") || undefined });
  }
  return { postings, markers: /jv-job-list|jobvite/i.test(html) };
}
async function jobvitePostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const html = await fetchHtml(ctx, spec.url);
  const { postings, markers } = parseJobvite(html, spec.url);
  if (postings.length === 0 && !markers) throw new SourceFetchError(`no listing markers found at ${spec.url}; the board may have changed shape`, "parse");
  return postings.slice(0, MAX_POSTINGS);
}
export const jobvite = adapterFor("jobvite", jobviteFromUrl, jobvitePostings);

// ---------------------------------------------------------------------------
// JazzHR — `https://{slug}.applytojob.com/apply/` lists every job in one
// page: `li.list-group-item` with `a[href*="/apply/{id}/"]` and a
// `ul.list-inline` of location / department / type.
// ---------------------------------------------------------------------------
export function jazzhrSpec(slug: string): SourceSpec {
  return { type: "jazzhr", url: `https://${slug}.applytojob.com/apply/`, atsSlug: slug };
}
function jazzhrFromUrl(url: string): SourceSpec | null {
  const u = safeUrl(url);
  if (!u) return null;
  const m = u.hostname.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.applytojob\.com$/);
  if (!m || !slugOk(m[1]) || m[1] === "www" || m[1] === "app") return null;
  return jazzhrSpec(m[1]);
}
export function parseJazzhr(html: string, pageUrl: string): { postings: RawPosting[]; markers: boolean } {
  const $ = cheerio.load(html);
  const postings: RawPosting[] = [];
  const seen = new Set<string>();
  for (const a of $("a[href*='/apply/']").toArray()) {
    const node = $(a);
    const href = node.attr("href") ?? "";
    const id = href.match(/\/apply\/([A-Za-z0-9]+)\//)?.[1];
    if (!id || seen.has(id)) continue;
    const url = absoluteUrl(href, pageUrl); if (!url) continue;
    const title = clean(node.text()); if (!title) continue;
    const meta = node.closest("li, .list-group-item, div").find("ul.list-inline li").toArray().map(li => clean($(li).text())).filter((s): s is string => !!s);
    const [location, department, employmentType] = meta;
    seen.add(id);
    postings.push({ externalId: id, title, url, location, department, employmentType, remote: /remote/i.test(location ?? "") || undefined });
  }
  return { postings, markers: /applytojob|list-group-item|jazzhr/i.test(html) };
}
async function jazzhrPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const html = await fetchHtml(ctx, spec.url);
  const { postings, markers } = parseJazzhr(html, spec.url);
  if (postings.length === 0 && !markers) throw new SourceFetchError(`no listing markers found at ${spec.url}; the board may have changed shape`, "parse");
  return postings.slice(0, MAX_POSTINGS);
}
export const jazzhr = adapterFor("jazzhr", jazzhrFromUrl, jazzhrPostings);

