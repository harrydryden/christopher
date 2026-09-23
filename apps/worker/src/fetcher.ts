/**
 * Polite HTTP client used for every outbound request the worker makes to company sites and ATS feeds.
 *  - identifies itself, paces each host (2s for a company's own site, 250ms for a shared ATS API), timeouts, size cap
 *  - optional robots.txt compliance for HTML pages (ATS feed hosts are exempt: they publish JSON for boards)
 *  - host mapping (tests point real hostnames at a local fake server)
 *  - refuses private and local destinations, and follows redirects itself so every hop is guarded,
 *    paced, robots-checked and host-mapped
 *  - maps 403 and challenge pages to SourceFetchError("blocked"), 429/503 to "rate_limited"
 *  - counts every outcome per host per day into `http_host_daily`
 */
import { lookup } from "node:dns/promises";
import { assertPublicHttpUrl, isIpLiteral, isPublicAddress, sha1, SourceFetchError, UnsafeUrlError, type FetchBytesResponse, type FetchContext, type FetchInit, type FetchResponse } from "@ava/core";
import { ats } from "@ava/core";
import { addHttpHostDaily, emptyHttpCounters, latencyBucketIndex, type Db, type HttpHostDailyDelta, type HttpVia } from "@ava/db";
import { log } from "./log";

export interface FetcherOptions {
  deferHost?: (host: string, delayMs: number) => Promise<void>;
  /**
   * Reserve the host's next turn and say how long until it comes. When that is further off than
   * `maxWaitMs` the fetcher will not wait for it, so an implementation should leave the host's
   * schedule alone and only report the wait: a turn nobody takes still pushes everyone behind it.
   */
  reserveHost?: (host: string, delayMs: number, maxWaitMs: number) => Promise<number>;
  /** The longest a request waits for its host's turn before `HostBusyError`. Defaults to 30 s. */
  maxHostWaitMs?: number;
  userAgent: string;
  perHostDelayMs?: number;
  defaultTimeoutMs?: number;
  maxBodyBytes?: number;
  hostMap?: Record<string, string>;
  respectRobots?: () => boolean | Promise<boolean>;
  /** Where outbound traffic is counted. Omitted (tests, the CLI probe) nothing is recorded. */
  traffic?: HttpTrafficLedger;
  /** Every address a name has, asked before connecting. Defaults to the system resolver; tests inject one. */
  resolveHost?: ResolveHost;
  /** Which addresses may be reached. Defaults to `isPublicAddress`; a test substitutes one for a local fixture. */
  isAllowedAddress?: (address: string) => boolean;
  /** The clock robots.txt entries age by. Tests move it; everything else uses the real one. */
  now?: () => number;
}

/** Every address `hostname` resolves to. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

const systemResolve: ResolveHost = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(a => a.address);

/**
 * A destination the worker will not reach: a private or local network address, a name that means
 * one, or a scheme other than http(s). Reported as `blocked` — no retry makes the address public,
 * and a source pointing at one needs a person, not tomorrow's scan.
 */
export class PrivateAddressError extends SourceFetchError {
  constructor(url: string, reason: string) {
    super(`refusing to fetch ${url}: ${reason}`, "blocked");
    this.name = "PrivateAddressError";
  }
}

/** How long a name that resolved only to public addresses is taken as vetted without asking again. */
const VETTED_HOST_TTL_MS = 60_000;
const MAX_VETTED_HOSTS = 2000;

/**
 * The address half of the SSRF guard, shared by the fetcher and the browser: the URL's own rule
 * (`assertPublicHttpUrl`), then every address the name resolves to, all of which must be public.
 *
 * A name is resolved here and again by the connection that follows, so a name that answers public
 * and then private (DNS rebinding) can still slip between the two. Pinning the vetted address
 * needs the connection's own lookup, which the platform `fetch` does not expose.
 */
export class AddressGuard {
  private vetted = new Map<string, number>();
  /** One lookup per name at a time: a page asking for twenty scripts from one CDN resolves it once. */
  private resolving = new Map<string, Promise<string[]>>();

  constructor(private readonly opts: { resolveHost?: ResolveHost; isAllowedAddress?: (address: string) => boolean } = {}) {}

