/**
 * Polite HTTP client used for every outbound request the worker makes to company sites and ATS feeds.
 *  - identifies itself, paces each host (2s for a company's own site, 250ms for a shared ATS API), timeouts, size cap
 *  - optional robots.txt compliance for HTML pages (ATS feed hosts are exempt: they publish JSON for boards)
 *  - host mapping (tests point real hostnames at a local fake server)
 *  - maps 403 and challenge pages to SourceFetchError("blocked"), 429/503 to "rate_limited"
 *  - counts every outcome per host per day into `http_host_daily`
 */
import { sha1, SourceFetchError, type FetchContext, type FetchInit, type FetchResponse } from "@christopher/core";
import { ats } from "@christopher/core";
import { addHttpHostDaily, emptyHttpCounters, latencyBucketIndex, type Db, type HttpHostDailyDelta, type HttpVia } from "@christopher/db";
import { log } from "./log";

export interface FetcherOptions {
  deferHost?: (host: string, delayMs: number) => Promise<void>;
  reserveHost?: (host: string, delayMs: number) => Promise<number>;
  userAgent: string;
  perHostDelayMs?: number;
  defaultTimeoutMs?: number;
  maxBodyBytes?: number;
  hostMap?: Record<string, string>;
  respectRobots?: () => boolean | Promise<boolean>;
  /** Where outbound traffic is counted. Omitted (tests, the CLI probe) nothing is recorded. */
  traffic?: HttpTrafficLedger;
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

const CHALLENGE_MARKERS = [/cf-browser-verification/i, /just a moment/i, /attention required!\s*\|\s*cloudflare/i, /captcha/i, /access denied/i, /perimeterx/i, /_incapsula_/i];

export class PoliteFetcher {
  private lastRequestAt = new Map<string, number>();
  private robotsCache = new Map<string, { fetchedAt: number; disallow: string[]; allow: string[] } | null>();
  private queues = new Map<string, Promise<void>>();
  private responses = new Map<string, { response: FetchResponse; at: number }>();
  private responseBytes = 0;
  /** Validators for bodies too large to cache: enough to ask "has it changed?", never the body. */
  private validators = new Map<string, { etag?: string; lastModified?: string; hash: string; bytes: number; at: number }>();

  constructor(private readonly opts: FetcherOptions) {}

  /**
   * Apply the host map (tests only) and return the URL to actually request plus the Host header
   * to present. When a map is configured it is exhaustive: a host it does not name is reported as
   * unmapped so the caller can refuse it rather than reach the real internet from a test.
   */
  mapUrl(url: string): { target: string; originalHost: string; unmapped: boolean } {
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
    return { target: u.toString(), originalHost, unmapped: !mapped && Object.keys(hostMap).length > 0 };
  }

  async waitForHost(host: string): Promise<void> {
    const delay = hostDelayMs(host, this.opts.perHostDelayMs ?? DEFAULT_HOST_DELAY_MS);
    if (this.opts.reserveHost) {
      const wait = await this.opts.reserveHost(host, delay);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      return;
    }
    const prev = this.queues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.queues.set(host, prev.then(() => mine));
    await prev;
    const last = this.lastRequestAt.get(host) ?? 0;
    const wait = Math.max(0, last + delay - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt.set(host, Date.now());
    release();
  }

  private parseRobots(text: string): { disallow: string[]; allow: string[] } {
    const lines = text.split(/\r?\n/);
    let applies = false;
    let sawStar = false;
    const disallow: string[] = [];
    const allow: string[] = [];
    const ua = this.opts.userAgent.toLowerCase();
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) continue;
      const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      const value = m[2]!.trim();
      if (key === "user-agent") {
        const v = value.toLowerCase();
        applies = v === "*" || ua.includes(v);
        if (v === "*") sawStar = true;
      } else if (applies && key === "disallow" && value) disallow.push(value);
      else if (applies && key === "allow" && value) allow.push(value);
    }
    if (!sawStar && disallow.length === 0) return { disallow: [], allow: [] };
    return { disallow, allow };
  }

