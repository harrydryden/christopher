import * as cheerio from "cheerio";
import type { HtmlRecipe, RawPosting } from "../types";
import { absoluteUrl, normalizeUrl } from "../normalize";
import { extractJsonLdPostings } from "./jsonld";

const JOB_PATH_RE =
  /\/(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|opportunit(?:y|ies)|roles?|apply|job-details?|joblisting)\/|[?&](?:gh_jid|jobId|job_id|reqId|requisitionId)=/i;
const ATS_HOST_RE =
  /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|personio\.(?:de|com)|bamboohr\.com|myworkdayjobs\.com|pinpointhq\.com|breezy\.hr|teamtailor\.com|icims\.com|jobvite\.com|applytojob\.com|rippling\.com|grnh\.se)$/i;

// These are listing, subscription or careers-content destinations, never posting-detail slugs.
// Exact segment matching preserves genuine titles such as `/jobs/benefits-lead`.
const NON_DETAIL_LAST_SEGMENT_RE =
  /^(?:search|listings?|all-jobs?|open-jobs?|feed|rss|compatibility|emerging-talent|benefits?|teams?|locations?)$/i;

const NAV_TEXT_RE =
  /^(careers?|jobs?|all (?:jobs|roles|openings|positions)|view all(?: jobs| roles| openings)?|see (?:all|open) (?:jobs|roles|positions|openings)|open (?:roles|positions|jobs)|apply(?: now)?|learn more|read more|find out more|back(?: to .*)?|home|search|our team|join us|join the team|next|previous|more|show more|load more|view openings|browse jobs|filter|sort|menu|close)$/i;

const LOCATION_HINT_RE =
  /(remote|hybrid|on-?site|,\s*[A-Z]{2}\b|,\s*(?:UK|USA|US|UAE)\b|london|new york|san francisco|berlin|paris|amsterdam|dublin|singapore|sydney|toronto|austin|seattle|boston|chicago|denver|los angeles|washington|manchester|edinburgh|cambridge|oxford|bristol|leeds|glasgow|tel aviv|bangalore|tokyo|madrid|barcelona|munich|zurich|stockholm|copenhagen|milan|lisbon|warsaw|dubai|costa mesa|irvine|el segundo|reston|arlington)/i;

const EXPLICIT_EMPTY_LISTING_RE = /^(?:sorry[,!]?\s*)?(?:(?:we\s+)?(?:do(?:n['’]t| not)\s+have|have no)\s+(?:any\s+)?(?:current\s+)?(?:job\s+)?(?:openings?|roles?|positions?|vacancies|jobs?)\s+(?:right now|at (?:this|the) (?:time|moment)|currently)|there are\s+(?:currently\s+)?no\s+(?:current\s+)?(?:job\s+)?(?:openings?|roles?|positions?|vacancies|jobs?)(?:\s+(?:right now|at (?:this|the) (?:time|moment)|currently))?)[.!]?$/i;

export interface JobLink {
  url: string;
  text: string;
  context: string;
  location?: string;
}

function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
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
      && /\b(?:(?:all|search)\s+(?:open\s+)?(?:jobs?|roles?|positions?|vacancies|opportunities)|(?:view|explore|browse|see)\s+(?:all\s+)?(?:open\s+)?(?:jobs?|roles?|positions?|vacancies|opportunities))\b/i.test(text)
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
  return true;
}

function isJobHref(url: string, pageUrl: string): boolean {
  try {
    if (ATS_HOST_RE.test(new URL(url).hostname)) return true;
  } catch {
    return false;
  }
  if (!JOB_PATH_RE.test(url)) return false;
  const norm = normalizeUrl(url);
  if (norm === normalizeUrl(pageUrl)) return false;
  try {
    // A bare listing root such as /careers or /jobs is not a job detail page.
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length <= 1 && !u.search) return false;
    if (NON_DETAIL_LAST_SEGMENT_RE.test(segs.at(-1) ?? "")) return false;
  } catch {
    return false;
  }
  return true;
}

function containerOf($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]) {
  const node = $(el);
  const container = node.closest("li, article, tr, .job, .position, .opening, [class*='job'], [class*='role'], [class*='posting']");
  return container.length ? container : node.parent();
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
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    // Navigation paths often sit below `/careers/` and therefore resemble job-detail URLs. The
    // element's semantic container is stronger evidence than words such as "Benefits" or
    // "Overview", which could also be legitimate role titles outside navigation.
    if (isGlobalChrome($, el)) return;
    const href = $(el).attr("href");
    if (!href) return;
    const abs = absoluteUrl(href, pageUrl);
    if (!abs) return;
    const text = cleanLinkText($(el).text()) || cleanLinkText($(el).attr("aria-label")) || cleanLinkText($(el).attr("title"));
    if (!looksLikeTitle(text)) return;
    if (!isJobHref(abs, pageUrl)) return;
    const key = normalizeUrl(abs);
    if (seen.has(key)) return;
    seen.add(key);
    const container = containerOf($, el);
    const context = cleanText(container.text()).replace(text, "").slice(0, 160);
    // Prefer an explicit field on this posting card to flattened card prose, which can join a
    // location and department (for example "Remote US Core Services") into one false location.
    const location = cleanText(container.attr("data-location")) || cleanText(container.find("[data-location]").first().attr("data-location"))
      || cleanText(container.find(".location, .job-location, .loc, [itemprop='jobLocation']").first().text());
    out.push({ url: abs, text, context, ...(location ? { location } : {}) });
  });
  return out;
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
  const seen = new Set<string>();
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
    if (seen.has(key)) return;
    seen.add(key);
    const location = recipe.location ? cleanText(item.find(recipe.location).first().text()) || undefined : undefined;
    const department = recipe.department ? cleanText(item.find(recipe.department).first().text()) || undefined : undefined;
    out.push({ title, url, location, department, remote: location ? /remote/i.test(location) || undefined : undefined });
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
    return {
      title: link.text,
      url: link.url,
      location,
      remote: location ? /remote/i.test(location) || undefined : undefined,
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
    if (!explicit && !/^(next(?: page)?|older (?:jobs|posts)|next [›»→])$/i.test(label)) continue;
    if (node.attr("aria-disabled") === "true") continue;
    const target = absoluteUrl(node.attr("href") ?? "", pageUrl);
    if (target && new URL(target).origin === new URL(pageUrl).origin && normalizeUrl(target) !== normalizeUrl(pageUrl)) return target;
  }
  return null;
}
