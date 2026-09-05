import type { Adapter, FetchContext, RawPosting, SourceSpec, SourceType, VerifyResult } from "../types";
import { SourceFetchError } from "../types";
import { absoluteUrl } from "../normalize";
import { greenhouse } from "./greenhouse";
import { lever } from "./lever";
import { ashby } from "./ashby";
import { workable } from "./workable";
import { smartrecruiters, fetchSmartRecruitersDescription } from "./smartrecruiters";
import { recruitee } from "./recruitee";
import { personio } from "./personio";
import { bamboohr } from "./bamboohr";
import { workday } from "./workday";
import { pinpoint } from "./pinpoint";
import { breezy } from "./breezy";
import { extractPostingsFromHtml } from "./html";
import { extractJsonLdPostings } from "./jsonld";
import { sample, slugOk, str } from "./common";
import type { HtmlRecipe } from "../types";

const structured: Adapter[] = [greenhouse, lever, ashby, workable, smartrecruiters, recruitee, personio, bamboohr, workday, pinpoint, breezy];

async function fetchHtmlPage(spec: SourceSpec, ctx: FetchContext, forceBrowser = false): Promise<{ html: string; url: string; method: "http" | "browser" }> {
  if (!forceBrowser) {
    const res = await ctx.fetchText(spec.url);
    if (res.status >= 400) throw new SourceFetchError(`HTTP ${res.status} from ${spec.url}`, res.status === 403 || res.status === 429 ? "blocked" : "http", res.status);
    return { html: res.body, url: res.url, method: "http" };
  }
  if (!ctx.render) throw new SourceFetchError("browser rendering unavailable", "network");
  const rendered = await ctx.render(spec.url, { scrollAndExpand: true });
  return { html: rendered.html, url: rendered.finalUrl, method: "browser" };
}

function htmlLikeAdapter(type: Extract<SourceType, "html" | "jsonld" | "rss">): Adapter {
  return {
    type,
    specFromUrl: () => null,
    async fetchPostings(spec, ctx) {
      if (type === "rss") return fetchRssPostings(spec, ctx);
      const { html, url } = await fetchHtmlPage(spec, ctx);
      return type === "jsonld" ? extractJsonLdPostings(html, url) : extractPostingsFromHtml(html, url, spec.recipe as HtmlRecipe | undefined);
    },
    async verify(spec, ctx): Promise<VerifyResult> {
      try {
        const postings = await this.fetchPostings(spec, ctx);
        return { ok: postings.length > 0, count: postings.length, sample: sample(postings) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  };
}

async function fetchRssPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const res = await ctx.fetchText(spec.apiUrl ?? spec.url, { headers: { accept: "application/rss+xml,application/xml,text/xml" } });
  if (res.status >= 400) throw new SourceFetchError(`HTTP ${res.status} from ${spec.url}`, "http", res.status);
  const items = [...res.body.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const out: RawPosting[] = [];
  for (const item of items) {
    const title = str(item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, ""));
    const link =
      str(item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]) ??
      str(item.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1]) ??
      str(item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1]);
    if (!title || !link) continue;
    const url = absoluteUrl(link.trim(), spec.url);
    if (!url) continue;
    const pub = str(item.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/\1>/i)?.[2]);
    out.push({ title: title.trim(), url, postedAt: pub ? new Date(pub) : undefined });
  }
  return out.filter((p) => !p.postedAt || !isNaN(p.postedAt.getTime()));
}

export const adapters: Adapter[] = [...structured, htmlLikeAdapter("html"), htmlLikeAdapter("jsonld"), htmlLikeAdapter("rss")];

const byType = new Map<SourceType, Adapter>(adapters.map((a) => [a.type, a]));

export function getAdapter(type: SourceType): Adapter {
  const adapter = byType.get(type);
  if (!adapter) throw new Error(`unknown source type: ${type}`);
  return adapter;
}

export function specFromAnyUrl(url: string): SourceSpec | null {
  for (const adapter of structured) {
    const spec = adapter.specFromUrl(url);
    if (spec) return spec;
  }
  return null;
}

const ATS_HOST_SUFFIXES = [
  "greenhouse.io", "grnh.se", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com", "recruitee.com",
  "personio.de", "personio.com", "bamboohr.com", "myworkdayjobs.com", "pinpointhq.com", "breezy.hr",
];

export function isAtsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ATS_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// Matches URLs in HTML and in JavaScript sources, where slashes are often escaped as \/.
const URL_RE = /(?:https?:(?:\\?\/){2}|\/\/)[A-Za-z0-9._~-]+\.[A-Za-z]{2,}(?:(?:\\?\/)[^\s"'<>`\\),;]*)*(?:\?[^\s"'<>`\\),;]*)?/g;
const EMBED_PATTERNS: Array<{ re: RegExp; build: (slug: string) => SourceSpec | null }> = [
  { re: /job_board\?[^"'\s]*\bfor=([A-Za-z0-9._-]+)/g, build: (s) => greenhouse.specFromUrl(`https://boards.greenhouse.io/${s}`) },
  { re: /["']?boardToken["']?\s*:\s*["']([A-Za-z0-9._-]+)["']/g, build: (s) => greenhouse.specFromUrl(`https://boards.greenhouse.io/${s}`) },
  { re: /Grnhse\.Settings\s*=\s*\{[^}]*\bfor\s*:\s*["']([A-Za-z0-9._-]+)["']/g, build: (s) => greenhouse.specFromUrl(`https://boards.greenhouse.io/${s}`) },
  { re: /["']?jobBoardName["']?\s*:\s*["']([A-Za-z0-9._-]+)["']/g, build: (s) => ashby.specFromUrl(`https://jobs.ashbyhq.com/${s}`) },
  { re: /["']?leverSite["']?\s*:\s*["']([A-Za-z0-9._-]+)["']/g, build: (s) => lever.specFromUrl(`https://jobs.lever.co/${s}`) },
];

function specKey(spec: SourceSpec): string {
  return `${spec.type}|${spec.atsSlug ?? ""}|${spec.atsSite ?? ""}`;
}

/** Scan arbitrary HTML or JS for references to an ATS board. */
export function findAtsSpecsInText(text: string, baseUrl?: string): SourceSpec[] {
  const found = new Map<string, SourceSpec>();
  for (const match of text.matchAll(URL_RE)) {
    let raw = match[0].replace(/\\\//g, "/");
    if (raw.startsWith("//")) raw = `https:${raw}`;
    const spec = specFromAnyUrl(raw);
    if (spec) found.set(specKey(spec), spec);
  }
  for (const { re, build } of EMBED_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const slug = match[1];
      if (!slugOk(slug)) continue;
      const spec = build(slug);
      if (spec) found.set(specKey(spec), spec);
    }
  }
  if (baseUrl) {
    const spec = specFromAnyUrl(baseUrl);
    if (spec) found.set(specKey(spec), spec);
  }
  return [...found.values()];
}

/** Some ATSs keep the description behind a second call; this returns it when supported. */
export async function fetchDescriptionFor(spec: SourceSpec, posting: RawPosting, ctx: FetchContext): Promise<string | undefined> {
  if (spec.type === "smartrecruiters") return fetchSmartRecruitersDescription(spec, posting, ctx);
  return undefined;
}

export { fetchHtmlPage };
