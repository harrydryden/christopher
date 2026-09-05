import { createHash } from "node:crypto";
import type { RawPosting } from "./types";

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gh_src", "lever-source", "lever_source", "source", "src", "ref", "referrer", "fbclid", "gclid", "mc_cid", "mc_eid",
  "_ga", "_gl", "trk", "trackingid", "tracking_id",
]);

/** Canonicalise a URL for identity purposes. Keeps identifying params such as gh_jid. */
export function normalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return input.trim();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  const keep: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    keep.push([k, v]);
  }
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[^\p{L}\p{N}\s\-/&+]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/** Stable identity of a posting within a source. */
export function deriveExternalKey(p: Pick<RawPosting, "externalId" | "url" | "title" | "location">): string {
  if (p.externalId && p.externalId.trim()) return `id:${p.externalId.trim()}`;
  if (p.url && p.url.trim()) return `url:${normalizeUrl(p.url)}`;
  return `hash:${sha1(`${normalizeTitle(p.title)}|${(p.location ?? "").toLowerCase().trim()}`)}`;
}

const SECOND_LEVEL = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.kr", "com.br", "com.mx", "com.ar", "co.za", "com.sg",
  "com.hk", "co.in", "co.il", "com.tr", "com.cn", "co.id", "com.my",
]);

/** eTLD+1-ish domain used as a company identity. `https://www.careers.acme.co.uk/x` -> `acme.co.uk`. */
export function extractDomain(url: string): string {
  let host: string;
  try {
    host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
  host = host.replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (SECOND_LEVEL.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}

export function ensureHttpUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty url");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  if (!/^https?:$/.test(u.protocol)) throw new Error("unsupported protocol");
  return u.toString();
}

export function sameDomain(a: string, b: string): boolean {
  try {
    return extractDomain(a) === extractDomain(b);
  } catch {
    return false;
  }
}

export function absoluteUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function parseDate(value: unknown): Date | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    if (/^\d{10,13}$/.test(s)) return parseDate(Number(s));
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/** "Posted 3 Days Ago" / "Posted Today" / "Posted Yesterday" / "Posted 30+ Days Ago" (Workday style) -> Date. */
export function parseRelativePosted(text: string, now: Date = new Date()): Date | undefined {
  const t = text.toLowerCase();
  if (/today/.test(t)) return new Date(now);
  if (/yesterday/.test(t)) return new Date(now.getTime() - 86_400_000);
  const m = t.match(/(\d+)\+?\s*(day|week|month|hour)s?\s*ago/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === "hour" ? 3_600_000 : unit === "day" ? 86_400_000 : unit === "week" ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(now.getTime() - n * ms);
}

const REMOTE_RE = /\b(remote|work from home|wfh|anywhere|distributed|telecommute|home[- ]based)\b/i;

export function looksRemote(text: string | undefined | null): boolean {
  return !!text && REMOTE_RE.test(text);
}
