import * as cheerio from "cheerio";
import type { HtmlRecipe, RawPosting } from "../types";
import { absoluteUrl, looksRemote, normalizeUrl } from "../normalize";
import { extractJsonLdPostings } from "./jsonld";
import { isAtsHost } from "./common";

const JOB_PATH_RE =
  /\/(?:jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|opportunit(?:y|ies)|roles?|apply|job-?details?|joblisting)\//i;
const JOB_QUERY_KEYS = new Set(["gh_jid", "jobid", "job_id", "reqid", "requisitionid"]);

/** A link label saying it leads to the complete listing: "All jobs", "Search roles", "View open positions". */
export const COMPLETE_LISTING_LABEL =
  /\b(?:(?:all|search)\s+(?:open\s+)?(?:jobs?|roles?|positions?|vacancies|opportunities)|(?:view|explore|browse|see)\s+(?:all\s+)?(?:open\s+)?(?:jobs?|roles?|positions?|vacancies|opportunities)|(?:jobs?|roles?|positions?|vacancies)\s+listings?)\b/i;

// These are listing, subscription or careers-content destinations, never posting-detail slugs.
// Exact segment matching preserves genuine titles such as `/jobs/benefits-lead`.
const NON_DETAIL_LAST_SEGMENT_RE =
  /^(?:search|listings?|all-jobs?|open-jobs?|feed|rss|compatibility|emerging-talent|benefits?|teams?|locations?|faqs?|support|help|legal|privacy|terms|polic(?:y|ies)|accessibility|code-of-conduct|accommodations?(?:-for-disability)?|(?:our-)?commitment-to-(?:applicants|candidates)|(?:working-on-)?diversity-and-inclus(?:ion|ivity)|culture-and-values(?:-at-[a-z0-9-]+)?|total-rewards|interview-guide|how-(?:we-hire|to-apply)|life-at-[a-z0-9-]+)$/i;

const NAV_TEXT_RE =
  /^(careers?|jobs?|all (?:jobs|roles|openings|positions)|view all(?: jobs| roles| openings)?|see (?:all|open) (?:jobs|roles|positions|openings)|open (?:roles|positions|jobs)|apply(?: now)?|learn more|read more|discover more|find out more|how to apply|back(?: to .*)?|home|search|our team|join us|join the team|next|previous|more|show more|load more|view openings|browse jobs|filter|sort|menu|close)$/i;
const INFORMATIONAL_CTA_RE = /^(?:learn|read|discover|explore|find out) more about\b/i;
const POLICY_LINK_TEXT_RE =
  /^(?:report (?:this|a) (?:content|page)|(?:faqs?|frequently asked questions)(?:\s*(?:&|and)\s*support)?|(?:review\s+)?accommodations? for disability|(?:our\s+)?code of conduct|(?:our\s+)?commitment to applicants?)$/i;
// Match the BrowserRenderer's expansion labels; detecting one in the HTTP page means that page
// alone cannot prove the whole listing, even when it already contains some role links.
const LOAD_MORE_TEXT_RE = /^(?:(?:load|show|view|see) more(?: (?:jobs|roles|positions|openings|results))?|more (?:jobs|roles|positions|openings))$/i;
const NEXT_TEXT_RE = /^(?:next(?: page| jobs| roles| results| pagination page)?(?:\s*[›»→>]+)?|go to next page(?:,\s*number\s*\d+)?)$/i;

const LOCATION_HINT_RE =
  /(remote|hybrid|on-?site|,\s*[A-Z]{2}\b|,\s*(?:UK|USA|US|UAE)\b|london|new york|san francisco|berlin|paris|amsterdam|dublin|singapore|sydney|toronto|austin|seattle|boston|chicago|denver|los angeles|washington|manchester|edinburgh|cambridge|oxford|bristol|leeds|glasgow|tel aviv|bangalore|tokyo|madrid|barcelona|munich|zurich|stockholm|copenhagen|milan|lisbon|warsaw|dubai|costa mesa|irvine|el segundo|reston|arlington)/i;

