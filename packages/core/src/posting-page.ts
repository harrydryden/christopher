/**
 * Reading one posting out of its own page.
 *
 * A scan reads a listing; this reads a single detail page, for the role a follower pastes the URL
 * of because the scan never collected it. Nothing here calls a model: JSON-LD when the page
 * publishes it, otherwise the page's own metadata, so the model is a fallback the worker reaches
 * for afterwards rather than the first move.
 */
import * as cheerio from "cheerio";
import { extractJsonLdPostings } from "./ats/jsonld";
import { extractDomain, stripHtml } from "./normalize";

/** Pick the densest plausible main-content block from a job detail page. */
export function extractMainText(html: string): string | undefined {
  const candidates = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]+(?:id|class)="[^"]*(job-?description|posting|content|opening)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    const body = m?.[m.length - 1];
    if (body) {
      const text = stripHtml(body);
      if (text.length > 200) return text;
    }
  }
  const all = stripHtml(html);
  return all.length > 200 ? all : undefined;
}

export interface ExtractedPosting {
  title: string;
  location?: string;
  locations?: string[];
  department?: string;
  employmentType?: string;
  remote?: boolean;
  salaryText?: string;
  postedAt?: Date;
  descriptionText?: string;
  /** How it was read: the page's structured data, or its markup. */
  method: "jsonld" | "html";
}

const MAX_TITLE = 200;
const MAX_INLINE_LOCATION = 80;

const collapse = (value: string | undefined | null): string => (value ?? "").replace(/\s+/g, " ").trim();

function cleanTitle(raw: string | undefined | null): string | null {
  const title = collapse(raw).slice(0, MAX_TITLE).trim();
  return title.length >= 3 ? title : null;
}

/** Everything the page calls itself, against which a `Role | Company` suffix is judged. */
function siteNames($: cheerio.CheerioAPI, url: string): string[] {
  const declared = collapse($('meta[property="og:site_name"], meta[name="og:site_name"]').first().attr("content"));
  const label = extractDomain(url).split(".")[0] ?? "";
  return [declared, label].filter(Boolean);
}

const simplify = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * `Senior Engineer | Acme` is a title with the site's name appended by the page, not part of the
 * role. It is only removed when the tail really is the site's name: plenty of roles genuinely read
 * `Engineer - Remote` or `Head of Data | EMEA`, and cutting those would lose the distinguishing
 * half of the title.
 */
function stripSiteSuffix(title: string, names: string[]): string {
  const m = title.match(/^(.*\S)\s+(?:\||-|–|—|·|at)\s+(.+)$/);
  if (!m) return title;
  const head = collapse(m[1]);
  const tail = collapse(m[2]);
  if (head.length < 3 || !tail) return title;
  return names.some((name) => simplify(name) === simplify(tail)) ? head : title;
}

function pageTitle($: cheerio.CheerioAPI, url: string): string | null {
  const og = cleanTitle($('meta[property="og:title"], meta[name="og:title"]').first().attr("content"));
  if (og) return og;
  const documentTitle = collapse($("title").first().text());
  const stripped = cleanTitle(documentTitle ? stripSiteSuffix(documentTitle, siteNames($, url)) : "");
  if (stripped) return stripped;
  return cleanTitle($("h1").first().text());
}

function pageLocation($: cheerio.CheerioAPI): string | undefined {
  const meta = collapse($('meta[name="geo.placename"]').first().attr("content"));
  if (meta) return meta.slice(0, MAX_INLINE_LOCATION);
  const itemprop = $('[itemprop="jobLocation"]').first();
  const declared = collapse(itemprop.attr("content") ?? itemprop.text());
  if (declared && declared.length <= MAX_INLINE_LOCATION) return declared;
  for (const element of $('[class*="location" i], [id*="location" i]').toArray()) {
    const text = collapse($(element).text()).replace(/^location\s*[:\-–]\s*/i, "");
    if (text && text.length <= MAX_INLINE_LOCATION) return text;
  }
  return undefined;
}

/**
 * What the page says about the role, or null when it does not look like a posting at all — no
 * title worth the name is the one signal that survives every layout, and a row without one is
 * worse than no row.
 */
export function extractPostingFromPage(html: string, url: string): ExtractedPosting | null {
  const [structured] = extractJsonLdPostings(html, url);
  if (structured) {
    const title = cleanTitle(structured.title);
    if (title) {
      return {
        title,
        location: structured.location,
        locations: structured.locations,
        department: structured.department,
        employmentType: structured.employmentType,
        remote: structured.remote,
        salaryText: structured.salaryText,
        postedAt: structured.postedAt,
        descriptionText: structured.descriptionText ?? extractMainText(html),
        method: "jsonld",
      };
    }
  }
  const $ = cheerio.load(html);
  const title = pageTitle($, url);
  if (!title) return null;
  return {
    title,
    location: pageLocation($),
    descriptionText: extractMainText(html),
    method: "html",
  };
}
