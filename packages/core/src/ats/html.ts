import * as cheerio from "cheerio";
import type { HtmlRecipe, RawPosting } from "../types";
import { absoluteUrl, normalizeUrl } from "../normalize";
import { extractJsonLdPostings } from "./jsonld";

const JOB_PATH_RE =
  /\/(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|opportunit(?:y|ies)|roles?|apply|job-details?|joblisting)\/|[?&](?:gh_jid|jobId|job_id|reqId|requisitionId)=/i;
const ATS_HOST_RE =
  /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|personio\.(?:de|com)|bamboohr\.com|myworkdayjobs\.com|pinpointhq\.com|breezy\.hr|teamtailor\.com|icims\.com|jobvite\.com|applytojob\.com|rippling\.com|grnh\.se)/i;

const NAV_TEXT_RE =
  /^(careers?|jobs?|all (?:jobs|roles|openings|positions)|view all(?: jobs| roles| openings)?|see (?:all|open) (?:jobs|roles|positions|openings)|open (?:roles|positions|jobs)|apply(?: now)?|learn more|read more|find out more|back(?: to .*)?|home|search|our team|join us|join the team|next|previous|more|show more|load more|view openings|browse jobs|filter|sort|menu|close)$/i;

const LOCATION_HINT_RE =
  /(remote|hybrid|on-?site|,\s*[A-Z]{2}\b|,\s*(?:UK|USA|US|UAE)\b|london|new york|san francisco|berlin|paris|amsterdam|dublin|singapore|sydney|toronto|austin|seattle|boston|chicago|denver|los angeles|washington|manchester|edinburgh|cambridge|oxford|bristol|leeds|glasgow|tel aviv|bangalore|tokyo|madrid|barcelona|munich|zurich|stockholm|copenhagen|milan|lisbon|warsaw|dubai|costa mesa|irvine|el segundo|reston|arlington)/i;

export interface JobLink {
  url: string;
  text: string;
  context: string;
}

function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function looksLikeTitle(text: string): boolean {
  const t = cleanText(text);
  if (t.length < 2 || t.length > 120) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (NAV_TEXT_RE.test(t)) return false;
  return true;
}

function isJobHref(url: string, pageUrl: string): boolean {
  if (ATS_HOST_RE.test(url)) return true;
  if (!JOB_PATH_RE.test(url)) return false;
  const norm = normalizeUrl(url);
  if (norm === normalizeUrl(pageUrl)) return false;
  try {
    // A bare listing root such as /careers or /jobs is not a job detail page.
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length <= 1 && !u.search) return false;
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

export function findJobLinks(html: string, pageUrl: string): JobLink[] {
  const $ = cheerio.load(html);
  const out: JobLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const abs = absoluteUrl(href, pageUrl);
    if (!abs) return;
    const text = cleanText($(el).text()) || cleanText($(el).attr("aria-label")) || cleanText($(el).attr("title"));
    if (!looksLikeTitle(text)) return;
    if (!isJobHref(abs, pageUrl)) return;
    const key = normalizeUrl(abs);
    if (seen.has(key)) return;
    seen.add(key);
    const container = containerOf($, el);
    const context = cleanText(container.text()).replace(text, "").slice(0, 160);
    out.push({ url: abs, text, context });
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
  const hit = expected.filter((e) => producedUrls.has(normalizeUrl(e.url))).length;
  const coverage = hit / expected.length;
  return { ok: coverage >= 0.9, coverage };
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
    const location = locationFromContext(link.context);
    return {
      title: link.text,
      url: link.url,
      location,
      remote: location ? /remote/i.test(location) || undefined : undefined,
    };
  });
}

/** Compact representation of a page for model extraction, plus every anchor URL for anti-hallucination checks. */
export function compactDomForModel(html: string, pageUrl: string, maxChars = 60_000): { text: string; knownUrls: string[] } {
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
    lines.push(`[${index++}] ${text} | ${abs}${context ? ` | ${context}` : ""}`);
  });
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…truncated…`;
  return { text, knownUrls };
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