  /** Throws `PrivateAddressError` unless `url` may be fetched. `resolve: false` checks only what the URL says. */
  async check(url: string, opts: { resolve?: boolean } = {}): Promise<void> {
    let parsed: URL;
    try {
      parsed = assertPublicHttpUrl(url, { isAllowedAddress: this.opts.isAllowedAddress });
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new PrivateAddressError(url, error.message);
      throw error;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (opts.resolve === false || isIpLiteral(host)) return;
    const now = Date.now();
    if ((this.vetted.get(host) ?? 0) > now) return;
    let addresses: string[];
    try {
      let pending = this.resolving.get(host);
      if (!pending) {
        pending = (this.opts.resolveHost ?? systemResolve)(host).finally(() => this.resolving.delete(host));
        this.resolving.set(host, pending);
      }
      addresses = await pending;
    } catch (error) {
      throw new SourceFetchError(`network error fetching ${url}: ${(error as Error).message}`, "network");
    }
    if (addresses.length === 0) throw new SourceFetchError(`network error fetching ${url}: ${host} has no address`, "network");
    const refused = addresses.find(address => !(this.opts.isAllowedAddress ?? isPublicAddress)(address));
    if (refused) throw new PrivateAddressError(url, `${host} resolves to ${refused}, a private or local network address`);
    this.vetted.delete(host);
    this.vetted.set(host, now + VETTED_HOST_TTL_MS);
    while (this.vetted.size > MAX_VETTED_HOSTS) this.vetted.delete(this.vetted.keys().next().value!);
  }
}

/**
 * A text body as its author meant it: the charset the Content-Type names, else the one an HTML
 * page's `<meta>` or an XML document's prolog declares in its first 1024 bytes, else UTF-8. A
 * byte-order mark outranks all of them, and JSON is UTF-8 whatever it claims (RFC 8259), because a
 * feed that mislabels itself is commoner than one really written in Latin-1.
 *
 * Reading every page as UTF-8 turned "Zürich" on a windows-1252 careers page into "Z�rich", which
 * the location gate then never matched. A UTF-8 body still decodes exactly as it always did, so no
 * stored hash or revalidation changes for the pages that were already right.
 */
export function decodeBody(buf: Buffer, contentType: string | undefined): string {
  const type = (contentType ?? "").toLowerCase();
  let label: string | undefined;
  if (buf[0] === 0xff && buf[1] === 0xfe) label = "utf-16le";
  else if (buf[0] === 0xfe && buf[1] === 0xff) label = "utf-16be";
  else if ((buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) || /[/+]json\b/.test(type)) label = "utf-8";
  else {
    label = /charset\s*=\s*["']?\s*([\w.:-]+)/.exec(type)?.[1];
    if (!label) {
      const head = buf.subarray(0, 1024).toString("latin1");
      label = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ?? /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1];
      // A document that declares UTF-16 in ASCII bytes is not UTF-16: the HTML standard reads it as UTF-8.
      if (label && /^utf-16/i.test(label)) label = "utf-8";
    }
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label ?? "utf-8");
  } catch {
    return buf.toString("utf8");
  }
  return decoder.encoding === "utf-8" ? buf.toString("utf8") : decoder.decode(buf);
}

/**
 * The product tokens robots.txt groups are matched against: this worker's, and the one it had
 * before the rename, so a group a site wrote for the old name still applies to us.
 */
const ROBOTS_TOKENS = ["avajobmonitor", "christopherjobmonitor"];

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

/**
 * The rules robots.txt sets for us, read as RFC 9309 does: consecutive `User-agent` lines share
 * one group, a group naming one of `tokens` (its product token, compared whole and ignoring case)
 * replaces the `*` group rather than adding to it, several groups for us are merged, and `*`
 * applies only when no group names us. Rules before any `User-agent` line apply to nobody.
 */
export function parseRobots(text: string, tokens: readonly string[] = ROBOTS_TOKENS): RobotsRules {
  const groups: Array<{ agents: string[] } & RobotsRules> = [];
  let current: ({ agents: string[] } & RobotsRules) | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push(current = { agents: [], allow: [], disallow: [] });
      current.agents.push(value.toLowerCase().split(/[/\s]/)[0]!);
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (current && value) current[key].push(value);
    }
  }
  const wanted = tokens.map(t => t.toLowerCase());
  const ours = groups.filter(g => g.agents.some(a => wanted.includes(a)));
  const chosen = ours.length > 0 ? ours : groups.filter(g => g.agents.includes("*"));
  return { allow: chosen.flatMap(g => g.allow), disallow: chosen.flatMap(g => g.disallow) };
}

/**
 * How long a robots.txt answer stands. Rules, and a 4xx (no robots.txt, so no rules), are kept a
 * day, so a site that adds a Disallow for us is heard by tomorrow's run. A 5xx, a 429 or no answer
 * at all allows the fetch but is asked again within the hour, never cached as "no rules" for the
 * life of the process.
 */
const ROBOTS_TTL_MS = 86_400_000;
const ROBOTS_RETRY_MS = 3_600_000;
const MAX_ROBOTS_ENTRIES = 5000;

interface RobotsEntry {
  at: number;
  ttlMs: number;
  /** Null when there are none to apply: no robots.txt, or none could be read. */
  rules: RobotsRules | null;
}

/** The longest a request waits for its host's turn. Beyond it the slot is given back. */
export const MAX_HOST_WAIT_MS = 30_000;

/**
 * The host's next turn is further off than a request may wait — it asked for a back-off, or a
 * queue of our own requests is ahead — so nothing was sent. `retryAt` is when the turn comes.
 *
 * A task holding a slot must not sleep through someone else's hour-long Retry-After: a handler
 * that meets this requeues its task for `retryAt` instead. It is a `rate_limited` SourceFetchError
 * so that code which does not know it yet treats it as the ordinary back-off it is, and a scan
 * that meets one has observed nothing: it can never close a role.
 */
export class HostBusyError extends SourceFetchError {
  constructor(readonly host: string, readonly retryAt: Date) {
    super(`${host} is paced until ${retryAt.toISOString()}; nothing was sent`, "rate_limited");
    this.name = "HostBusyError";
  }
}

/** Wait `ms`, or reject with the signal's reason the moment it aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** How long a request took, and what came back. `status` is null when nothing arrived. */
interface RequestOutcome {
  status: number | null;
  bytes: number;
  durationMs: number;
  /** A reason that is not a status: the body cap, the timeout, or a transport failure. */
  failure?: "capRejected" | "timeouts" | "networkErrors";
}