  private async robotsAllows(url: string): Promise<boolean> {
    const u = new URL(url);
    const origin = `${u.protocol}//${u.host}`;
    let entry = this.robotsCache.get(origin);
    if (entry === undefined) {
      try {
        const res = await this.rawFetch(`${origin}/robots.txt`, { timeoutMs: 8000 });
        entry = res.status === 200 ? { fetchedAt: Date.now(), ...this.parseRobots(res.body) } : null;
      } catch {
        entry = null;
      }
      this.robotsCache.set(origin, entry);
    }
    if (!entry) return true;
    const path = u.pathname + u.search;
    const matches = (rule: string) => {
      const re = new RegExp("^" + rule.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$"));
      return re.test(path);
    };
    const longest = (rules: string[]) => rules.filter(matches).reduce((a, b) => (b.length > a.length ? b : a), "");
    const d = longest(entry.disallow);
    const a = longest(entry.allow);
    if (!d) return true;
    return a.length >= d.length;
  }

  private async rawFetch(url: string, init: FetchInit = {}): Promise<FetchResponse> {
    const { target, originalHost, unmapped } = this.mapUrl(url);
    if (unmapped) {
      // Only reachable under a test host map. Failing here keeps a test hermetic: without it a
      // discovery run that guesses an applicant tracking slug would query the real board.
      throw new SourceFetchError(`refusing to fetch ${originalHost}: not in the test host map`, "network");
    }
    await this.waitForHost(originalHost);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? this.opts.defaultTimeoutMs ?? 20_000);
    const headers: Record<string, string> = {
      "user-agent": this.opts.userAgent,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,application/xml;q=0.8,*/*;q=0.7",
      "accept-language": "en-GB,en;q=0.9",
      ...(init.headers ?? {}),
    };
    if (target !== url) headers["x-forwarded-host"] = originalHost;
    const cacheKey = JSON.stringify([url, init.headers ?? {}, init.maxBodyBytes ?? null]);
    const cacheable = (init.method ?? "GET") === "GET" && !init.body;
    const cached = cacheable ? this.responses.get(cacheKey) : undefined;
    const usable = cached && Date.now() - cached.at < REVALIDATE_TTL_MS ? cached : undefined;
    // A large listing is never in the body cache, so without this it is re-downloaded and re-parsed
    // every day however little it moved. The caller opts in because only it can supply the listing
    // a 304 does not carry.
    const wantsLargeRevalidation = cacheable && init.revalidateLargeBody === true && !headers.authorization && !headers.cookie;
    const storedValidator = wantsLargeRevalidation ? this.validators.get(cacheKey) : undefined;
    const validator = storedValidator && Date.now() - storedValidator.at < REVALIDATE_TTL_MS ? storedValidator : undefined;
    if (usable?.response.headers.etag) headers["if-none-match"] = usable.response.headers.etag;
    else if (usable?.response.headers["last-modified"]) headers["if-modified-since"] = usable.response.headers["last-modified"];
    else if (validator?.etag) headers["if-none-match"] = validator.etag;
    else if (validator?.lastModified) headers["if-modified-since"] = validator.lastModified;
    const started = Date.now();
    // Filled in as the request resolves and recorded once, in the `finally` below, so that every
    // exit — a 304, a body over the cap, a timeout, a dead socket — lands in the same counters.
    let status: number | null = null;
    let bytes = 0;
    let failure: RequestOutcome["failure"];
    try {
      const res = await fetch(target, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
        redirect: "follow",
        signal: controller.signal,
      });
      status = res.status;
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
      // The per-request cap wins: each adapter asks for what its feed needs, and the fetcher-wide
      // option is only the default for callers that ask for nothing. `HARD_MAX_BODY_BYTES` is the
      // ceiling neither can raise.
      const max = Math.min(init.maxBodyBytes ?? this.opts.maxBodyBytes ?? 5_000_000, HARD_MAX_BODY_BYTES);
      let body = "";
      if (init.method !== "HEAD") {
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              bytes = size;
              if (size > max) { await reader.cancel(); failure = "capRejected"; throw new SourceFetchError(`Response exceeds ${max} bytes; refusing truncated content`, "parse"); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
        }
        body = Buffer.concat(chunks).toString("utf8");
      }
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (outHeaders[k] = v));
      // Un-map the final URL so callers see the logical host.
      let finalUrl = res.url || url;
      if (target !== url) {
        try {
          const fu = new URL(finalUrl);
          const ou = new URL(url);
          fu.protocol = ou.protocol;
          fu.hostname = ou.hostname;
          fu.port = ou.port;
          finalUrl = fu.toString();
        } catch {
          finalUrl = url;
        }
      }
      const response: FetchResponse = { status: res.status, url: finalUrl, headers: outHeaders, body };
      bytes = Buffer.byteLength(body);
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
      if ((init.method ?? "GET") === "GET" && !init.body && res.status === 200 && bytes <= MAX_CACHED_BODY_BYTES && !/no-store|private/i.test(outHeaders["cache-control"] ?? "") && !outHeaders["set-cookie"] && !headers.authorization && !headers.cookie && (outHeaders.etag || outHeaders["last-modified"])) {
        const old = this.responses.get(cacheKey);
        if (old) { this.responseBytes -= Buffer.byteLength(old.response.body); this.responses.delete(cacheKey); }
        this.responses.set(cacheKey, { response, at: Date.now() }); this.responseBytes += bytes;
        // Map iteration is insertion order, so this evicts the oldest entry first.
        while (this.responseBytes > MAX_CACHE_BYTES || this.responses.size > MAX_CACHE_ENTRIES) {
          const key = this.responses.keys().next().value!;
          this.responseBytes -= Buffer.byteLength(this.responses.get(key)!.response.body); this.responses.delete(key);
        }
      }
      log.info("http fetched", { host: originalHost, status: res.status, durationMs: Date.now() - started, bytes });
      return response;
    } catch (err) {
      if (err instanceof SourceFetchError) throw err;
      if ((err as Error).name === "AbortError") { failure = "timeouts"; throw new SourceFetchError(`timeout fetching ${url}`, "timeout"); }
      failure = "networkErrors";
      throw new SourceFetchError(`network error fetching ${url}: ${(err as Error).message}`, "network");
    } finally {
      clearTimeout(timeout);
      this.opts.traffic?.request(originalHost, "http", { status, bytes, durationMs: Date.now() - started, failure });
    }
  }

  /** Keep the validators for one large URL, newest last, and drop the oldest past the bound. */
  private rememberValidator(cacheKey: string, entry: { etag?: string; lastModified?: string; hash: string; bytes: number; at: number }): void {
    this.validators.delete(cacheKey);
    this.validators.set(cacheKey, entry);
    while (this.validators.size > MAX_VALIDATOR_ENTRIES) this.validators.delete(this.validators.keys().next().value!);
  }

  async fetchText(url: string, init: FetchInit = {}): Promise<FetchResponse> {
    const u = new URL(url);
    const isFeedHost = ats.isAtsHost(u.hostname);
    if (!isFeedHost && this.opts.respectRobots && (await this.opts.respectRobots())) {
      if (!(await this.robotsAllows(url))) {
        // No request is made, so this is counted as a denial rather than as traffic.
        this.opts.traffic?.reason(u.hostname, "http", "robotsDenied");
        log.info("http robots denied", { host: u.hostname, url });
        throw new SourceFetchError(`robots.txt disallows ${url}`, "blocked", 999);
      }
    }
    const res = await this.rawFetch(url, init);
    const challenge = () => CHALLENGE_MARKERS.some((re) => re.test(res.body.slice(0, 20_000)));
    if (res.status === 429 || res.status === 503) {
      const retry = res.headers["retry-after"];
      const seconds = Number(retry);
      const delay = retry ? Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now() : DEFAULT_BACKOFF_MS;
      await this.opts.deferHost?.(u.hostname, Math.min(Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS));
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

  asContext(): Pick<FetchContext, "fetchText"> {
    return { fetchText: (url, init) => this.fetchText(url, init) };
  }

  /** Write the traffic counters now. A no-op without a ledger (tests, the CLI probe). */
  async flush(): Promise<void> {
    await this.opts.traffic?.flush();
  }
}

export function userAgentFor(contactEmail: string): string {
  return `Mozilla/5.0 (compatible; ChristopherJobMonitor/0.1; +mailto:${contactEmail})`;
}
