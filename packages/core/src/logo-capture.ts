/**
 * Capturing a company's logo as bytes.
 *
 * The worker used to keep an icon's address and let every page load it for itself. That was not
 * enough: some sites hand an icon to a browser and refuse ours, others 404 a month later, so what
 * a page showed depended on who was asking and when — the roles table and the company page
 * disagreed about the same company. This reads the icon itself, so the worker stores it once and
 * every page serves the same image. Here nothing is trusted: not the server's content-type (a 404
 * HTML page is served as `image/png` often enough), not the size, not the declared link.
 *
 * Pure and network-free: the fetchers arrive on the `FetchContext`.
 */
import * as cheerio from "cheerio";
import { absoluteUrl } from "./normalize";
import type { FetchContext, FetchInit } from "./types";

/** Half a megabyte. An icon is a few kilobytes; anything larger is a hero image or a mistake. */
export const LOGO_MAX_BYTES = 512 * 1024;

/** Kept identical to `LOGO_SOURCES` in @christopher/db — core cannot import the schema. */
export const LOGO_SOURCES = ["site_icon", "icon_service"] as const;
export type LogoSource = (typeof LOGO_SOURCES)[number];

export interface CapturedLogo {
  bytes: Uint8Array;
  /** Sniffed from the bytes, never taken from the response. */
  contentType: string;
  source: LogoSource;
  /** Where the bytes came from, kept as the browser's fallback and to explain a capture. */
  sourceUrl: string;
}

/** Nothing usable was found. `tried` is every URL attempted with the reason it was rejected. */
export class LogoCaptureError extends Error {
  constructor(message: string, readonly tried: string[]) {
    super(message);
    this.name = "LogoCaptureError";
  }
}

const ICON_SERVICE_HOSTS = ["icons.duckduckgo.com", "www.google.com", "google.com"];

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

/**
 * The MIME type the bytes actually are, or null when they are not an image we recognise.
 *
 * This is the check that keeps a login wall, an HTML 404 page or an empty body out of the logo
 * table: hosts label those `image/x-icon` all the time, so the response's content-type decides
 * nothing here.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  // SVG is text: a byte-order mark and whitespace may precede the root element, and a document
  // may open with an XML declaration or a doctype before it.
  const head = Buffer.from(bytes.subarray(0, 512)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^<svg[\s>]/i.test(head)) return "image/svg+xml";
  if (/^<\?xml[\s?]/i.test(head) && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

function iconHost(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "");
}

function sourceOf(url: string): LogoSource {
  try {
    return ICON_SERVICE_HOSTS.includes(new URL(url).hostname.toLowerCase()) ? "icon_service" : "site_icon";
  } catch {
    return "site_icon";
  }
}

/**
 * Every address worth trying for one company, best first: the icons the page declares (touch
 * icons before favicons — a touch icon has a solid background, while a transparent favicon can be
 * white-only or switch colour with the OS theme and vanish on our light interface), then the
 * conventional location, then the public icon services, which answer for a site that refuses us.
 */
export function logoCandidates(homepageHtml: string | null, pageUrl: string, domain: string): Array<{ url: string; source: LogoSource }> {
  const out: Array<{ url: string; source: LogoSource }> = [];
  const seen = new Set<string>();
  const push = (url: string | null, source: LogoSource) => {
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, source });
  };
  if (homepageHtml) {
    const $ = cheerio.load(homepageHtml);
    const declared = [
      ...$('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]').toArray(),
      ...$('link[rel~="icon"]').toArray(),
    ];
    for (const element of declared) push(absoluteUrl($(element).attr("href") ?? "", pageUrl), "site_icon");
  }
  try {
    push(new URL("/favicon.ico", pageUrl).toString(), "site_icon");
  } catch {
    /* an unusable page URL leaves the conventional location out; the services still answer */
  }
  const host = iconHost(domain);
  if (host && /^[a-z0-9.-]+$/.test(host)) {
    push(`https://icons.duckduckgo.com/ip3/${host}.ico`, "icon_service");
    push(`https://www.google.com/s2/favicons?domain=${host}&sz=128`, "icon_service");
  }
  return out;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Read a company's logo: the homepage for what it declares, then each candidate until one
 * answers with something that really is an image.
 *
 * A homepage that refuses us is not a failure — bot protection answers 403 to the worker and
 * serves the icon to anyone — so the read is best-effort and the conventional location and the
 * icon services carry the rest. No browser render: the services cover exactly the case a render
 * would, at no cost.
 */
