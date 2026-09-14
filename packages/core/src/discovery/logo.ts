import type { FetchContext } from "../types";
import * as cheerio from "cheerio";
import { absoluteUrl } from "../normalize";

/** Lightweight website branding lookup, independent of careers discovery and browser rendering. */
export async function discoverCompanyLogo(homepageUrl: string, ctx: FetchContext): Promise<string | null> {
  const page = await ctx.fetchText(homepageUrl, { timeoutMs: 10000, maxBodyBytes: 2000000 });
  if (page.status < 200 || page.status >= 300) throw new Error(`Logo homepage returned HTTP ${page.status}`);
  const $ = cheerio.load(page.body);
  // Touch icons have a solid background; transparent favicons can be white-only
  // (Anduril) or switch colour with the OS theme, disappearing on our light UI.
  const declared = [
    ...$('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]').toArray(),
    ...$('link[rel~="icon"]').toArray(),
  ].map(element => absoluteUrl($(element).attr("href") ?? "", page.url));
  const fallback = new URL("/favicon.ico", page.url).toString();
  for (const url of new Set([...declared, fallback])) {
    if (!url || !/^https?:\/\//i.test(url)) continue;
    try {
      let icon = await ctx.fetchText(url, { method: "HEAD", timeoutMs: 5000, maxBodyBytes: 262144 });
      if (icon.status === 405 || icon.status === 501) {
        icon = await ctx.fetchText(url, { timeoutMs: 5000, maxBodyBytes: 262144 });
      }
      if (icon.status >= 200 && icon.status < 300 && /^image\//i.test(icon.headers["content-type"] ?? "")) return icon.url;
    } catch { /* Try the standard icon if the declared asset is unavailable. */ }
  }
  return null;
}