const EXPLICIT_EMPTY_LISTING_RE = /^(?:sorry[,!]?\s*)?(?:(?:we\s+)?(?:do(?:n['’]t| not)\s+have|have no)\s+(?:any\s+)?(?:current\s+)?(?:job\s+)?(?:openings?|roles?|positions?|vacancies|jobs?)\s+(?:right now|at (?:this|the) (?:time|moment)|currently)|there are\s+(?:currently\s+)?no\s+(?:current\s+)?(?:job\s+)?(?:openings?|roles?|positions?|vacancies|jobs?)(?:\s+(?:right now|at (?:this|the) (?:time|moment)|currently))?)[.!]?$/i;

export interface JobLink {
  url: string;
  text: string;
  context: string;
  location?: string;
  locations?: string[];
}

function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Find a usable expansion control in static HTML, including nested labels and accessible names. */
export function hasListingExpansionControl(html: string, pageUrl: string): boolean {
  const $ = cheerio.load(html);
  for (const element of $("button, a, [role='button']").toArray()) {
    const node = $(element);
    if (node.is(":disabled") || node.is("[disabled], [aria-disabled='true']") || node.closest("fieldset[disabled]").length) continue;
    if (node.is("[data-toggle='collapse'], [data-bs-toggle='collapse']")) continue;
    if (node.closest("template, [hidden], [aria-hidden='true']").length) continue;
    if (node.parents().addBack().toArray().some(parent => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test($(parent).attr("style") ?? ""))) continue;
    const label = cleanText(node.attr("aria-label") || node.text());
    if (label.length > 60 || !(LOAD_MORE_TEXT_RE.test(label) || NEXT_TEXT_RE.test(label) || node.attr("rel") === "next")) continue;
    const href = node.attr("href");
    if (href) {
      try {
        const target = new URL(href, pageUrl);
        // JavaScript pagination has no HTTP next URL. Its explicit, visible control still proves
        // that this static page is only a slice; the guarded browser may click it.
        if (target.protocol !== "javascript:" && target.origin !== new URL(pageUrl).origin) continue;
      }
      catch { return true; } // An unparseable candidate still requires browser verification.
    }
    return true;
  }
  return false;
}

/**
 * Prove that an unfiltered, first-party listing is intentionally empty. The page shape and scoped
 * statement are both required; a passing phrase in navigation, a footer, an archive or a filtered
 * result must never turn a failed parse into a successful zero-role observation.
 */
export function isExplicitEmptyListing(html: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.search) return false;
  const lastSegment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (!/^(?:careers?|jobs?|open-roles?|openings?|positions?|vacancies)$/i.test(lastSegment)) return false;

  const $ = cheerio.load(html);
  const declaresCompleteListing = $("a[href]").toArray().some(element => {
    const node = $(element);
    const text = cleanText(node.text() || node.attr("aria-label") || node.attr("title"));
    const target = absoluteUrl(node.attr("href") ?? "", url);
    return Boolean(target
      && COMPLETE_LISTING_LABEL.test(text)
      && normalizeUrl(target) !== normalizeUrl(url));
  });
  if (declaresCompleteListing) return false;

  return $("[class*='job'], [id*='job'], [class*='opening'], [id*='opening'], [class*='position'], [id*='position'], [class*='vacanc'], [id*='vacanc']")
    .toArray()
    .some(element => {
      const node = $(element);
      if (node.is("html, body, header, footer, nav") || node.closest("header, footer, nav, [role='navigation'], [role='banner'], [role='contentinfo']").length) return false;
      const text = cleanText(node.text());
      return text.length <= 240 && EXPLICIT_EMPTY_LISTING_RE.test(text);
    });
}

/** Screen-reader hints appended inside a link describe its target, not the role title. */
function cleanLinkText(s: string | undefined | null): string {
  return cleanText(s).replace(/\s*\(\s*opens in (?:a )?new (?:window|tab)\s*\)\s*$/i, "").trim();
}

function looksLikeTitle(text: string): boolean {
  const t = cleanText(text);
  if (t.length < 2 || t.length > 120) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (NAV_TEXT_RE.test(t)) return false;
  if (INFORMATIONAL_CTA_RE.test(t)) return false;
  if (POLICY_LINK_TEXT_RE.test(t)) return false;
  return true;
}

/** A role card's named title is more specific than the whole link, which may also wrap team and location. */
function linkTitle($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): string {
  const link = $(el);
  const named = link.find("h1, h2, h3, h4, h5, h6, [data-job-title], [itemprop='title'], [class*='job-title'], [class*='role-title'], [class*='position-title']").first();
  const title = cleanLinkText(named.text());
  if (named.length) return title;
  return cleanLinkText(link.text()) || cleanLinkText(link.attr("aria-label")) || cleanLinkText(link.attr("title"));
}

function isJobHref(url: string, pageUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // Query values may contain a whole `/jobs/` URL (for example an abuse report's report_url).
  // Only the destination's own pathname or a named requisition parameter can identify a job.
  const jobQuery = [...u.searchParams.keys()].some(key => JOB_QUERY_KEYS.has(key.toLowerCase()));
  if (!isAtsHost(u.hostname) && !JOB_PATH_RE.test(u.pathname) && !jobQuery) return false;
  const norm = normalizeUrl(url);
  if (norm === normalizeUrl(pageUrl)) return false;
  // Exact topic slugs are navigation/content pages, not a profession containing the same word.
  // Strip .html for company sites which publish both postings and help articles as HTML files.
  const segs = u.pathname.split("/").filter(Boolean);
  const last = (segs.at(-1) ?? "").replace(/\.html?$/i, "");
  if (segs.length <= 1 && !u.search) return false;
  if (NON_DETAIL_LAST_SEGMENT_RE.test(last)) return false;
  return true;
}

function containerOf($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]) {
  const node = $(el);
  let cursor = node.parent();
  let fallback = node;
  for (let depth = 0; depth < 8 && cursor.length; depth++, cursor = cursor.parent()) {
    const text = cleanText(cursor.text());
    if (text.length > 500) break;
    // A semantic article can contain a whole grid of jobs. Metadata in it belongs to this role
    // only if it contains one distinct posting destination; duplicate links to that role are OK.
    const destinations = new Set(cursor.find("a[href]").toArray().flatMap(anchor => {
      const href = $(anchor).attr("href") ?? "";
      const absolute = absoluteUrl(href, "https://listing.invalid/");
      return absolute && isJobHref(absolute, "https://listing.invalid/") ? [normalizeUrl(absolute)] : [];
    }));
    if (destinations.size > 1) break;
    if (destinations.size === 0) continue;
    const tag = cursor.get(0)?.tagName?.toLowerCase();
    const classes = cursor.attr("class") ?? "";
    const card = tag === "li" || tag === "article" || tag === "tr"
      || /(?:^|[-_\s])(?:job|role|position|opening|posting)(?:[-_\s]|$)/i.test(classes)
      && !/(?:^|[-_\s])(?:title|link)(?:[-_\s]|$)/i.test(classes);
    const location = cursor.is("[data-location]") || cursor.find(".location, .job-location, .loc, [itemprop='jobLocation'], [class*='location' i], [data-testid*='location' i], [data-location]").length > 0;
    if (card || location) return cursor;
    fallback = cursor;
  }
  return fallback;
}

function mergeLocationValues<T extends { location?: string; locations?: string[] }>(previous: T, location: string | undefined): void {
  if (!location) return;
  if (!previous.location) previous.location = location;
  const values = new Set([...(previous.locations ?? []), previous.location, location].filter((value): value is string => !!value));
  if (values.size > 1) previous.locations = [...values];
}

function isGlobalChrome($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): boolean {
  const node = $(el);
  if (node.closest("nav, [role='navigation'], [role='banner'], [role='contentinfo']").length) return true;
  if (!node.closest("header, footer").length) return false;
  // `header` is also the natural heading wrapper inside an article or job card. Only treat it as
  // site chrome when no posting-shaped container owns it.
  return !node.closest("article, tr, .job, .position, .opening, [class*='job'], [class*='role'], [class*='posting']").length;
}

export function findJobLinks(html: string, pageUrl: string): JobLink[] {
  const $ = cheerio.load(html);
  const out: JobLink[] = [];
  const seen = new Map<string, JobLink>();
  $("a[href]").each((_, el) => {
    // Navigation paths often sit below `/careers/` and therefore resemble job-detail URLs. The
    // element's semantic container is stronger evidence than words such as "Benefits" or
    // "Overview", which could also be legitimate role titles outside navigation.
    if (isGlobalChrome($, el)) return;
    const href = $(el).attr("href");
    if (!href) return;
    const abs = absoluteUrl(href, pageUrl);
    if (!abs) return;
    const text = linkTitle($, el);
    if (!looksLikeTitle(text)) return;
    if (!isJobHref(abs, pageUrl)) return;
    const key = normalizeUrl(abs);
    const container = containerOf($, el);
    const context = cleanText(container.text()).replace(text, "").slice(0, 160);
    // Prefer an explicit field on this posting card to flattened card prose, which can join a
    // location and department (for example "Remote US Core Services") into one false location.
    const locationField = container.find(".location, .job-location, .loc, [itemprop='jobLocation'], [class*='location' i], [data-testid*='location' i]")
      .toArray().map(field => cleanText($(field).text())).find(value => value.length > 0 && value.length <= 80);
    const location = cleanText(container.attr("data-location")) || cleanText(container.find("[data-location]").first().attr("data-location")) || locationField;
    const previous = seen.get(key);
    if (previous) { mergeLocationValues(previous, location); return; }
    const link: JobLink = { url: abs, text, context, ...(location ? { location } : {}) };
    seen.set(key, link);
    out.push(link);
  });
  return out;
}

/** A narrowly scoped distinct-role total, not page numbers or repeated location-row counts. */
export function advertisedDistinctJobTotal(html: string): number | undefined {
  const $ = cheerio.load(html);
  const totals = $(".ais-Stats-text").toArray().flatMap(element => {
    const match = cleanText($(element).text()).match(/^([\d,]+) jobs? available$/i);
    if (!match) return [];
    const count = Number(match[1]!.replaceAll(",", ""));
    return Number.isSafeInteger(count) && count >= 0 && count <= 100_000 ? [count] : [];
  });
  return totals.length ? Math.max(...totals) : undefined;
}

function locationFromContext(context: string): string | undefined {
  if (!context) return undefined;
  const pieces = context.split(/\s{2,}|·|\||•|•|\n/).map(cleanText).filter(Boolean);
  for (const piece of pieces) {
    if (piece.length <= 60 && LOCATION_HINT_RE.test(piece)) return piece;
  }
  const m = context.match(/([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+)/);
  if (m && m[1] && m[1].length <= 60) return cleanText(m[1]);
  if (/\bremote\b/i.test(context)) return "Remote";
  return undefined;
}

export function applyRecipe(html: string, pageUrl: string, recipe: HtmlRecipe): RawPosting[] {
  const $ = cheerio.load(html);
  const out: RawPosting[] = [];
  const seen = new Map<string, RawPosting>();
  $(recipe.listItem).each((_, el) => {
    const item = $(el);
    const titleEl = recipe.title === ":self" ? item : item.find(recipe.title).first();
    const linkEl = recipe.link === ":self" ? item : item.find(recipe.link).first();
    const title = cleanText(titleEl.text());
    const href = linkEl.attr("href");
    if (!title || !href) return;
    const url = absoluteUrl(href, pageUrl);
    if (!url) return;
    const key = normalizeUrl(url);
    const location = recipe.location ? cleanText(item.find(recipe.location).first().text()) || undefined : undefined;
    const department = recipe.department ? cleanText(item.find(recipe.department).first().text()) || undefined : undefined;
    const previous = seen.get(key);
    if (previous) { mergeLocationValues(previous, location); previous.remote ||= looksRemote(location) || undefined; return; }
    const posting = { title, url, location, department, remote: looksRemote(location) || undefined };
    seen.set(key, posting);
    out.push(posting);
  });
  return out;
}

export function validateRecipe(html: string, pageUrl: string, recipe: HtmlRecipe, expected: RawPosting[]): { ok: boolean; coverage: number } {
  let produced: RawPosting[] = [];
  try {
    produced = applyRecipe(html, pageUrl, recipe);
  } catch {
    return { ok: false, coverage: 0 };
  }
  if (produced.length === 0) return { ok: false, coverage: 0 };
  if (expected.length === 0) return { ok: false, coverage: 0 };
  const producedUrls = new Set(produced.map((p) => normalizeUrl(p.url)));
  const expectedUrls = new Set(expected.map(e => normalizeUrl(e.url)));
  const hit = [...expectedUrls].filter(url => producedUrls.has(url)).length;
  const coverage = hit / expectedUrls.size;
  const precision = hit / producedUrls.size;
  const expectedByUrl = new Map(expected.map(posting => [normalizeUrl(posting.url), posting]));
  const fieldText = (value: string | undefined) => cleanText(value).toLocaleLowerCase("en-GB");
  const fieldsAgree = produced.every(posting => {
    const reference = expectedByUrl.get(normalizeUrl(posting.url));
    if (!reference) return true; // Extra identities are handled by precision.
    return (["title", "location", "department"] as const).every(field => fieldText(posting[field]) === fieldText(reference[field]));
  });
  // Correct URLs do not justify persisting selectors that turn departments into locations or
  // whole cards into titles. Reuse must reproduce the observed fields as well as the identities.
  return { ok: coverage >= 0.9 && precision >= 0.98 && fieldsAgree, coverage };
}

export function extractPostingsFromHtml(html: string, pageUrl: string, recipe?: HtmlRecipe): RawPosting[] {
  if (recipe) {
    try {
      const viaRecipe = applyRecipe(html, pageUrl, recipe);
      if (viaRecipe.length > 0) return viaRecipe;
    } catch {
      /* fall through */
    }
  }
  const jsonld = extractJsonLdPostings(html, pageUrl);
  if (jsonld.length > 0) return jsonld;
  return findJobLinks(html, pageUrl).map((link) => {
    const location = link.location ?? locationFromContext(link.context);
    const remote = [location, ...(link.locations ?? [])].some(value => looksRemote(value)) || undefined;
    return {
      title: link.text,
      url: link.url,
      location,
      ...(link.locations?.length ? { locations: link.locations } : {}),
      remote,
    };
  });
}

function selectorAtom(node: cheerio.Cheerio<any>): string {
  const el = node.get(0);
  const tag = el?.tagName?.toLowerCase() || "*";
  const rawId = node.attr("id") ?? "";
  const id = rawId.length <= 80 ? cleanText(rawId) : "";
  if (id && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) return `${tag}#${id}`;
  const rawClasses = node.attr("class") ?? "";
  const classes = rawClasses.slice(0, 1_000).split(/\s+/).filter(value => value.length <= 80 && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)).slice(0, 2);
  const attributes = ["data-job-id", "data-location", "data-team", "data-department", "itemprop", "role"].filter(name => node.attr(name) !== undefined);
  return `${tag}${classes.map(value => `.${value}`).join("")}${attributes.map(name => `[${name}]`).join("")}`;
}

/** A selector made only from observed tag, id, class and bounded semantic-attribute names. */
function relativeSelector($: cheerio.CheerioAPI, item: cheerio.Cheerio<any>, child: cheerio.Cheerio<any>): string | undefined {
  if (!child.length || !item.length) return undefined;
  if (child.get(0) === item.get(0)) return ":self";
  const parts: string[] = [];
  let cursor = child.first();
  for (let depth = 0; depth < 4 && cursor.length && cursor.get(0) !== item.get(0); depth++) {
    parts.unshift(selectorAtom(cursor));
    cursor = cursor.parent();
  }
  return cursor.get(0) === item.get(0) ? parts.join(" > ") : undefined;
}

function firstField($: cheerio.CheerioAPI, item: cheerio.Cheerio<any>, pattern: RegExp): cheerio.Cheerio<any> {
  return item.find("[class], [itemprop], [data-field], [data-testid]").filter((_, element) => {
    const node = $(element);
    return pattern.test([node.attr("class"), node.attr("itemprop"), node.attr("data-field"), node.attr("data-testid")].filter(Boolean).map(value => String(value).slice(0, 200)).join(" "));
  }).first();
}

function structuralHint($: cheerio.CheerioAPI, anchor: cheerio.Cheerio<any>): string {
  let cursor = anchor.parent();
  let postingContainer = $();
  for (let depth = 0; depth < 8 && cursor.length; depth++) {
    const tag = cursor.get(0)?.tagName?.toLowerCase();
    const classes = (cursor.attr("class") ?? "").slice(0, 1_000);
    const classShapedContainer = (tag === "div" || tag === "section") && /(?:^|\s)(?:job|position|opening)(?:\s|$)|job|role|posting/i.test(classes);
    if (tag === "li" || tag === "article" || tag === "tr" || classShapedContainer) {
      postingContainer = cursor;
      break;
    }
    cursor = cursor.parent();
  }
  const item = postingContainer.length ? postingContainer : anchor.parent();
  const link = relativeSelector($, item, anchor) ?? selectorAtom(anchor);
  const table = item.closest("table");
  const headers = table.find("thead th").slice(0, 12).map((_, element) => cleanText($(element).text())).get();
  const cells = item.children("th, td").slice(0, 12).toArray();
  const columns = cells.map((element, index) => ({ header: headers[index] || undefined, selector: relativeSelector($, item, $(element)), text: cleanText($(element).text()) }));
  const columnNode = (pattern: RegExp) => {
    const index = headers.findIndex(header => pattern.test(header));
    return index >= 0 && cells[index] ? $(cells[index]) : $();
  };
  const locationNode = firstField($, item, /(?:^|[-_\s])(location|loc|city)(?:$|[-_\s])/i).add(columnNode(/\b(location|place|office)\b/i)).first();
  const departmentNode = firstField($, item, /(?:^|[-_\s])(department|dept|team|function|category)(?:$|[-_\s])/i).add(columnNode(/\b(department|team|function|category)\b/i)).first();
  const fields = [locationNode, departmentNode].filter(node => node.length).slice(0, 2).map(node => ({ selector: relativeSelector($, item, node), text: cleanText(node.text()) }));
  const children = item.children().slice(0, 8).map((_, element) => selectorAtom($(element))).get();
  return JSON.stringify({
    observed: true,
    item: selectorAtom(item),
    link,
    title: link,
    ...(relativeSelector($, item, locationNode) ? { location: relativeSelector($, item, locationNode) } : {}),
    ...(relativeSelector($, item, departmentNode) ? { department: relativeSelector($, item, departmentNode) } : {}),
    attributes: ["data-location", "data-team", "data-department", "data-type"].flatMap(name => cleanText(item.attr(name)) ? [{ name, text: cleanText(item.attr(name)) }] : []),
    children,
    columns,
    fields,
  });
}

/** Compact representation of a page for model extraction, plus every anchor URL for anti-hallucination checks. */
export function compactDomForModel(html: string, pageUrl: string, maxChars = 60_000): { text: string; knownUrls: string[]; truncated: boolean } {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, header, footer, nav").remove();
  const knownUrls: string[] = [];
  const seen = new Set<string>();
  const lines: string[] = [];
  let index = 0;
  $("h1, h2, h3, h4, a[href]").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
    if (tag.startsWith("h")) {
      const text = cleanText($(el).text());
      if (text && text.length <= 120) lines.push(`# ${text}`);
      return;
    }
    const href = $(el).attr("href");
    if (!href) return;
    const abs = absoluteUrl(href, pageUrl);
    if (!abs) return;
    const key = normalizeUrl(abs);
    if (!seen.has(key)) {
      seen.add(key);
      knownUrls.push(abs);
    }
    const text = cleanText($(el).text()) || cleanText($(el).attr("aria-label")) || "";
    const context = cleanText(containerOf($, el).text()).replace(text, "").slice(0, 80);
    const structure = structuralHint($, $(el));
    lines.push(`[${index++}] ${text} | ${abs}${context ? ` | ${context}` : ""} | DOM ${structure}`);
  });
  let text = lines.join("\n");
  const truncated = text.length > maxChars;
  const suffix = "\n…truncated…";
  if (truncated) text = maxChars <= suffix.length ? suffix.slice(0, maxChars) : `${text.slice(0, maxChars - suffix.length)}${suffix}`;
  return { text, knownUrls, truncated };
}