/** A reason counter recorded beside the status mix: why a request that arrived was not usable. */
type HttpReason = "rateLimited" | "blocked" | "robotsDenied";

/** The platform's `Response`, named so the shared request can talk about one without the DOM lib. */
type HttpResponse = Awaited<ReturnType<typeof fetch>>;

/** One request's counters, filled in as it resolves and recorded once, whatever became of it. */
interface RequestCounters {
  status: number | null;
  bytes: number;
  failure?: RequestOutcome["failure"];
}

/** What the shared request hands a body reader once the response and its bytes are in. */
interface ReadBody {
  res: HttpResponse;
  chunks: Uint8Array[];
  /** Bytes read, after the platform has undone any content encoding. */
  size: number;
  headers: Record<string, string>;
  /** The final URL after redirects, as the logical host (never the test map's local address). */
  finalUrl: string;
  started: number;
  originalHost: string;
  counted: RequestCounters;
}

/** At most this many redirects are followed for one request; the fetch spec allows 20, robots.txt's RFC 5. */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** `headers` without the named ones, compared case-insensitively. */
function withoutHeaders(headers: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !names.includes(k.toLowerCase())));
}

const TEXT_ACCEPT = "text/html,application/xhtml+xml,application/json;q=0.9,application/xml;q=0.8,*/*;q=0.7";
/** An icon fetch says what it is after: some hosts serve an HTML error page to anything else. */
const BINARY_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/**
 * The in-process half of `http_host_daily`: one cell per (UTC day, logical host, path), added to at
 * every outcome and flushed in batches. Per-request log lines answer none of the questions an
 * operator has a week later — is this vendor throttling us, what does this board cost in requests
 * and bytes, how often does revalidation spare a transfer — because the platform has dropped them.
 *
 * Counting is deliberately overlapping: the status mix (`ok2xx`, `notModified304`, `client4xx`, …)
 * accounts for every request exactly once, and the reason counters (`rateLimited`, `blocked`,
 * `capRejected`, `robotsDenied`) sit on top of it, so a 429 is both a 4xx and a rate limit.
 */
