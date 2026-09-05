import * as cheerio from "cheerio";
import { absoluteUrl, sameDomain } from "../normalize";
import type { HarvestedLink } from "./types";
import type { SourceSpec } from "../types";

export const CAREERS_VOCABULARY: readonly string[] = [
  "careers", "career", "jobs", "job openings", "open roles", "open positions", "open jobs", "openings", "opportunities",
  "vacancies", "positions", "join us", "join the team", "join our team", "work with us", "work for us", "we're hiring",
  "we are hiring", "hiring", "life at", "come work with us", "explore careers", "search jobs", "current openings",
  // non-English
  "karriere", "stellen", "stellenangebote", "jobangebote", "carrières", "carrieres", "emplois", "recrutement", "nous rejoindre",
  "empleo", "empleos", "trabaja con nosotros", "únete", "unete", "vacatures", "werken bij", "lavora con noi", "carriere",
  "carreiras", "vagas", "trabalhe conosco", "rekrytering", "lediga jobb",
];

export const WELL_KNOWN_PATHS: readonly string[] = [
  "/careers", "/careers/", "/careers/jobs", "/careers/open-roles", "/careers/openings", "/career", "/jobs", "/jobs/",
  "/join", "/join-us", "/joinus", "/work-with-us", "/work-for-us", "/company/careers", "/about/careers",
  "/about-us/careers", "/en/careers", "/vacancies", "/opportunities", "/open-roles", "/open-positions", "/positions",
  "/hiring", "/team/careers", "/life", "/en/jobs",
];

/** Kept local so discovery has no dependency on the adapter registry. */
const ATS_HOST_RE =
  /(?:^|\.)(greenhouse\.io|grnh\.se|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|personio\.(?:de|com)|bamboohr\.com|myworkdayjobs\.com|pinpointhq\.com|breezy\.hr)$/i;

function isAtsUrl(url: string): boolean {
  try {
    return ATS_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

const NEGATIVE_RE =
  /(privacy|terms|cookie|legal|imprint|impressum|disclaimer|login|log-in|sign-?in|sign-?up|blog|press|news|investor|shareholder|support|contact|help|faq|status|security|patent|trademark|accessibility|sitemap|rss|feed)/i;

const STRONG_TEXT = new Set(
  CAREERS_VOCABULARY.map((v) => v.toLowerCase()),
);

function textScore(text: string): number {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return 0;
  if (STRONG_TEXT.has(t)) return 0.8;
  for (const word of CAREERS_VOCABULARY) {
    if (t.includes(word)) return t.length <= word.length + 24 ? 0.7 : 0.45;
  }
  return 0;
}

function pathScore(url: string): number {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  } catch {
    return 0;
  }
  for (const known of WELL_KNOWN_PATHS) {
    const k = known.replace(/\/+$/, "") || "/";
    if (path === k) return 0.6;
  }
  // locale-prefixed variants such as /en-gb/careers
  if (/^\/[a-z]{2}(-[a-z]{2})?\/(careers?|jobs|join|vacancies|open-roles)(\/|$)/i.test(path)) return 0.6;
  if (/(^|\/)(careers?|jobs|join-us|open-roles|open-positions|vacancies|opportunities)(\/|$)/i.test(path)) return 0.5;
  if (/career|job|hiring|vacanc/i.test(path)) return 0.3;
  return 0;
}

export interface ScoreLinkOptions {
  resolveSpec?: (url: string) => SourceSpec | null;
}

export function scoreLink(link: HarvestedLink, pageUrl: string, opts: ScoreLinkOptions = {}): number {
  const href = link.href;
  if (!/^https?:/i.test(href)) return 0;
  if (opts.resolveSpec?.(href) || isAtsUrl(href)) return 1;
  if (NEGATIVE_RE.test(href) || NEGATIVE_RE.test(link.text)) return 0;
  // Score the link's own text. Surrounding text is used only for links with no text of their own
  // (icon links); otherwise one careers link in a nav would lift every sibling in that nav.
  const haystack = link.text.trim() ? link.text : (link.context ?? "");
  const t = textScore(haystack);
  const p = pathScore(href);
  if (t === 0 && p === 0) return 0;
  let score = Math.max(t, p);
  if (t > 0 && p > 0) score = Math.min(0.95, score + 0.1);
  if (sameDomain(href, pageUrl)) score = Math.min(1, score + 0.05);
  return Number(score.toFixed(3));
}

export function harvestLinks(html: string, pageUrl: string): HarvestedLink[] {
  const $ = cheerio.load(html);
  const out: HarvestedLink[] = [];
  const seen = new Set<string>();
  const push = (href: string | undefined, kind: string, text = "", context = "") => {
    if (!href) return;
    const abs = absoluteUrl(href, pageUrl);
    if (!abs) return;
    const key = `${kind}|${abs}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ href: abs, text: text.replace(/\s+/g, " ").trim().slice(0, 120), context: context.replace(/\s+/g, " ").trim().slice(0, 120) || undefined, kind });
  };

  $("a[href]").each((_, el) => {
    const node = $(el);
    const text = node.text() || node.attr("aria-label") || node.attr("title") || "";
    // Context is deliberately narrow: a card or list item the link sits in, never a whole nav bar.
    const item = node.closest("li, article, .card, [class*='card']");
    const context = item.length && item.find("a").length <= 3 ? item.text() : node.attr("aria-label") ?? node.attr("title") ?? "";
    push(node.attr("href"), "a", text, context);
  });
  $("iframe[src]").each((_, el) => push($(el).attr("src"), "iframe"));
  $("script[src]").each((_, el) => push($(el).attr("src"), "script"));
  $("link[href]").each((_, el) => push($(el).attr("href"), "link", $(el).attr("rel") ?? ""));
  $("meta[content]").each((_, el) => {
    const content = $(el).attr("content") ?? "";
    if (/^https?:\/\//i.test(content)) push(content, "meta", $(el).attr("property") ?? $(el).attr("name") ?? "");
  });
  return out;
}

export function extractMeta(html: string, pageUrl: string): { title?: string; siteName?: string; faviconUrl?: string } {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || undefined;
  const siteName = $('meta[property="og:site_name"]').attr("content")?.trim() || undefined;
  const iconHref =
    $('link[rel="icon"]').attr("href") ??
    $('link[rel="shortcut icon"]').attr("href") ??
    $('link[rel="apple-touch-icon"]').attr("href") ??
    $('link[rel="apple-touch-icon-precomposed"]').attr("href");
  let faviconUrl = iconHref ? absoluteUrl(iconHref, pageUrl) ?? undefined : undefined;
  if (!faviconUrl) {
    try {
      faviconUrl = new URL("/favicon.ico", pageUrl).toString();
    } catch {
      faviconUrl = undefined;
    }
  }
  return { title, siteName, faviconUrl };
}

export function countAnchors(html: string): number {
  return (html.match(/<a\s[^>]*href=/gi) ?? []).length;
}