/** Follow only explicit same-origin pagination, never a job/apply link or an arbitrary numeric link. */
export function nextListingPage(html: string, pageUrl: string): string | null {
  const $ = cheerio.load(html);
  for (const element of $("a[rel~='next'], link[rel~='next'], a[href]").toArray()) {
    const node = $(element);
    const label = cleanText(node.attr("aria-label") || node.text());
    const explicit = (node.attr("rel") ?? "").split(/\s+/).includes("next");
    if (!explicit && !NEXT_TEXT_RE.test(label) && !/^older (?:jobs|posts)$/i.test(label)) continue;
    if (node.attr("aria-disabled") === "true") continue;
    const target = absoluteUrl(node.attr("href") ?? "", pageUrl);
    if (target && new URL(target).origin === new URL(pageUrl).origin && normalizeUrl(target) !== normalizeUrl(pageUrl)) return target;
  }
  return null;
}

/** An explicit next page that cannot be traversed under the same-origin listing policy. */
export function hasUnfollowableListingContinuation(html: string, pageUrl: string): boolean {
  let origin: string;
  try { origin = new URL(pageUrl).origin; }
  catch { return false; }
  const $ = cheerio.load(html);
  for (const element of $("link[rel~='next'], a[href]").toArray()) {
    const node = $(element);
    const relNext = (node.attr("rel") ?? "").split(/\s+/).some(value => value.toLowerCase() === "next");
    const label = cleanText(node.attr("aria-label") || node.text());
    const explicitLabel = /^(?:next (?:page|jobs|roles|results)(?:\s*[›»→>]+)?|go to next page(?:,\s*number\s*\d+)?|older (?:jobs|posts))$/i.test(label);
    const paginationContext = node.closest("nav[aria-label*='pagination' i], [class*='pagination' i], [id*='pagination' i]").length > 0;
    if (!relNext && !explicitLabel && !(paginationContext && NEXT_TEXT_RE.test(label))) continue;
    if (node.is("a")) {
      if (node.is("[disabled], [aria-disabled='true']") || node.closest("fieldset[disabled], template, [hidden], [aria-hidden='true']").length) continue;
      if (node.parents().addBack().toArray().some(parent => /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test($(parent).attr("style") ?? ""))) continue;
    }
    const target = absoluteUrl(node.attr("href") ?? "", pageUrl);
    if (target && new URL(target).origin !== origin) return true;
  }
  return false;
}