export class HttpTrafficLedger {
  private cells = new Map<string, HttpHostDailyDelta>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Db | null, opts: { flushIntervalMs?: number } = {}) {
    if (!db) return;
    this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 30_000);
    // The ledger must never be the reason the process stays alive.
    this.timer.unref();
  }

  private cell(host: string, via: HttpVia): HttpHostDailyDelta {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}|${host}|${via}`;
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { day, host, via, ...emptyHttpCounters() };
      this.cells.set(key, cell);
    }
    return cell;
  }

  /** One request that was actually made, whatever became of it. */
  request(host: string, via: HttpVia, outcome: RequestOutcome): void {
    const cell = this.cell(host, via);
    cell.requests += 1;
    cell.bytesIn += outcome.bytes;
    cell.durationMsSum += outcome.durationMs;
    cell.durationMsMax = Math.max(cell.durationMsMax, outcome.durationMs);
    const bucket = latencyBucketIndex(outcome.durationMs);
    cell.latencyBuckets[bucket] = (cell.latencyBuckets[bucket] ?? 0) + 1;
    const status = outcome.status;
    if (status === 304) cell.notModified304 += 1;
    else if (status !== null && status >= 200 && status < 300) cell.ok2xx += 1;
    else if (status !== null && status >= 300 && status < 400) cell.redirects3xx += 1;
    else if (status !== null && status >= 400 && status < 500) cell.client4xx += 1;
    else if (status !== null && status >= 500) cell.server5xx += 1;
    if (outcome.failure) cell[outcome.failure] += 1;
  }

  /** Why the response that arrived was refused, or — for a robots denial — why none was asked for. */
  reason(host: string, via: HttpVia, reason: HttpReason): void {
    this.cell(host, via)[reason] += 1;
  }

  /** What has been counted but not yet written. Tests read this; nothing else needs it. */
  snapshot(): HttpHostDailyDelta[] {
    return [...this.cells.values()].map(cell => ({ ...cell, latencyBuckets: [...cell.latencyBuckets] }));
  }

  /**
   * Write what has accumulated and start again from zero. Rows are added, never replaced, so a
   * flush that crosses midnight or races another worker still adds up. Never throws.
   */
  async flush(): Promise<void> {
    if (!this.db || this.cells.size === 0) return;
    const deltas = [...this.cells.values()];
    this.cells.clear();
    try {
      await addHttpHostDaily(this.db, deltas);
    } catch (err) {
      log.warn("http traffic flush failed", err);
    }
  }

  /** Stop the timer and write the last counters. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/**
 * The hard ceiling on any response body, which no caller can raise. A Greenhouse board of 2,331
 * roles answered one request with 41 MB; decoding that into a string took the worker past its
 * 258 MB heap and killed the process mid-scan. Above this the request fails as a clean
 * SourceFetchError, which a scan records as a failed scan and retries tomorrow.
 */
export const HARD_MAX_BODY_BYTES = 16_000_000;

/**
 * Revalidation cache bounds. Bodies are held for a week to make conditional requests cheap, so an
 * unbounded cache is a slow leak: one large feed per company is enough to fill the heap. Only small
 * pages are worth keeping; the total is capped and the oldest entry is evicted first.
 */
const MAX_CACHED_BODY_BYTES = 512 * 1024;
const MAX_CACHE_BYTES = 16_000_000;
const MAX_CACHE_ENTRIES = 200;

/**
 * A body too large to cache still gets a validator-only entry: the ETag, the Last-Modified and a
 * hash of what was read, with no body at all. That is a few hundred bytes a URL, so the map is
 * bounded by count alone and the oldest entry is evicted first.
 */
const MAX_VALIDATOR_ENTRIES = 500;

/** How long a cached body or a stored validator may be used to make a conditional request. */
const REVALIDATE_TTL_MS = 7 * 86_400_000;

/**
 * How long to leave a host alone between two requests.
 *
 * A company's own careers page is one site serving one employer, and 2 seconds a request is the
 * politeness the spec promises it. The applicant-tracking API hosts are not that: one host serves
 * every board on the vendor, it is published for job boards to read (which is why robots.txt does
 * not apply to it either), and the catalogue points many companies at it at once. At 2 seconds a
 * request, 30 Greenhouse boards plus 800 per-role description fetches serialise into about half an
 * hour behind one hostname, so those hosts are paced at 250 ms instead. A `Retry-After` back-off is
 * written to `host_pacing` and overrides either figure: a host that asks for a minute gets one.
 */
export const ATS_API_DELAY_MS = 250;
export const DEFAULT_HOST_DELAY_MS = 2000;

/** The minimum interval between two requests to `host`. An override never paces a host faster. */
export function hostDelayMs(host: string, defaultMs: number = DEFAULT_HOST_DELAY_MS): number {
  return ats.isAtsHost(host) ? Math.min(ATS_API_DELAY_MS, defaultMs) : defaultMs;
}

/**
 * How long to leave a host alone after a 429 or 503 that names no `Retry-After`, and the ceiling on
 * one it does: an hour is long enough to clear a burst and short enough that a daily scan still runs.
 */
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 3600_000;

/** How long a 429 or a 503 asks us to leave its host alone, bounded at both ends. */
function retryAfterMs(headers: Record<string, string>): number {
  const retry = headers["retry-after"];
  const seconds = Number(retry);
  const delay = retry ? Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now() : DEFAULT_BACKOFF_MS;
  return Math.min(Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS);
}

const CHALLENGE_MARKERS = [/cf-browser-verification/i, /just a moment/i, /attention required!\s*\|\s*cloudflare/i, /captcha/i, /access denied/i, /perimeterx/i, /_incapsula_/i];

export class PoliteFetcher {
  /** In-process pacing (tests, the CLI): each host's next free turn, as `reserveHost` keeps it in the table. */
  private nextTurn = new Map<string, number>();
  /** Per origin, oldest first, bounded; `robotsInFlight` makes one read serve every caller waiting on it. */
  private robotsCache = new Map<string, RobotsEntry>();
  private robotsInFlight = new Map<string, Promise<RobotsEntry>>();
  private responses = new Map<string, { response: FetchResponse; at: number }>();
  private responseBytes = 0;
  /** Validators for bodies too large to cache: enough to ask "has it changed?", never the body. */
  private validators = new Map<string, { etag?: string; lastModified?: string; hash: string; bytes: number; at: number }>();

  private readonly guard: AddressGuard;

  constructor(private readonly opts: FetcherOptions) {
    this.guard = new AddressGuard({ resolveHost: opts.resolveHost, isAllowedAddress: opts.isAllowedAddress });
  }

  /** Enforce the configured robots policy before a browser top-level navigation. */
  async assertRobotsAllowed(url: string): Promise<void> {
    return this.assertRobotsAllowedFor(url, "browser");
  }

  private async assertRobotsAllowedFor(url: string, via: "http" | "browser"): Promise<void> {
    const u = new URL(url);
    if (ats.isAtsHost(u.hostname) || !this.opts.respectRobots || !(await this.opts.respectRobots())) return;
    if (await this.robotsAllows(url)) return;
    this.opts.traffic?.reason(u.hostname, via, "robotsDenied");
    log.info(`${via} robots denied`, { host: u.hostname, url });
    throw new SourceFetchError(`robots.txt disallows ${url}`, "blocked", 999);
  }

  /**
   * Apply the host map (tests only) and return the URL to actually request plus the Host header
   * to present. When a map is configured it is exhaustive: a host it does not name is reported as
   * unmapped so the caller can refuse it rather than reach the real internet from a test.
   */
  mapUrl(url: string): { target: string; originalHost: string; unmapped: boolean; mapped: boolean } {
    const u = new URL(url);
    const originalHost = u.hostname;
    const hostMap = this.opts.hostMap ?? {};
    const mapped = hostMap[u.hostname] ?? hostMap["*"];
    if (mapped) {
      const [h, p] = mapped.split(":");
      u.protocol = "http:";
      u.hostname = h ?? "127.0.0.1";
      u.port = p ?? "";
    }
    return { target: u.toString(), originalHost, unmapped: !mapped && Object.keys(hostMap).length > 0, mapped: Boolean(mapped) };
  }

  /**
   * Wait for `host`'s next turn. A turn more than `maxHostWaitMs` away is not waited for: this
   * throws `HostBusyError` at once, so a back-off the host asked for costs the caller nothing but
   * the requeue. The wait itself ends early when `signal` aborts.
   */
  async waitForHost(host: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    opts.signal?.throwIfAborted();
    const delay = hostDelayMs(host, this.opts.perHostDelayMs ?? DEFAULT_HOST_DELAY_MS);
    const maxWait = this.opts.maxHostWaitMs ?? MAX_HOST_WAIT_MS;
    if (this.opts.reserveHost) {
      const wait = await this.opts.reserveHost(host, delay, maxWait);
      if (wait > maxWait) throw new HostBusyError(host, new Date(Date.now() + wait));
      if (wait > 0) await sleep(wait, opts.signal);
      return;
    }
    const now = Date.now();
    const turn = Math.max(now, this.nextTurn.get(host) ?? 0);
    if (turn - now > maxWait) throw new HostBusyError(host, new Date(turn));
    this.nextTurn.set(host, turn + delay);
    if (turn > now) await sleep(turn - now, opts.signal);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private async robotsAllows(url: string): Promise<boolean> {
    const u = new URL(url);
    const origin = `${u.protocol}//${u.host}`;
    let entry = this.robotsCache.get(origin);
    if (!entry || this.now() - entry.at >= entry.ttlMs) {
      let pending = this.robotsInFlight.get(origin);
      if (!pending) {
        pending = this.readRobots(origin, u.hostname).finally(() => this.robotsInFlight.delete(origin));
        this.robotsInFlight.set(origin, pending);
      }
      entry = await pending;
    }
    const rules = entry.rules;
    if (!rules) return true;
    const path = u.pathname + u.search;
    const matches = (rule: string) => {
      const re = new RegExp("^" + rule.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$"));
      return re.test(path);
    };
    const longest = (list: string[]) => list.filter(matches).reduce((a, b) => (b.length > a.length ? b : a), "");
    const d = longest(rules.disallow);
    const a = longest(rules.allow);
    if (!d) return true;
    return a.length >= d.length;
  }

  /** Ask `origin` for its robots.txt and remember the answer for as long as it stands. */
  private async readRobots(origin: string, host: string): Promise<RobotsEntry> {
    let entry: RobotsEntry;
    try {
      const res = await this.rawFetch(`${origin}/robots.txt`, { timeoutMs: 8000 });
      if (res.status === 429 || res.status === 503) await this.opts.deferHost?.(host, retryAfterMs(res.headers));
      entry = res.status === 200
        ? { at: this.now(), ttlMs: ROBOTS_TTL_MS, rules: parseRobots(res.body) }
        : { at: this.now(), ttlMs: res.status === 429 || res.status >= 500 ? ROBOTS_RETRY_MS : ROBOTS_TTL_MS, rules: null };
    } catch (error) {
      // A robots.txt the guard refused says the site itself is somewhere we will not go, and one
      // never asked because the host is backing off says nothing at all: neither is "no rules".
      if (error instanceof PrivateAddressError || error instanceof HostBusyError) throw error;
      entry = { at: this.now(), ttlMs: ROBOTS_RETRY_MS, rules: null };
    }
    this.robotsCache.delete(origin);
    this.robotsCache.set(origin, entry);
    while (this.robotsCache.size > MAX_ROBOTS_ENTRIES) this.robotsCache.delete(this.robotsCache.keys().next().value!);
    return entry;
  }

  /**
   * One outbound request, with everything a text body and a binary body share: the address guard,
   * the host map, the per-host pacing, the timeout, the size cap, the traffic counters and the
   * error mapping. The body arrives as bytes; only the text path decodes it.
   *
   * Redirects are followed here rather than by `fetch`, because every hop is a new destination: it
   * is guarded, mapped and paced like the first, and `hooks.hop` (the robots policy, for a page
   * fetch) sees it before any bytes are sent. At most `MAX_REDIRECTS` hops; a 303, or a 301/302 to
   * a POST, continues as a GET without its body, and credentials never cross to another origin.
   *
   * `short` answers before any body is read — the 304 the text path serves from its own cache,
   * where there is no body to read at all.
   */
  private async request<T>(
    url: string,
    init: FetchInit,
    hooks: {
      /** What this body asks for. `init.headers` still overrides it. */
      accept?: string;
      /** Applied after `init.headers`: the conditional request the text path makes. */
      headers?: Record<string, string>;
      /** Checked before a redirect's destination is requested. The robots.txt fetch passes none. */
      hop?: (url: string) => Promise<void>;
      short?: (res: HttpResponse, started: number, originalHost: string) => T | undefined;
      body: (read: ReadBody) => T;
    },
  ): Promise<T> {
    let logical = url;
    let method = init.method ?? "GET";
    let body = init.body;
    let callerHeaders: Record<string, string> = { ...(init.headers ?? {}) };
    init.signal?.throwIfAborted();
    await this.assertDestination(logical);
    for (let hops = 0; ; hops++) {
      const { target, originalHost } = this.mapUrl(logical);
      await this.waitForHost(originalHost, { signal: init.signal });
      const sent = await this.send(logical, target, originalHost, { ...init, method, body, headers: callerHeaders }, hooks);
      if ("value" in sent) return sent.value;
      if (hops >= MAX_REDIRECTS) throw new SourceFetchError(`too many redirects fetching ${url}`, "network");
      let next: URL;
      try {
        next = new URL(sent.location, logical);
      } catch {
        throw new SourceFetchError(`unusable redirect from ${logical} to ${sent.location}`, "network");
      }
      if (next.origin !== new URL(logical).origin) callerHeaders = withoutHeaders(callerHeaders, ["authorization", "proxy-authorization", "cookie"]);
      if ((sent.status === 303 && method !== "HEAD") || ((sent.status === 301 || sent.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        callerHeaders = withoutHeaders(callerHeaders, ["content-type", "content-length", "content-encoding", "content-language", "content-location"]);
      }
      logical = next.toString();
      await this.assertDestination(logical);
      await hooks.hop?.(logical);
    }
  }

  /**
   * Refuse a destination before anything is sent to it, robots.txt included: an address on a
   * private or local network, or — under a test host map — a host the map does not name. A mapped
   * host points at the test's own server and is the one exception. Under a map only the URL itself
   * is checked, so no test ever asks real DNS.
   */
  private async assertDestination(url: string): Promise<void> {
    const { originalHost, unmapped, mapped } = this.mapUrl(url);
    if (!mapped) {
      try {
        await this.guard.check(url, { resolve: !unmapped });
      } catch (error) {
        if (error instanceof PrivateAddressError) {
          this.opts.traffic?.reason(originalHost, "http", "blocked");
          log.warn("http refused a private address", { host: originalHost, url });
        }
        throw error;
      }
    }
    if (unmapped) {
      // Only reachable under a test host map. Failing here keeps a test hermetic: without it a
      // discovery run that guesses an applicant tracking slug would query the real board.
      throw new SourceFetchError(`refusing to fetch ${originalHost}: not in the test host map`, "network");
    }
  }

  /** One hop of `request`: a redirect answers with where it points, anything else with the body. */
  private async send<T>(
    logical: string,
    target: string,
    originalHost: string,
    init: FetchInit,
    hooks: {
      accept?: string;
      headers?: Record<string, string>;
      short?: (res: HttpResponse, started: number, originalHost: string) => T | undefined;
      body: (read: ReadBody) => T;
    },
  ): Promise<{ value: T } | { location: string; status: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? this.opts.defaultTimeoutMs ?? 20_000);
    const headers: Record<string, string> = {
      "user-agent": this.opts.userAgent,
      accept: hooks.accept ?? TEXT_ACCEPT,
      "accept-language": "en-GB,en;q=0.9",
      ...(init.headers ?? {}),
    };
    if (target !== logical) headers["x-forwarded-host"] = originalHost;
    Object.assign(headers, hooks.headers ?? {});
    const started = Date.now();
    // Filled in as the request resolves and recorded once, in the `finally` below, so that every
    // exit — a 304, a body over the cap, a timeout, a dead socket — lands in the same counters.
    const counted: RequestCounters = { status: null, bytes: 0 };
    try {
      const res = await fetch(target, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
        redirect: "manual",
        signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      });
      counted.status = res.status;
      const location = res.headers.get("location");
      if (REDIRECT_STATUSES.has(res.status) && location) {
        await res.body?.cancel().catch(() => undefined);
        return { location, status: res.status };
      }
      const short = hooks.short?.(res, started, originalHost);
      if (short !== undefined) return { value: short };
      // The per-request cap wins: each adapter asks for what its feed needs, and the fetcher-wide
      // option is only the default for callers that ask for nothing. `HARD_MAX_BODY_BYTES` is the
      // ceiling neither can raise.
      const max = Math.min(init.maxBodyBytes ?? this.opts.maxBodyBytes ?? 5_000_000, HARD_MAX_BODY_BYTES);
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (init.method !== "HEAD") {
        const reader = res.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              counted.bytes = size;
              if (size > max) { await reader.cancel(); counted.failure = "capRejected"; throw new SourceFetchError(`Response exceeds ${max} bytes; refusing truncated content`, "parse"); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
        }
      }
      // What crossed the wire: a compressed body is decoded as it is read, so the count of what was
      // read overstates a gzipped feed several times over. The declared length is the transfer when
      // there is one; a body compressed on the fly is chunked and declares none, and for that the
      // platform `fetch` leaves nothing better than the decoded count.
      const declared = Number(res.headers.get("content-length") ?? NaN);
      if (init.method !== "HEAD" && Number.isFinite(declared) && declared >= 0) counted.bytes = declared;
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (outHeaders[k] = v));
      return { value: hooks.body({ res, chunks, size, headers: outHeaders, finalUrl: logical, started, originalHost, counted }) };
    } catch (err) {
      if (err instanceof SourceFetchError) throw err;
      // The caller gave up, not the host: its reason, and nothing the ledger blames on the host.
      if (init.signal?.aborted) throw init.signal.reason;
      if ((err as Error).name === "AbortError") { counted.failure = "timeouts"; throw new SourceFetchError(`timeout fetching ${logical}`, "timeout"); }
      counted.failure = "networkErrors";
      throw new SourceFetchError(`network error fetching ${logical}: ${(err as Error).message}`, "network");
    } finally {
      clearTimeout(timeout);
      this.opts.traffic?.request(originalHost, "http", { status: counted.status, bytes: counted.bytes, durationMs: Date.now() - started, failure: counted.failure });
    }
  }

  private async rawFetch(url: string, init: FetchInit = {}, hop?: (url: string) => Promise<void>): Promise<FetchResponse> {
    const reqHeaders = init.headers ?? {};
    const cacheKey = JSON.stringify([url, reqHeaders, init.maxBodyBytes ?? null]);
    const cacheable = (init.method ?? "GET") === "GET" && !init.body;
    const cached = cacheable ? this.responses.get(cacheKey) : undefined;
    const usable = cached && Date.now() - cached.at < REVALIDATE_TTL_MS ? cached : undefined;
    // A large listing is never in the body cache, so without this it is re-downloaded and re-parsed
    // every day however little it moved. The caller opts in because only it can supply the listing
    // a 304 does not carry.
    const wantsLargeRevalidation = cacheable && init.revalidateLargeBody === true && !reqHeaders.authorization && !reqHeaders.cookie;
    const storedValidator = wantsLargeRevalidation ? this.validators.get(cacheKey) : undefined;
    const validator = storedValidator && Date.now() - storedValidator.at < REVALIDATE_TTL_MS ? storedValidator : undefined;
    const conditional: Record<string, string> = {};
    if (usable?.response.headers.etag) conditional["if-none-match"] = usable.response.headers.etag;
    else if (usable?.response.headers["last-modified"]) conditional["if-modified-since"] = usable.response.headers["last-modified"];
    else if (validator?.etag) conditional["if-none-match"] = validator.etag;
    else if (validator?.lastModified) conditional["if-modified-since"] = validator.lastModified;

    return this.request<FetchResponse>(url, init, {
      headers: conditional,
      hop,
      short: (res, started, originalHost) => {
        if (res.status === 304 && usable) {
          log.info("http revalidated", { host: originalHost, durationMs: Date.now() - started, bytes: 0 });
          // A fresh object: the caller learns nothing was transferred without the cached entry
          // acquiring the marker for every later reader of it.
          return { ...usable.response, revalidated: true };
        }
        if (res.status === 304 && validator) {
          log.info("http revalidated", { host: originalHost, durationMs: Date.now() - started, bytes: 0, validatorOnly: true });
          // Nothing was kept of this body but its hash, so there is nothing to return: the caller
          // asked for `revalidateLargeBody` precisely because it can produce the listing itself.
          this.rememberValidator(cacheKey, { ...validator, at: Date.now() });
          const notModifiedHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => (notModifiedHeaders[k] = v));
          return { status: 304, url, headers: notModifiedHeaders, body: "", revalidated: true, unchanged: true, contentHash: validator.hash };
        }
        return undefined;
      },
      body: ({ res, chunks, headers: outHeaders, finalUrl, started, originalHost }) => {
        const body = decodeBody(Buffer.concat(chunks), outHeaders["content-type"]);
        const response: FetchResponse = { status: res.status, url: finalUrl, headers: outHeaders, body };
        // What the cache holds, which is the decoded string; the ledger has the wire bytes already.
        const bytes = Buffer.byteLength(body);
        if (res.status === 200 && bytes > MAX_CACHED_BODY_BYTES && this.responses.has(cacheKey)) {
          // The body outgrew the cache. Leaving the old one there would keep sending its validator
          // for ever, and a 304 against it would hand a caller a listing that is months out of date.
          this.responseBytes -= Buffer.byteLength(this.responses.get(cacheKey)!.response.body);
          this.responses.delete(cacheKey);
        }
        // Whether a vendor sends validators at all is not something this codebase can assume, so the
        // hash stands on its own: an identical body still spares the parse and everything after it.
        if (wantsLargeRevalidation && res.status === 200 && bytes > MAX_CACHED_BODY_BYTES && !/no-store|private/i.test(outHeaders["cache-control"] ?? "")) {
          const hash = sha1(body);
          response.contentHash = hash;
          if (validator?.hash === hash) response.unchanged = true;
          this.rememberValidator(cacheKey, { etag: outHeaders.etag, lastModified: outHeaders["last-modified"], hash, bytes, at: Date.now() });
        }
        if ((init.method ?? "GET") === "GET" && !init.body && res.status === 200 && bytes <= MAX_CACHED_BODY_BYTES && !/no-store|private/i.test(outHeaders["cache-control"] ?? "") && !outHeaders["set-cookie"] && !reqHeaders.authorization && !reqHeaders.cookie && (outHeaders.etag || outHeaders["last-modified"])) {
          const old = this.responses.get(cacheKey);
          if (old) { this.responseBytes -= Buffer.byteLength(old.response.body); this.responses.delete(cacheKey); }
          this.responses.set(cacheKey, { response, at: Date.now() }); this.responseBytes += bytes;
          // Map iteration is insertion order, so this evicts the oldest entry first.
          while (this.responseBytes > MAX_CACHE_BYTES || this.responses.size > MAX_CACHE_ENTRIES) {
            const key = this.responses.keys().next().value!;
            this.responseBytes -= Buffer.byteLength(this.responses.get(key)!.response.body); this.responses.delete(key);
          }
        }
        log.debug("http fetched", { host: originalHost, status: res.status, durationMs: Date.now() - started, bytes });
        return response;
      },
    });
  }

  /**
   * The same request as `rawFetch`, kept as bytes. No body cache and no validators: an icon is
   * read once every few months, and what is stored of it is the image itself.
   */
  private async rawFetchBytes(url: string, init: FetchInit = {}, hop?: (url: string) => Promise<void>): Promise<FetchBytesResponse> {
    return this.request<FetchBytesResponse>(url, init, {
      accept: BINARY_ACCEPT,
      hop,
      body: ({ res, chunks, headers, finalUrl, started, originalHost }) => {
        const joined = Buffer.concat(chunks);
        // A view rather than a copy, and a plain Uint8Array rather than a Buffer, so that what a
        // caller hashes or sniffs is exactly what came off the wire.
        const bytes = new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
        log.debug("http fetched", { host: originalHost, status: res.status, durationMs: Date.now() - started, bytes: bytes.length, binary: true });
        return { status: res.status, url: finalUrl, headers, bytes };
      },
    });
  }

  /** Keep the validators for one large URL, newest last, and drop the oldest past the bound. */
  private rememberValidator(cacheKey: string, entry: { etag?: string; lastModified?: string; hash: string; bytes: number; at: number }): void {
    this.validators.delete(cacheKey);
    this.validators.set(cacheKey, entry);
    while (this.validators.size > MAX_VALIDATOR_ENTRIES) this.validators.delete(this.validators.keys().next().value!);
  }

  async fetchText(url: string, init: FetchInit = {}): Promise<FetchResponse> {
    await this.assertDestination(url);
    await this.assertRobotsAllowedFor(url, "http");
    const res = await this.rawFetch(url, init, next => this.assertRobotsAllowedFor(next, "http"));
    // The host that answered, which after a redirect is not always the one asked.
    const u = new URL(res.url || url);
    const challenge = () => CHALLENGE_MARKERS.some((re) => re.test(res.body.slice(0, 20_000)));
    if (res.status === 429 || res.status === 503) {
      await this.opts.deferHost?.(u.hostname, retryAfterMs(res.headers));
      // A host serving a challenge under a 503 is protecting itself from us, not pacing us, and
      // no amount of waiting fixes that. Everything else is a back-off: a failed scan that
      // retries on the normal schedule, never a source disabled until someone intervenes.
      if (challenge()) {
        this.opts.traffic?.reason(u.hostname, "http", "blocked");
        throw new SourceFetchError(`blocked (${res.status}) fetching ${url}`, "blocked", res.status);
      }
      this.opts.traffic?.reason(u.hostname, "http", "rateLimited");
      throw new SourceFetchError(`rate limited (${res.status}) fetching ${url}`, "rate_limited", res.status);
    }
    if (res.status === 403) {
      this.opts.traffic?.reason(u.hostname, "http", "blocked");
      throw new SourceFetchError(`blocked (${res.status}) fetching ${url}`, "blocked", res.status);
    }
    if (res.status === 200 && CHALLENGE_MARKERS.slice(0, 3).some((re) => re.test(res.body.slice(0, 5000))) && res.body.length < 20_000) {
      this.opts.traffic?.reason(u.hostname, "http", "blocked");
      throw new SourceFetchError(`bot challenge page at ${url}`, "blocked", 403);
    }
    log.debug("fetch", { url, status: res.status, bytes: res.body.length });
    return res;
  }

  /**
   * A body read as bytes — an icon, an image — under the same politeness as `fetchText`: robots,
   * the host's pacing, the timeout, the size cap and the same reading of a 429, a 503 or a 403.
   *
   * No challenge-marker sniffing: the body is binary, and a challenge page dressed as an image is
   * caught where it matters, by the caller refusing bytes that are not an image.
   */
  async fetchBytes(url: string, init: FetchInit = {}): Promise<FetchBytesResponse> {
    await this.assertDestination(url);
    await this.assertRobotsAllowedFor(url, "http");
    const res = await this.rawFetchBytes(url, init, next => this.assertRobotsAllowedFor(next, "http"));
    const u = new URL(res.url || url);
    if (res.status === 429 || res.status === 503) {
      await this.opts.deferHost?.(u.hostname, retryAfterMs(res.headers));
      this.opts.traffic?.reason(u.hostname, "http", "rateLimited");
      throw new SourceFetchError(`rate limited (${res.status}) fetching ${url}`, "rate_limited", res.status);
    }
    if (res.status === 403) {
      this.opts.traffic?.reason(u.hostname, "http", "blocked");
      throw new SourceFetchError(`blocked (${res.status}) fetching ${url}`, "blocked", res.status);
    }
    log.debug("fetch bytes", { url, status: res.status, bytes: res.bytes.length });
    return res;
  }

  /**
   * Defer `host` for a 429 or 503 seen somewhere other than this fetcher — the browser's own
   * navigation — exactly as one seen here would be: its `Retry-After`, bounded at both ends.
   */
  async backOff(host: string, headers: Record<string, string>): Promise<void> {
    await this.opts.deferHost?.(host, retryAfterMs(headers));
  }

  asContext(): Pick<FetchContext, "fetchText" | "fetchBytes"> {
    return {
      fetchText: (url, init) => this.fetchText(url, init),
      fetchBytes: (url, init) => this.fetchBytes(url, init),
    };
  }

  /** Write the traffic counters now. A no-op without a ledger (tests, the CLI probe). */
  async flush(): Promise<void> {
    await this.opts.traffic?.flush();
  }
}

export function userAgentFor(contactEmail: string): string {
  return `Mozilla/5.0 (compatible; AVAJobMonitor/0.1; +mailto:${contactEmail})`;
}
