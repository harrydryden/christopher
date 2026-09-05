/** In-memory fetch contexts for tests. Not exported from the package index. */
import type { FetchContext, FetchInit, FetchResponse, RawPosting, RenderedPage, SourceSpec, VerifyResult } from "./types";
import type { DiscoveryContext } from "./discovery/types";
import { normalizeUrl } from "./normalize";
import { specFromAnyUrl, findAtsSpecsInText, getAdapter } from "./ats/registry";
import { extractPostingsFromHtml } from "./ats/html";

export interface FakeRoute {
  status?: number;
  body: string | object;
  url?: string;
  /** Match only when the request body contains this substring (for paginated POST APIs). */
  bodyContains?: string;
}

export interface FakeFetchOptions {
  routes: Record<string, FakeRoute | FakeRoute[]>;
  renders?: Record<string, { html: string; requests?: string[]; finalUrl?: string }>;
  now?: () => Date;
}

export interface FakeFetchContext extends FetchContext {
  requestLog: Array<{ url: string; method: string; body?: string }>;
}

export function createFakeFetchContext(options: FakeFetchOptions): FakeFetchContext {
  const requestLog: Array<{ url: string; method: string; body?: string }> = [];
  const lookup = new Map<string, FakeRoute[]>();
  for (const [url, route] of Object.entries(options.routes)) {
    lookup.set(normalizeUrl(url), Array.isArray(route) ? route : [route]);
  }

  const fetchText = async (url: string, init: FetchInit = {}): Promise<FetchResponse> => {
    requestLog.push({ url, method: init.method ?? "GET", body: init.body });
    const routes = lookup.get(normalizeUrl(url));
    if (!routes || routes.length === 0) return { status: 404, url, headers: {}, body: "not found" };
    const match =
      routes.find((r) => r.bodyContains !== undefined && (init.body ?? "").includes(r.bodyContains)) ??
      routes.find((r) => r.bodyContains === undefined) ??
      routes[0]!;
    const body = typeof match.body === "string" ? match.body : JSON.stringify(match.body);
    return { status: match.status ?? 200, url: match.url ?? url, headers: { "content-type": "application/json" }, body };
  };

  const render = options.renders
    ? async (url: string): Promise<RenderedPage> => {
        const entry = options.renders?.[normalizeUrl(url)] ?? options.renders?.[url];
        if (!entry) throw new Error(`no render fixture for ${url}`);
        return { html: entry.html, finalUrl: entry.finalUrl ?? url, requests: entry.requests ?? [], status: 200 };
      }
    : undefined;

  return { fetchText, render, now: options.now, requestLog };
}

export interface FakeDiscoveryOptions extends FakeFetchOptions {
  /** Verification outcome per spec key `type:slug`. Defaults to using the real adapter against the routes. */
  verify?: Record<string, VerifyResult>;
  ai?: DiscoveryContext["ai"];
  maxFetches?: number;
}

export function createFakeDiscoveryContext(options: FakeDiscoveryOptions): DiscoveryContext & { requestLog: FakeFetchContext["requestLog"] } {
  const base = createFakeFetchContext(options);
  return {
    ...base,
    resolveSpec: (url) => specFromAnyUrl(url),
    findSpecsInText: (text, baseUrl) => findAtsSpecsInText(text, baseUrl),
    verifySpec: async (spec: SourceSpec) => {
      const key = `${spec.type}:${spec.atsSlug ?? spec.url}`;
      const override = options.verify?.[key];
      if (override) return override;
      return getAdapter(spec.type).verify(spec, base);
    },
    extractFromHtml: (html, pageUrl): RawPosting[] => extractPostingsFromHtml(html, pageUrl),
    ai: options.ai,
    maxFetches: options.maxFetches,
    requestLog: base.requestLog,
  };
}
