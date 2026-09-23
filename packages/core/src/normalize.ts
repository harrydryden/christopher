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

/**
 * Tracking parameters stripped from a posting URL a person pasted. Deliberately shorter than
 * `TRACKING_PARAMS`: this is a URL someone will click, and the only safe thing to remove is what
 * is unambiguously a referral marker. Identifying parameters — `gh_jid`, `lever` ids, a Workday
 * job path — carry the posting and are kept, order and all.
 */
const POSTING_TRACKING_PARAMS = new Set(["ref", "source", "src", "gh_src", "lever-source", "fbclid", "gclid"]);

/**
 * Canonicalise a posting URL for identity: the same role pasted twice, once from a newsletter and
 * once from the board, must be one row. Scheme and host are lowercased (the URL parser does it),
 * the fragment goes, the referral parameters above and anything `utm_*` go, and a trailing slash
 * goes unless the path is the root. Everything else — parameters, their order, the port, the case
 * of the path — is kept, because on some boards it is the identifier.
 *
 * Distinct from `normalizeUrl`, which is the aggressive form used for an external key: that one
 * also sorts the query and strips a wider list, which is right for a key nobody sees and wrong
 * for a URL the interface links to.
 */
export function normalisePostingUrl(url: string): string {
  const trimmed = url.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const keep: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    const key = k.toLowerCase();
    if (key.startsWith("utm_") || POSTING_TRACKING_PARAMS.has(key)) continue;
    keep.push([k, v]);
  }
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

/**
 * The most characters of a page that a whole-page heuristic reads. Every such pattern is written to
 * run in linear time; this bounds that time too, so a hostile or broken page served at the fetcher's
 * body cap cannot hold the worker's event loop. Code that decides a listing's contents never
 * truncates: a short listing read as a complete one closes roles.
 */
export const MAX_SCANNED_TEXT = 2_000_000;

/** The part of `text` a whole-page heuristic may scan. */
export function scanWindow(text: string): string {
  return text.length > MAX_SCANNED_TEXT ? text.slice(0, MAX_SCANNED_TEXT) : text;
}

export interface ElementBlock {
  /** The element name as matched, lower-cased. */
  name: string;
  /** Index of the opening `<`. */
  start: number;
  /** Index just past the opening tag's `>`: where the content begins. */
  openEnd: number;
  /** Index of the closing tag's `<`: where the content ends. */
  closeStart: number;
  /** Index just past the closing tag. */
  end: number;
}

/**
 * Every `<name …>…</name>` block, earliest first, found in one linear pass. It matches what
 * `/<\s*(name)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi` matches, but that regex rescans the rest of the page
 * from every opening tag that is never closed, which is quadratic on a page of unclosed tags; here
 * the `>` after an opening tag and each closing tag are searched for once. `boundary` requires the
 * name to end there (`<item>`, not `<itemize>`).
 */
export function elementBlocks(html: string, names: readonly string[], opts: { boundary?: boolean; limit?: number } = {}): ElementBlock[] {
  const blocks: ElementBlock[] = [];
  const limit = opts.limit ?? Infinity;
  const opener = (open: readonly string[]) => new RegExp(`<\\s*(${open.join("|")})${opts.boundary ? "\\b" : ""}`, "gi");
  // A name with no closing tag after one of its opening tags has none after any later one either,
  // so it is dropped from the search.
  let open = names.map((name) => name.toLowerCase());
  let opening = opener(open);
  const closers = new Map<string, RegExp>();
  let gt = -1;
  let match: RegExpExecArray | null;
  while (blocks.length < limit && (match = opening.exec(html))) {
    const start = match.index;
    const name = (match[1] ?? "").toLowerCase();
    if (gt < opening.lastIndex) gt = html.indexOf(">", opening.lastIndex);
    if (gt < 0) break; // no opening tag after this point can end
    let closer = closers.get(name);
    if (!closer) {
      closer = new RegExp(`<\\/\\s*${name}\\s*>`, "gi");
      closers.set(name, closer);
    }
    closer.lastIndex = gt + 1;
    const close = closer.exec(html);
    if (!close) {
      open = open.filter((other) => other !== name);
      if (open.length === 0) break;
      opening = opener(open);
      opening.lastIndex = start + 1;
      continue;
    }
    const end = close.index + close[0].length;
    blocks.push({ name, start, openEnd: gt + 1, closeStart: close.index, end });
    opening.lastIndex = end;
  }
  return blocks;
}

/** `html` with each block replaced by `replacement`. */
function replaceBlocks(html: string, blocks: readonly ElementBlock[], replacement: string): string {
  if (blocks.length === 0) return html;
  const parts: string[] = [];
  let last = 0;
  for (const block of blocks) {
    parts.push(html.slice(last, block.start), replacement);
    last = block.end;
  }
  parts.push(html.slice(last));
  return parts.join("");
}

/**
 * `html.replace(/<[^>]+>/g, " ")` in one pass. That regex rescans the rest of the page from every
 * `<` that no `>` follows; once no `>` is left, nothing after can be a tag, so the scan stops.
 */
function tagsToSpaces(html: string): string {
  let out = "";
  let last = 0;
  let from = 0;
  let spaces = 0; // tags seen since the last text, each of which becomes one space
  for (;;) {
    const lt = html.indexOf("<", from);
    if (lt < 0) break;
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    if (gt === lt + 1) {
      from = gt; // "<>" is not a tag
      continue;
    }
    if (lt > last) {
      out += " ".repeat(spaces) + html.slice(last, lt);
      spaces = 0;
    }
    spaces++;
    last = from = gt + 1;
  }
  return out + " ".repeat(spaces) + html.slice(last);
}

/**
 * Exactly `.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ")`, in one
 * pass over each run of spaces, tabs and newlines. The first of those regexes rescans a long run of
 * spaces from each of its characters.
 */
function tidyWhitespace(text: string): string {
  let out = "";
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10) {
      i++;
      continue;
    }
    let end = i;
    let newlines = 0;
    let lastNewline = -1;
    for (; end < text.length; end++) {
      const d = text.charCodeAt(end);
      if (d === 10) {
        newlines++;
        lastNewline = end;
      } else if (d !== 32 && d !== 9) break;
    }
    let replacement: string;
    if (newlines === 0) {
      if (end - i === 1) {
        i = end; // a single space or tab stays as it is
        continue;
      }
      replacement = " ";
    } else {
      // Spaces before a newline go, three or more newlines become two, and the spaces after the
      // last newline collapse like any other run.
      const tail = end - lastNewline - 1;
      replacement = (newlines >= 2 ? "\n\n" : "\n") + (tail >= 2 ? " " : tail === 1 ? text.charAt(end - 1) : "");
    }
    out += text.slice(last, i) + replacement;
    last = i = end;
  }
  return out + text.slice(last);
}

/** Readable text from HTML, in time linear in the page and bounded by `MAX_SCANNED_TEXT`. */
export function stripHtml(html: string): string {
  const page = scanWindow(html);
  const withoutCode = replaceBlocks(page, elementBlocks(page, ["script", "style"]), " ");
  return tidyWhitespace(tagsToSpaces(withoutCode
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n"))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'"))
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
