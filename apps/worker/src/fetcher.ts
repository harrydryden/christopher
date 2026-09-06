/**
 * Polite HTTP client used for every outbound request the worker makes to company sites and ATS feeds.
 *  - identifies itself, one request per 2s per host, timeouts, size cap
 *  - optional robots.txt compliance for HTML pages (ATS feed hosts are exempt: they publish JSON for boards)
 *  - host mapping (tests point real hostnames at a local fake server)
 *  - maps 403/429/challenge pages to SourceFetchError("blocked")
 */
import { SourceFetchError, type FetchContext, type FetchInit, type FetchResponse } from "@christopher/core";
import { ats } from "@christopher/core";
import { log } from "./log";

export interface FetcherOptions {
  userAgent: string;
  perHostDelayMs?: number;
  defaultTimeoutMs?: number;
  maxBodyBytes?: number;
  hostMap?: Record<string, string>;
  respectRobots?: () => boolean | Promise<boolean>;
}

const CHALLENGE_MARKERS = [/cf-browser-verification/i, /just a moment/i, /attention required!\s*\|\s*cloudflare/i, /captcha/i, /access denied/i, /perimeterx/i, /_incapsula_/i];

export class PoliteFetcher {
  private lastRequestAt = new Map<string, number>();
  private robotsCache = new Map<string, { fetchedAt: number; disallow: string[]; allow: string[] } | null>();
  private queues = new Map<string, Promise<void>>();
  public requests = 0;

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

  private async waitTurn(host: string): Promise<void> {
    const delay = this.opts.perHostDelayMs ?? 2000;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? this.opts.defaultTimeoutMs ?? 20_000);
    const headers: Record<string, string> = {
      "user-agent": this.opts.userAgent,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,application/xml;q=0.8,*/*;q=0.7",
      "accept-language": "en-GB,en;q=0.9",
      ...(init.headers ?? {}),
    };
    if (target !== url) headers["x-forwarded-host"] = originalHost;
    this.requests += 1;
    try {
      const res = await fetch(target, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
        redirect: "follow",
        signal: controller.signal,
      });
      const max = this.opts.maxBodyBytes ?? init.maxBodyBytes ?? 5_000_000;
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
              if (size > max) { await reader.cancel(); throw new SourceFetchError(`Response exceeds ${max} bytes; refusing truncated content`, "parse"); }
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
      return { status: res.status, url: finalUrl, headers: outHeaders, body };
    } catch (err) {
      if (err instanceof SourceFetchError) throw err;
      if ((err as Error).name === "AbortError") throw new SourceFetchError(`timeout fetching ${url}`, "timeout");
      throw new SourceFetchError(`network error fetching ${url}: ${(err as Error).message}`, "network");
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchText(url: string, init: FetchInit = {}): Promise<FetchResponse> {
    const u = new URL(url);
    const isFeedHost = ats.isAtsHost(u.hostname);
    if (!isFeedHost && this.opts.respectRobots && (await this.opts.respectRobots())) {
      if (!(await this.robotsAllows(url))) {
        throw new SourceFetchError(`robots.txt disallows ${url}`, "blocked", 999);
      }
    }
    await this.waitTurn(u.hostname);
    const res = await this.rawFetch(url, init);
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      const challenge = CHALLENGE_MARKERS.some((re) => re.test(res.body.slice(0, 20_000)));
      if (res.status !== 503 || challenge) {
        throw new SourceFetchError(`blocked (${res.status}) fetching ${url}`, "blocked", res.status);
      }
    }
    if (res.status === 200 && CHALLENGE_MARKERS.slice(0, 3).some((re) => re.test(res.body.slice(0, 5000))) && res.body.length < 20_000) {
      throw new SourceFetchError(`bot challenge page at ${url}`, "blocked", 403);
    }
    log.debug("fetch", { url, status: res.status, bytes: res.body.length });
    return res;
  }

  asContext(): Pick<FetchContext, "fetchText"> {
    return { fetchText: (url, init) => this.fetchText(url, init) };
  }
}

export function userAgentFor(contactEmail: string): string {
  return `Mozilla/5.0 (compatible; ChristopherJobMonitor/0.1; +mailto:${contactEmail})`;
}