export async function captureCompanyLogo(
  homepageUrl: string,
  domain: string,
  ctx: FetchContext,
  opts: { previousUrl?: string | null } = {},
): Promise<CapturedLogo> {
  if (!ctx.fetchBytes) throw new LogoCaptureError("Binary fetch unavailable", []);
  const fetchBytes = (url: string, init?: FetchInit) => ctx.fetchBytes!(url, init);
  const tried: string[] = [];

  let html: string | null = null;
  let pageUrl = homepageUrl;
  try {
    const page = await ctx.fetchText(homepageUrl, { timeoutMs: 10_000, maxBodyBytes: 2_000_000 });
    if (page.status >= 200 && page.status < 300) {
      html = page.body;
      pageUrl = page.url || homepageUrl;
    } else {
      tried.push(`${homepageUrl}: HTTP ${page.status}`);
    }
  } catch (error) {
    tried.push(`${homepageUrl}: ${reason(error)}`);
  }

  const candidates = logoCandidates(html, pageUrl, domain);
  // What was captured last time is the best guess going in: it worked once, and re-storing the
  // same asset keeps a refresh from drifting to a different icon for no reason.
  if (opts.previousUrl && /^https?:\/\//i.test(opts.previousUrl)) {
    const previous = { url: opts.previousUrl, source: sourceOf(opts.previousUrl) };
    candidates.unshift(previous);
    for (let i = candidates.length - 1; i > 0; i--) if (candidates[i]!.url === previous.url) candidates.splice(i, 1);
  }

  for (const candidate of candidates) {
    try {
      const res = await fetchBytes(candidate.url, { timeoutMs: 5_000, maxBodyBytes: LOGO_MAX_BYTES });
      if (res.status < 200 || res.status >= 300) {
        tried.push(`${candidate.url}: HTTP ${res.status}`);
        continue;
      }
      const bytes = res.bytes ?? new Uint8Array();
      if (bytes.length < 64) {
        tried.push(`${candidate.url}: ${bytes.length} bytes`);
        continue;
      }
      if (bytes.length > LOGO_MAX_BYTES) {
        tried.push(`${candidate.url}: ${bytes.length} bytes over the ${LOGO_MAX_BYTES} cap`);
        continue;
      }
      const contentType = sniffImageType(bytes);
      if (!contentType) {
        tried.push(`${candidate.url}: not an image`);
        continue;
      }
      return { bytes, contentType, source: candidate.source, sourceUrl: res.url || candidate.url };
    } catch (error) {
      tried.push(`${candidate.url}: ${reason(error)}`);
    }
  }
  throw new LogoCaptureError(`No usable icon found for ${domain}`, tried);
}

/**
 * How long to wait after a failed capture, by attempt number. A logo is decoration: a site that
 * is down, blocked or has no icon must not be asked again every day forever, but a site that was
 * merely down for an afternoon should be tried again that evening. One hour, six, a day, three
 * days, a week, then monthly.
 */
const LOGO_RETRY_DELAYS_MS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000, 3 * 86_400_000, 7 * 86_400_000, 30 * 86_400_000];

/** `attempts` is the count after the failure was recorded, so the first failure waits an hour. */
export function logoRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(Math.floor(attempts), 1), LOGO_RETRY_DELAYS_MS.length) - 1;
  return LOGO_RETRY_DELAYS_MS[index]!;
}
