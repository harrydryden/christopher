/**
 * Careers-source discovery. Given a homepage URL, find the page or feed that lists the company's jobs.
 * See docs/SPEC.md section 3.2. Every step adds candidates with a method; the best one decides the outcome.
 */
import { absoluteUrl, ensureHttpUrl, extractDomain, normalizeUrl, sameDomain, scanWindow, sha1, stripHtml } from "../normalize";
import { isExplicitEmptyListing } from "../ats/html";
import { assertPublicHttpUrl } from "../url-safety";
import type { FetchInit, RawPosting, SourceSpec } from "../types";
import { confidenceFor, outcomeFor } from "./confidence";
import { countAnchors, extractMeta, harvestLinks, scoreLink, WELL_KNOWN_PATHS } from "./links";
import { companyNameFromTitle, companyNamesMatch, looksLikeSoft404, nameFromDomain, nameFromSlug } from "./text";
import type { DiscoveryCandidate, DiscoveryContext, DiscoveryResult, DiscoveryVerification, HarvestedLink } from "./types";

const JOB_DETAIL_RE = /\/(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|opportunit(?:y|ies))\//i;
const MAX_CANDIDATE_PAGES = 6;
/** Pages that commonly link onward to Careers when the homepage does not. */
const HUB_PATHS: readonly string[] = ["/about", "/about-us", "/company", "/team"];
const MAX_BUNDLES = 8;
const MAX_BUNDLE_BYTES = 2_000_000;
/**
 * Boards one run may verify. Verification has an allowance of its own, apart from the crawl's fetch
 * and time budgets: a board found by the crawl's last fetch, or after a slow render, is still
 * checked. Each verification reads one page of the board; the task deadline bounds the whole.
 */
const MAX_VERIFICATIONS = 10;
/** Model page classifications (A2) one run may make. */
const MAX_CLASSIFICATIONS = 6;
/** Blind path probes stop once this many in a row found nothing: a 404, a soft 404 or a page already seen. */
const MAX_CONSECUTIVE_MISSES = 8;
/** A body larger than this is used by the step that fetched it and not kept for the rest of the run. */
const MAX_CACHED_BODY = 2_000_000;

interface Fetched {
  html: string;
  url: string;
  status: number;
}

interface RawCandidate {
  spec: SourceSpec;
  method: string;
  evidence: string[];
  sample?: RawPosting[];
  count?: number;
  companyName?: string;
}

class Run {
  readonly log: string[] = [];
  readonly candidates = new Map<string, RawCandidate>();
  private readonly pages = new Map<string, Fetched | null>();
  private readonly statuses = new Map<string, number>();
  /** Pages that answered 404, looked like a soft 404, or served a body already inspected. */
  private readonly missing = new Set<string>();
  private readonly renders = new Map<string, { page: Fetched; requests: string[] } | null>();
  private readonly inspectedUrls = new Set<string>();
  private readonly inspectedBodies = new Set<string>();
  private readonly verified = new Map<string, DiscoveryVerification>();
  fetches = 0;
  verifications = 0;
  classifications = 0;
  readonly maxFetches: number;
  private readonly maxVerifications: number;
  private readonly startedAt: number;
  homepageCompanyName?: string;

  constructor(private readonly ctx: DiscoveryContext) {
    this.maxFetches = ctx.maxFetches ?? 40;
    this.maxVerifications = ctx.maxVerifications ?? MAX_VERIFICATIONS;
    this.startedAt = this.now();
  }

  private now(): number {
    return this.ctx.now?.().getTime() ?? Date.now();
  }

  private sayOnce(msg: string): void {
    if (!this.log.includes(msg)) this.say(msg);
  }

  say(msg: string): void {
    this.log.push(msg);
    this.ctx.log?.(`discovery: ${msg}`);
  }

  /** The crawl's budget: fetches and renders, and its own time. Verification is not counted here. */
  budgetLeft(): boolean {
    if (this.ctx.signal?.aborted) {
      this.sayOnce("discovery stopped: its task was cancelled");
      return false;
    }
    if (this.now() - this.startedAt >= (this.ctx.maxDurationMs ?? 120_000)) {
      this.sayOnce("discovery time budget exhausted");
      return false;
    }
    if (this.fetches < this.maxFetches) return true;
    if (!this.log.some((l) => l.startsWith("fetch budget"))) this.say(`fetch budget of ${this.maxFetches} exhausted; stopping early`);
    return false;
  }

  /**
   * Discovery follows only http(s) URLs on the public internet, without credentials, whatever a
   * page or the model offers: a private or local address is not followed and costs no fetch from
   * the budget. The fetcher and the browser resolve every name and apply the same rule again, so
   * this is the cheap refusal, not the only one.
   */
  permitted(url: string): boolean {
    try {
      assertPublicHttpUrl(url);
      return true;
    } catch {
      return false;
    }
  }

  async fetch(url: string, init?: FetchInit): Promise<Fetched | null> {
    const key = normalizeUrl(url);
    const cached = this.pages.get(key);
    if (cached !== undefined) return cached;
    if (!this.permitted(url)) {
      this.say(`not following ${url}`);
      this.pages.set(key, null);
      return null;
    }
    if (!this.budgetLeft()) return null;
    this.fetches++;
    try {
      const res = await this.ctx.fetchText(url, init);
      this.statuses.set(key, res.status);
      if (res.status === 404 || res.status === 410) this.missing.add(key);
      if (res.status >= 400) {
        this.say(`fetch ${url} -> HTTP ${res.status}`);
        this.pages.set(key, null);
        return null;
      }
      const page: Fetched = { html: res.body, url: res.url || url, status: res.status };
      // A large body is used by the step that asked for it, not held for the rest of the run.
      if (page.html.length <= MAX_CACHED_BODY) this.pages.set(key, page);
      return page;
    } catch (err) {
      this.say(`fetch ${url} failed: ${(err as Error).message}`);
      this.pages.set(key, null);
      return null;
    }
  }

  /** The HTTP status `url` answered with, when this run fetched it. */
  statusOf(url: string): number | undefined {
    return this.statuses.get(normalizeUrl(url));
  }

  markMissing(url: string): void {
    this.missing.add(normalizeUrl(url));
  }

  /** Whether `url` turned out to have nothing of its own: a 404, a soft 404 or a repeated body. */
  isMissing(url: string): boolean {
    return this.missing.has(normalizeUrl(url));
  }

  /** Render a page once per run; a second request for the same URL gets the first render. */
  async render(url: string, opts: { scrollAndExpand?: boolean }): Promise<{ page: Fetched; requests: string[] } | null> {
    const key = normalizeUrl(url);
    const cached = this.renders.get(key);
    if (cached !== undefined) return cached;
    if (!this.ctx.render || !this.permitted(url) || !this.budgetLeft()) return null;
    this.fetches++;
    this.renders.set(key, null);
    try {
      const rendered = await this.ctx.render(url, opts);
      const result = { page: { html: rendered.html, url: rendered.finalUrl, status: rendered.status ?? 200 }, requests: rendered.requests };
      if (result.page.html.length <= MAX_CACHED_BODY) this.renders.set(key, result);
      return result;
    } catch (err) {
      this.say(`render ${url} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Each page is inspected once per run, however many pages link to it. */
  claimInspection(url: string): boolean {
    const key = normalizeUrl(url);
    if (this.inspectedUrls.has(key)) return false;
    this.inspectedUrls.add(key);
    return true;
  }

  /**
   * A body identical to one already inspected (the homepage, a catch-all shell that every path
   * answers with) says nothing new, so it is neither inspected, rendered nor classified again.
   */
  claimBody(html: string): boolean {
    const hash = sha1(html);
    if (this.inspectedBodies.has(hash)) return false;
    this.inspectedBodies.add(hash);
    return true;
  }

  /** Whether the run may make another model page classification. */
  mayClassify(): boolean {
    if (!this.budgetLeft()) return false;
    if (this.classifications >= MAX_CLASSIFICATIONS) {
      this.sayOnce(`model classification budget of ${MAX_CLASSIFICATIONS} spent`);
      return false;
    }
    this.classifications++;
    return true;
  }

  add(candidate: RawCandidate): void {
    const key = specKey(candidate.spec);
    const existing = this.candidates.get(key);
    if (!existing) {
      this.candidates.set(key, candidate);
      return;
    }
    // Keep the strongest method, but remember every method that pointed here.
    const merged: RawCandidate = {
      ...existing,
      evidence: [...new Set([...existing.evidence, ...candidate.evidence])],
      sample: existing.sample?.length ? existing.sample : candidate.sample,
      count: existing.count ?? candidate.count,
      companyName: existing.companyName ?? candidate.companyName,
    };
    if (rank(candidate.method) > rank(existing.method)) merged.method = candidate.method;
    merged.evidence.push(`method:${candidate.method}`);
    merged.evidence = [...new Set(merged.evidence)];
    this.candidates.set(key, merged);
  }

  /** Candidates strongest method first; equal methods keep the order they were found in. */
  ranked(): RawCandidate[] {
    return [...this.candidates.values()].sort((a, b) => rank(b.method) - rank(a.method));
  }

  /**
   * Whether the crawl has found something worth stopping for: a listing page, or an ATS board that
   * verified. An ATS reference that does not verify (a stale board link, a board that is down) stays
   * a candidate but never stops the crawl: the hubs, probes, sitemaps and model after it are how a
   * company whose careers link has gone stale is still found.
   */
  async hasResolvableCandidate(): Promise<boolean> {
    for (const candidate of this.ranked()) {
      if (rank(candidate.method) < rank("listing_html")) return false;
      if (candidate.spec.type === "html") return true;
      if ((await this.verify(candidate.spec)).ok) return true;
    }
    return false;
  }

  /**
   * Verify a board once per run. This has its own allowance and is not bound by the crawl's fetch
   * or time budget; only the task's own cancellation stops it.
   */
  async verify(spec: SourceSpec): Promise<DiscoveryVerification> {
    const key = specKey(spec);
    const cached = this.verified.get(key);
    if (cached) return cached;
    if (this.ctx.signal?.aborted) return { ok: false, error: "discovery was cancelled", transient: true };
    if (this.verifications >= this.maxVerifications) {
      this.sayOnce(`verification budget of ${this.maxVerifications} spent`);
      return { ok: false, error: "verification budget exhausted" };
    }
    this.verifications++;
    let result: DiscoveryVerification;
    try {
      result = await this.ctx.verifySpec(spec);
    } catch (err) {
      result = { ok: false, error: (err as Error).message, transient: isTransientError(err) };
    }
    this.verified.set(key, result);
    return result;
  }
}

/** A failure that says nothing about the board: the host asked us to come back later. */
function isTransientError(err: unknown): boolean {
  const e = err as { name?: string; kind?: string; status?: number };
  if (e?.name === "HostBusyError") return true;
  if (e?.name !== "SourceFetchError") return false;
  return e.kind === "rate_limited" || e.kind === "timeout" || e.kind === "network" || (e.kind === "http" && (e.status ?? 0) >= 500);
}

function specKey(spec: SourceSpec): string {
  return `${spec.type}|${spec.atsSlug ?? ""}|${spec.atsSite ?? ""}|${spec.atsSlug ? "" : normalizeUrl(spec.url)}`;
}

const METHOD_RANK: Record<string, number> = {
  ats_network: 9, pasted_ats: 9, ats_link: 8, ats_script: 8, ats_bundle: 7,
  listing_jsonld: 6, listing_html: 6, listing_empty: 6, pasted_listing: 6, ai_listing: 5, ats_sitemap: 3, ats_probe: 3, ats_guess: 3, landing: 1,
};
function rank(method: string): number {
  return METHOD_RANK[method] ?? 0;
}

function hasJsonLdJobPosting(html: string): boolean {
  const page = scanWindow(html);
  return /application\/ld\+json/i.test(page) && /"JobPosting"/i.test(page);
}

export function isJsShell(html: string): boolean {
  return countAnchors(html) < 5 || stripHtml(html).length < 400;
}

// An empty `<div>`/`<section>` whose id or class names jobs: a client-side listing not yet mounted.
// The tag's attributes stop at the next `<` or `>` and are tested on their own, so every scan is
// bounded by the tag it starts in.
const EMPTY_ELEMENT_RE = /<(?:div|section)([^<>]*)>\s*<\/(?:div|section)>/gi;
const JOBS_MOUNT_ATTR_RE = /(?:id|class)=["'][^"']*(?:jobs?|positions?|openings?)[^"']*["']/i;

export function hasEmptyJobsMount(html: string): boolean {
  for (const match of scanWindow(html).matchAll(EMPTY_ELEMENT_RE)) {
    if (match[1] && JOBS_MOUNT_ATTR_RE.test(match[1])) return true;
  }
  return false;
}

function shouldRenderCandidate(html: string, url: string, via?: string): boolean {
  if (!via) return false;
  try { new URL(url); } catch { return false; }
  // A careers-shaped path alone is not evidence that a content-rich informational page needs a
  // browser. Render shells and explicit empty client-side job mounts; static landing pages can be
  // followed from their harvested links without starving later candidates behind a slow render.
  return isJsShell(html) || hasEmptyJobsMount(html);
}

function isCareersContentNavigation(posting: RawPosting): boolean {
  try {
    const path = new URL(posting.url).pathname;
    const callToAction = /^(?:learn|read|explore|discover|meet|about|see)\b/i.test(posting.title.trim());
    const contentPath = /\/(?:company-culture|culture|benefits?|diversity|identity|progression|hiring-process|application\/faq)(?:\/|$)/i.test(path);
    const careersNavigationTitle = /^(?:[^|]{0,40}\s+)?(?:growth\s*(?:&|and)\s*careers?|life at .+|how we hire|how to apply|frequently asked questions(?:\s*\(jobs?\))?)$/i.test(posting.title.trim());
    const careersNavigationPath = /\/(?:growth-careers|life-at-[^/]+|how-to-apply|how-we-hire|faq)(?:\.html)?\/?$/i.test(path);
    return (callToAction && contentPath) || (careersNavigationTitle && careersNavigationPath);
  } catch {
    return false;
  }
}

function isExplicitCompleteListingLink(link: HarvestedLink, pageUrl: string, ctx: DiscoveryContext): boolean {
  if (link.kind !== "a" || !sameDomain(link.href, pageUrl) || normalizeUrl(link.href) === normalizeUrl(pageUrl) || ctx.resolveSpec(link.href)) return false;
  const label = link.text.trim() || link.context || "";
  if (/\b(?:(?:all|search)\s+(?:open\s+)?(?:jobs?|roles?|positions?|vacancies|opportunities)|(?:view|explore|browse|see)\s+(?:all\s+)?(?:open\s+)?(?:jobs?|roles?|positions?|vacancies|opportunities))\b/i.test(label)) return true;
  try {
    const target = new URL(link.href);
    return !target.search && /^\/(?:all-jobs?|jobs?|positions?|open-roles?|openings?|vacancies)\/?$/i.test(target.pathname);
  } catch {
    return false;
  }
}

/** Look for ATS references in a page's text, its links, and (optionally) its network requests. */
function collectAtsFromPage(run: Run, ctx: DiscoveryContext, html: string, pageUrl: string, links: HarvestedLink[], via?: string): void {
  const evidenceSuffix = via ? [`via ${via}`] : [];
  // A sitemap URL can redirect through external recruitment infrastructure. That is useful as a
  // candidate, but weaker than an ATS slug linked from a page reached through first-party
  // navigation: sitemaps can contain stale or syndicated job URLs.
  const landingSource = via?.match(/^landing\s+(\S+)/)?.[1];
  const probeRedirectedOffDomain = Boolean(via?.includes("probe_") && landingSource && !sameDomain(pageUrl, landingSource));
  const weakMethod = via === "sitemap" ? "ats_sitemap" : probeRedirectedOffDomain ? "ats_probe" : undefined;
  const linkMethod = weakMethod ?? "ats_link";
  const textMethod = weakMethod ?? "ats_script";
  for (const link of links) {
    const spec = ctx.resolveSpec(link.href);
    if (spec) run.add({ spec, method: linkMethod, evidence: [`link on ${pageUrl}: ${link.href}`, ...evidenceSuffix] });
  }
  for (const spec of ctx.findSpecsInText(html, pageUrl)) {
    run.add({ spec, method: textMethod, evidence: [`reference in ${pageUrl}`, ...evidenceSuffix] });
  }
}

async function scanBundles(run: Run, ctx: DiscoveryContext, links: HarvestedLink[], pageUrl: string): Promise<void> {
  const scripts = links.filter((l) => l.kind === "script" && sameDomain(l.href, pageUrl)).slice(0, MAX_BUNDLES);
  for (const script of scripts) {
    if (!run.budgetLeft()) return;
    // A bundle over the size worth scanning is refused by the fetcher rather than read and dropped.
    const page = await run.fetch(script.href, { maxBodyBytes: MAX_BUNDLE_BYTES });
    if (!page || page.html.length > MAX_BUNDLE_BYTES) continue;
    for (const spec of ctx.findSpecsInText(page.html, script.href)) {
      run.add({ spec, method: "ats_bundle", evidence: [`reference in bundle ${script.href}`] });
    }
  }
}

async function renderAndScan(run: Run, ctx: DiscoveryContext, url: string, via?: string): Promise<Fetched | null> {
  // Discovery needs the page's links and the requests it makes, not every lazily loaded row, so it
  // renders without the scroll-and-expand pass a scan uses.
  const rendered = await run.render(url, { scrollAndExpand: false });
  if (!rendered) return null;
  const { page, requests } = rendered;
  run.say(`rendered ${url} (${requests.length} requests)`);
  for (const request of requests) {
    const spec = ctx.resolveSpec(request);
    if (spec) run.add({ spec, method: "ats_network", evidence: [`network request from ${url}: ${request}`, ...(via ? [`via ${via}`] : [])] });
  }
  const links = harvestLinks(page.html, page.url);
  collectAtsFromPage(run, ctx, page.html, page.url, links, via);
  return page;
}

/** Inspect one candidate page: is it a listing, a landing page, or neither? */
async function inspectPage(run: Run, ctx: DiscoveryContext, url: string, depth: number, via?: string): Promise<void> {
  if (!run.claimInspection(url)) return;
  const page = await run.fetch(url);
  if (!page) return;
  if (normalizeUrl(page.url) !== normalizeUrl(url) && !run.claimInspection(page.url)) return;
  if (looksLikeSoft404(page.html)) {
    run.say(`${url} looks like a soft 404; skipped`);
    run.markMissing(url);
    return;
  }
  if (!run.claimBody(page.html)) {
    run.say(`${url} serves a page already inspected; skipped`);
    run.markMissing(url);
    return;
  }
  let html = page.html;
  let finalUrl = page.url;
  let links = harvestLinks(html, finalUrl);
  collectAtsFromPage(run, ctx, html, finalUrl, links, via);

  let postings = safeExtract(ctx, html, finalUrl);
  if (postings.length === 0 && isExplicitEmptyListing(html, finalUrl)) {
    run.say(`${finalUrl} is an explicitly empty listing`);
    run.add({ spec: { type: "html", url: finalUrl }, method: "listing_empty", evidence: [`explicit no-openings state on ${finalUrl}`], sample: [], count: 0 });
    return;
  }
  if (postings.length < 3 && ctx.render && shouldRenderCandidate(html, finalUrl, via)) {
    const rendered = await renderAndScan(run, ctx, finalUrl, via);
    if (rendered) {
      html = rendered.html;
      finalUrl = rendered.url;
      links = harvestLinks(html, finalUrl);
      postings = safeExtract(ctx, html, finalUrl);
      if (postings.length === 0 && isExplicitEmptyListing(html, finalUrl)) {
        run.say(`${finalUrl} is an explicitly empty listing after rendering`);
        run.add({ spec: { type: "html", url: finalUrl }, method: "listing_empty", evidence: [`explicit no-openings state on rendered ${finalUrl}`], sample: [], count: 0 });
        return;
      }
    }
  }

  if (postings.length >= 3) {
    const method = hasJsonLdJobPosting(html) ? "listing_jsonld" : "listing_html";
    const evidence = [`${postings.length} postings found on ${finalUrl}`, ...(via ? [`via ${via}`] : [])];
    run.say(`${finalUrl} is a listing (${postings.length} postings, ${method})`);
    // Marketing and careers homepages commonly embed a few featured vacancies beside an explicit
    // "All jobs" or "Search roles" link. The embedded cards prove this is a listing, but returning
    // immediately would never inspect the complete listing and would auto-accept a short source.
    const complete = links
      .filter(link => isExplicitCompleteListingLink(link, finalUrl, ctx))
      .map(link => ({ link, score: scoreLink(link, finalUrl, { resolveSpec: ctx.resolveSpec }) }))
      .sort((a, b) => b.score - a.score)[0];
    if (complete) {
      run.say(`${finalUrl} has featured roles; ${depth > 0 ? "checking" : "cannot check"} complete listing ${complete.link.href}`);
      if (depth > 0) await inspectPage(run, ctx, complete.link.href, depth - 1, `complete listing from ${finalUrl}`);
      // The page's own wording says these cards are a subset. It remains a confirmation fallback
      // even when following the declared full listing fails or produces an ATS candidate that is
      // later rejected during verification; a verified full-page candidate naturally outranks it.
      run.add({
        spec: { type: "html", url: finalUrl }, method: "landing",
        evidence: [...evidence, `page declares a distinct complete listing at ${complete.link.href}`],
        sample: postings.slice(0, 3), count: postings.length,
      });
      return;
    }
    const atsBacked = new Map<string, { spec: SourceSpec; count: number }>();
    for (const posting of postings) {
      const spec = ctx.resolveSpec(posting.url);
      if (!spec) continue;
      const key = specKey(spec);
      const seen = atsBacked.get(key);
      atsBacked.set(key, { spec, count: (seen?.count ?? 0) + 1 });
    }
    const dominantAts = [...atsBacked.values()].sort((a, b) => b.count - a.count)[0];
    if (dominantAts && dominantAts.count >= 3 && dominantAts.count / postings.length >= 0.8) {
      run.add({
        spec: { type: "html", url: finalUrl }, method: "landing",
        evidence: [...evidence, `${dominantAts.count} of ${postings.length} posting links point to the same ${dominantAts.spec.type} board`],
        sample: postings.slice(0, 3), count: postings.length,
      });
      return;
    }
    run.add({ spec: { type: "html", url: finalUrl }, method, evidence, sample: postings.slice(0, 3), count: postings.length });
    return;
  }

  const candidatesBeforeHops = run.candidates.size;
  let looksLikeLanding = false;

  if (depth > 0) {
    const onward = links
      .map((link) => ({ link, score: scoreLink(link, finalUrl, { resolveSpec: ctx.resolveSpec }) }))
      .filter((x) => x.score >= 0.5 && normalizeUrl(x.link.href) !== normalizeUrl(finalUrl))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    if (onward.length > 0) {
      looksLikeLanding = true;
      run.say(`${finalUrl} looks like a landing page; following ${onward.length} link(s)`);
      for (const { link } of onward) {
        if (ctx.resolveSpec(link.href)) continue; // already captured as an ATS candidate
        await inspectPage(run, ctx, link.href, depth - 1, `landing ${finalUrl}${via ? ` via ${via}` : ""}`);
      }
      if (run.candidates.size > candidatesBeforeHops) return;
    }
  }

  // The heuristics could not settle it: a page with one or two roles, or a landing page whose links
  // led nowhere. This is where the model earns its place.
  if (ctx.ai?.classifyPage && run.mayClassify()) {
    try {
      const verdict = await ctx.ai.classifyPage({ url: finalUrl, text: stripHtml(html).slice(0, 6000), links: links.slice(0, 120) }, ctx.aiRef);
      run.say(`model classified ${finalUrl} as ${verdict.kind} (${verdict.confidence})`);
      if (verdict.kind === "listing" && verdict.confidence >= 0.7) {
        run.add({ spec: { type: "html", url: finalUrl }, method: "ai_listing", evidence: [`model classified as a listing page`], sample: postings.slice(0, 3), count: postings.length });
        return;
      }
      if (verdict.kind === "landing" && verdict.nextHopUrl && depth > 0) {
        const next = absoluteUrl(verdict.nextHopUrl, finalUrl);
        if (next) {
          await inspectPage(run, ctx, next, depth - 1, `model hop from ${finalUrl}`);
          if (run.candidates.size > candidatesBeforeHops) return;
        }
      }
    } catch (err) {
      run.say(`model classification failed: ${(err as Error).message}`);
    }
  }

  if (looksLikeLanding && run.candidates.size === candidatesBeforeHops) {
    run.add({ spec: { type: "html", url: finalUrl }, method: "landing", evidence: [`careers landing page, no listing within one hop`] });
  }
}

function safeExtract(ctx: DiscoveryContext, html: string, url: string): RawPosting[] {
  try {
    return ctx.extractFromHtml(html, url).filter(posting => !isCareersContentNavigation(posting));
  } catch {
    return [];
  }
}

/**
 * The first `<loc>` of each `<sitemap>` (an index's child sitemaps) and each `<url>` (pages), read
 * tag by tag: each `<loc>` belongs to the container opened most recently before it. With neither
 * container, every `<loc>` is a page. A lazy `<url>[\s\S]*?<loc>` rescanned the rest of the file
 * from every `<url>` that had no `<loc>`.
 */
/** Whether `text` has the lower-case `tag` at `at`, ignoring the case of its letters. */
function tagAt(text: string, at: number, tag: string): boolean {
  if (at + tag.length > text.length) return false;
  for (let i = 0; i < tag.length; i++) {
    let c = text.charCodeAt(at + i);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== tag.charCodeAt(i)) return false;
  }
  return true;
}

export function parseSitemapUrls(xml: string): { sitemaps: string[]; urls: string[] } {
  const text = scanWindow(xml);
  const sitemaps: string[] = [];
  const urls: string[] = [];
  const bare: string[] = [];
  let open: "sitemap" | "url" | undefined;
  for (let at = text.indexOf("<"); at >= 0; at = text.indexOf("<", at + 1)) {
    if (tagAt(text, at, "<url>")) open = "url";
    else if (tagAt(text, at, "<sitemap>")) open = "sitemap";
    else if (tagAt(text, at, "<loc>")) {
      const close = text.indexOf("<", at + 5);
      if (close < 0) break;
      if (!tagAt(text, close, "</loc>")) continue;
      const loc = text.slice(at + 5, close).trim();
      if (bare.length < 2000) bare.push(loc);
      if (open === "sitemap") sitemaps.push(loc);
      else if (open === "url" && urls.length < 2000) urls.push(loc);
      open = undefined;
      at = close;
    }
  }
  if (sitemaps.length === 0 && urls.length === 0) return { sitemaps: [], urls: bare };
  return { sitemaps: sitemaps.slice(0, 2), urls };
}

/**
 * `Sitemap:` lines from robots.txt. The spacing is spaces and tabs only: `^\s*` under the multiline
 * flag ran on across blank lines, rescanning the rest of the file from each of them.
 */
export function sitemapsFromRobots(text: string): string[] {
  return [...scanWindow(text).matchAll(/^[ \t]*sitemap:[ \t]*(\S+)[ \t]*$/gim)].map((m) => m[1] ?? "").filter(Boolean);
}

/** Look through robots.txt and sitemaps for a page that parents several job-detail URLs. */
async function scanSitemaps(run: Run, ctx: DiscoveryContext, origin: string): Promise<string[]> {
  const found: string[] = [];
  const robots = await run.fetch(`${origin}/robots.txt`);
  const sitemapUrls = robots ? sitemapsFromRobots(robots.html) : [];
  if (sitemapUrls.length === 0) sitemapUrls.push(`${origin}/sitemap.xml`);

  const queue = sitemapUrls.slice(0, 2);
  const jobUrls: string[] = [];
  for (let i = 0; i < queue.length && i < 4; i++) {
    const sm = queue[i];
    if (!sm || !run.budgetLeft()) break;
    const page = await run.fetch(sm);
    if (!page) continue;
    const parsed = parseSitemapUrls(page.html);
    for (const child of parsed.sitemaps) {
      if (/career|job|vacanc|position/i.test(child) && queue.length < 4) queue.push(child);
    }
    for (const url of parsed.urls) {
      // A sitemap is allowed to mention arbitrary external sites. It can suggest paths on the
      // company's own registrable domain, but must not lend first-party confidence to another
      // domain's careers or ATS links.
      if (sameDomain(url, origin) && JOB_DETAIL_RE.test(url)) jobUrls.push(url);
    }
  }
  if (jobUrls.length >= 3) {
    // The parent path shared by the job URLs is probably the listing page.
    const parents = new Map<string, number>();
    for (const url of jobUrls) {
      try {
        const u = new URL(url);
        const segs = u.pathname.split("/").filter(Boolean);
        if (segs.length < 2) continue;
        const parent = `${u.origin}/${segs.slice(0, -1).join("/")}`;
        parents.set(parent, (parents.get(parent) ?? 0) + 1);
      } catch {
        /* ignore */
      }
    }
    const best = [...parents.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3) {
      found.push(best[0]);
      run.say(`sitemap suggests ${best[0]} (${best[1]} job URLs beneath it)`);
    }
  }
  return found;
}

// Known public boards are hints: verify both feed availability and company identity each time.
const VERIFIED_BOARDS: Record<string, { url: string; identity: RegExp }> = {
  "anduril.com": { url: "https://job-boards.greenhouse.io/andurilindustries", identity: /\banduril\b/i },
  "waymo.com": { url: "https://job-boards.greenhouse.io/waymo", identity: /^waymo(?:\s+llc)?$/i },
  "withwaymo.com": { url: "https://job-boards.greenhouse.io/waymo", identity: /^waymo(?:\s+llc)?$/i },
};

async function verifiedCatalogueCandidate(url: string, ctx: DiscoveryContext, run: Run): Promise<DiscoveryCandidate | null> {
  const board = VERIFIED_BOARDS[extractDomain(url)];
  if (!board) return null;
  const spec = ctx.resolveSpec(board.url);
  if (!spec) return null;
  const verified = await run.verify(spec);
  if (!verified.ok || !board.identity.test((verified.companyName ?? "").trim())) {
    run.say("catalogue board could not be verified; continuing website discovery");
    return null;
  }
  run.say(`verified catalogue board ${board.url} (${verified.count ?? 0} postings)`);
  return { spec, confidence: 0.98, method: "verified_catalogue",
    evidence: [`Public careers feed verified for ${extractDomain(url)}`, `Feed identity: ${verified.companyName}`],
    sample: verified.sample ?? [], count: verified.count, companyName: verified.companyName };
}

/**
 * Whether anything ties a verified board to this company when its feed names none: the board slug
 * (or Workday tenant) read as a name matches the homepage's company name or the domain's label.
 */
function boardMatchesCompany(spec: SourceSpec, homepageCompanyName: string | undefined, domain: string): boolean {
  const boardName = spec.atsSlug ? nameFromSlug(spec.atsSlug) : undefined;
  if (!boardName) return false;
  return [homepageCompanyName, nameFromDomain(domain)].some((name) => !!name?.trim() && companyNamesMatch(boardName, name));
}

export async function discoverCareersSources(homepageUrl: string, ctx: DiscoveryContext): Promise<DiscoveryResult> {
  const started = Date.now();
  const run = new Run(ctx);
  const normalized = ensureHttpUrl(homepageUrl);
  const result: DiscoveryResult = {
    homepageUrl: normalized,
    outcome: "not_found",
    candidates: [],
    log: run.log,
    fetches: 0,
    durationMs: 0,
  };
  const finish = (): DiscoveryResult => {
    result.fetches = run.fetches;
    result.verifications = run.verifications;
    result.durationMs = Date.now() - started;
    return result;
  };

  const catalogue = await verifiedCatalogueCandidate(normalized, ctx, run);
  if (catalogue) {
    Object.assign(result, { outcome: "resolved", best: catalogue, candidates: [catalogue], companyName: catalogue.companyName });
    return finish();
  }

  let home = await run.fetch(normalized);
  if (!home && ctx.render) {
    // Bot protection on the homepage is the commonest way step 1 fails for a
    // large consumer brand. A real browser usually gets through where plain
    // HTTP is refused, so try that before giving up on the site's own links.
    run.say("homepage could not be fetched over HTTP; rendering with the browser");
    const rendered = await renderAndScan(run, ctx, normalized);
    if (rendered && rendered.status < 400) home = rendered;
  }
  // Whatever happened to the homepage, the careers page is often on another
  // host (careers.acme.com, a hosted ATS board) that is not protected at all,
  // so the probes below run against the site we were given regardless.
  const baseUrl = home?.url ?? normalized;
  const domain = extractDomain(baseUrl);
  let links: HarvestedLink[] = [];

  // The homepage is read here, never again as a candidate page, and a path that answers with the
  // homepage's own body is not a careers page.
  run.claimInspection(normalized);
  run.claimInspection(baseUrl);
  if (home) run.claimBody(home.html);
  const visit = (url: string, via?: string) => inspectPage(run, ctx, url, 1, via);

  if (home) {
    result.finalHomepageUrl = home.url;
    const meta = extractMeta(home.html, home.url);
    result.companyName = meta.siteName ?? companyNameFromTitle(meta.title, domain);
    result.faviconUrl = meta.faviconUrl;
    run.homepageCompanyName = result.companyName;
    run.say(`homepage ${home.url} (company "${result.companyName}")`);

    if (isJsShell(home.html) && ctx.render) {
      run.say("homepage looks like a JavaScript shell; rendering");
      const rendered = await renderAndScan(run, ctx, home.url);
      if (rendered) {
        home = rendered;
        run.claimBody(home.html);
      }
    }

    links = harvestLinks(home.html, home.url);
    collectAtsFromPage(run, ctx, home.html, home.url, links);

    const scored = links
      .filter((l) => l.kind === "a")
      .map((link) => ({ link, score: scoreLink(link, home!.url, { resolveSpec: ctx.resolveSpec }) }))
      .filter((x) => x.score >= 0.4)
      .sort((a, b) => b.score - a.score);
    run.say(`${scored.length} careers-like link(s) on the homepage`);

    for (const { link } of scored.filter((x) => sameDomain(x.link.href, home!.url)).slice(0, MAX_CANDIDATE_PAGES)) {
      if (!run.budgetLeft()) break;
      await visit(link.href, "homepage link");
      if (await run.hasResolvableCandidate()) break;
    }
    // Off-domain careers links (a hosted board on a different domain) are worth one visit each.
    for (const { link } of scored.filter((x) => !sameDomain(x.link.href, home!.url)).slice(0, 2)) {
      if (!run.budgetLeft()) break;
      if (ctx.resolveSpec(link.href)) continue;
      await visit(link.href, "homepage link (off-domain)");
      if (await run.hasResolvableCandidate()) break;
    }
    // Bundles are a comparatively expensive fallback on modern sites. Inspect the explicit
    // careers links first so a page that directly exposes its board is not starved by a row of
    // framework chunks under the same request and time budgets.
    if (!(await run.hasResolvableCandidate())) await scanBundles(run, ctx, links, home.url);
  } else {
    run.say(`could not fetch the homepage ${normalized}; probing careers paths, subdomains, sitemaps and ATS boards directly`);
  }

  // Sites that keep Careers under About or Company, or only in a rendered
  // mega-menu, show nothing careers-like on the homepage itself. Those hub
  // pages are a cheap second harvest — three fetches at most — and come before
  // the blind path probes and long before a model call.
  if (home && !(await run.hasResolvableCandidate())) {
    const origin = new URL(home.url).origin;
    let harvested = 0;
    for (const path of HUB_PATHS) {
      if (!run.budgetLeft() || (await run.hasResolvableCandidate()) || harvested >= 3) break;
      const hub = await run.fetch(`${origin}${path}`);
      if (!hub || looksLikeSoft404(hub.html)) continue;
      harvested++;
      const hubLinks = harvestLinks(hub.html, hub.url);
      collectAtsFromPage(run, ctx, hub.html, hub.url, hubLinks, `hub page ${path}`);
      const hubScored = hubLinks
        .filter((l) => l.kind === "a" && sameDomain(l.href, hub.url))
        .map((link) => ({ link, score: scoreLink(link, hub.url, { resolveSpec: ctx.resolveSpec }) }))
        .filter((x) => x.score >= 0.4)
        .sort((a, b) => b.score - a.score);
      if (hubScored.length) run.say(`${hubScored.length} careers-like link(s) on ${path}`);
      for (const { link } of hubScored.slice(0, 2)) {
        if (!run.budgetLeft()) break;
        await visit(link.href, `hub page ${path}`);
        if (await run.hasResolvableCandidate()) break;
      }
    }
  }

  if (!(await run.hasResolvableCandidate())) {
    const origin = new URL(baseUrl).origin;
    const priorityProbes = [
      `${origin}/careers`, `https://careers.${domain}/`,
      `${origin}/jobs`, `https://jobs.${domain}/`,
      `${origin}/join-us`, `https://join.${domain}/`,
    ];
    const remainingPathProbes = WELL_KNOWN_PATHS
      .map(path => `${origin}${path}`)
      .filter(url => !priorityProbes.some(priority => normalizeUrl(priority) === normalizeUrl(url)));
    // A site that answers 404 (or its own catch-all page) to path after path has none of the
    // well-known ones; the rest of the list would only spend the budget, two paced seconds a probe,
    // that sitemaps and the model need.
    let misses = 0;
    // A homepage given by IP literal has no subdomains: `careers.203.0.113.5` is not an address at
    // all, and building it must not end the run.
    const parseable = (url: string) => { try { new URL(url); return true; } catch { return false; } };
    for (const url of [...priorityProbes, ...remainingPathProbes].filter(parseable)) {
      if (!run.budgetLeft() || (await run.hasResolvableCandidate())) break;
      if (misses >= MAX_CONSECUTIVE_MISSES) {
        run.say(`${misses} probes in a row found nothing; stopping path probes`);
        break;
      }
      await visit(url, new URL(url).origin === origin ? "probe_path" : "probe_subdomain");
      if (run.isMissing(url)) misses++;
      else if (run.statusOf(url) !== undefined) misses = 0;
    }
  }

  if (!(await run.hasResolvableCandidate()) && run.budgetLeft()) {
    const origin = new URL(baseUrl).origin;
    for (const url of await scanSitemaps(run, ctx, origin)) await visit(url, "sitemap");
  }

  if (!(await run.hasResolvableCandidate()) && home && ctx.ai?.chooseCareersLinks && run.budgetLeft()) {
    try {
      const suggestions = await ctx.ai.chooseCareersLinks({ companyName: result.companyName ?? domain, homepageUrl: home.url, links: links.slice(0, 300) }, ctx.aiRef);
      run.say(`model suggested ${suggestions.length} careers link(s)`);
      for (const suggestion of suggestions.slice(0, 2)) {
        const abs = absoluteUrl(suggestion.url, home!.url);
        if (abs) await visit(abs, "model suggestion");
      }
    } catch (err) {
      run.say(`model link suggestion failed: ${(err as Error).message}`);
    }
  }

  if (!(await run.hasResolvableCandidate()) && run.budgetLeft()) {
    const label = domain.split(".")[0];
    if (label) {
      run.say(`nothing found on the site; trying "${label}" as an ATS slug`);
      for (const guess of [`https://boards.greenhouse.io/${label}`, `https://jobs.lever.co/${label}`, `https://jobs.ashbyhq.com/${label}`]) {
        const spec = ctx.resolveSpec(guess);
        if (!spec) continue;
        const verification = await run.verify(spec);
        if (verification.ok && (verification.count ?? 0) > 0) {
          run.add({
            spec,
            method: "ats_guess",
            evidence: [`slug guessed from the domain name; not found on the company's own pages`],
            sample: verification.sample,
            count: verification.count,
            companyName: verification.companyName,
          });
          break;
        }
      }
    }
  }

  // Verify every ATS candidate before it is offered, strongest first, so the verification
  // allowance goes to the candidates most likely to be chosen. Most were verified during the crawl.
  const finalCandidates: DiscoveryCandidate[] = [];
  const failedForNow: Array<{ candidate: RawCandidate; error?: string }> = [];
  for (const candidate of run.ranked()) {
    if (candidate.spec.type === "html") {
      finalCandidates.push({
        spec: candidate.spec,
        confidence: confidenceFor(candidate, { homepageCompanyName: run.homepageCompanyName, methodCount: methodCount(candidate) }),
        method: candidate.method,
        evidence: candidate.evidence,
        sample: candidate.sample ?? [],
        count: candidate.count,
      });
      continue;
    }
    const verification = candidate.method === "ats_guess" && candidate.count !== undefined ? { ok: true, count: candidate.count, sample: candidate.sample, companyName: candidate.companyName } : await run.verify(candidate.spec);
    if (!verification.ok) {
      run.say(`dropped ${candidate.spec.type}/${candidate.spec.atsSlug ?? candidate.spec.url}: ${verification.error ?? "verification failed"}`);
      if ((verification as DiscoveryVerification).transient) failedForNow.push({ candidate, error: verification.error });
      continue;
    }
    const companyName = verification.companyName ?? candidate.companyName;
    const enriched = { ...candidate, companyName, count: verification.count ?? candidate.count };
    const identityUnconfirmed = !companyName && candidate.method !== "ats_guess" && !boardMatchesCompany(candidate.spec, run.homepageCompanyName, domain);
    if (identityUnconfirmed) run.say(`${candidate.spec.type}/${candidate.spec.atsSlug ?? candidate.spec.url} names no company and its board does not match ${domain}; held for confirmation`);
    finalCandidates.push({
      spec: candidate.spec,
      confidence: confidenceFor(enriched, { homepageCompanyName: run.homepageCompanyName, methodCount: methodCount(candidate), identityUnconfirmed }),
      method: candidate.method,
      evidence: identityUnconfirmed ? [...candidate.evidence, "the feed names no company and the board does not match the company's name or domain"] : candidate.evidence,
      sample: verification.sample ?? candidate.sample ?? [],
      count: verification.count ?? candidate.count,
      companyName,
    });
  }

  // A careers landing page often shows featured roles and links to an explicit complete listing.
  // The featured page is held at confirmation confidence above; when the complete page verifies,
  // this evidence preference makes it deterministic without outranking a verified ATS feed.
  const explicitCompleteListing = (candidate: DiscoveryCandidate) => candidate.evidence.some(line => line.startsWith("via complete listing from ")) ? 1 : 0;
  finalCandidates.sort((a, b) =>
    b.confidence - a.confidence
    || rank(b.method) - rank(a.method)
    || explicitCompleteListing(b) - explicitCompleteListing(a),
  );
  result.candidates = finalCandidates.slice(0, 5);
  result.best = result.candidates[0];
  result.outcome = outcomeFor(result.best?.confidence);
  // A refused homepage leaves no title to name the company by; the verified feed's name will do.
  if (!result.companyName && result.best?.companyName) result.companyName = result.best.companyName;
  // A board the host would not answer for now may well be the one: when it would have outranked
  // everything that survived, the result is not trusted and the discovery is tried again later.
  const bestConfidence = result.best?.confidence ?? 0;
  const retryable = failedForNow.find(({ candidate }) => result.outcome !== "resolved" && confidenceFor(candidate, { methodCount: methodCount(candidate) }) > bestConfidence);
  if (retryable) {
    result.retry = `${retryable.candidate.spec.type}/${retryable.candidate.spec.atsSlug ?? retryable.candidate.spec.url} could not be verified for now (${retryable.error ?? "temporary failure"})`;
    run.say(`retry later: ${result.retry}`);
  }
  if (result.candidates.length === 0) run.say("no careers source found");
  else run.say(`best: ${result.best?.spec.type} ${result.best?.spec.atsSlug ?? result.best?.spec.url} at ${result.best?.confidence} (${result.best?.method}) -> ${result.outcome}`);
  return finish();
}

function methodCount(candidate: RawCandidate): number {
  const extra = candidate.evidence.filter((e) => e.startsWith("method:")).length;
  return 1 + extra;
}

/** For a user-pasted URL and for verifying company suggestions. */
export async function probeUrlAsSource(url: string, ctx: DiscoveryContext): Promise<DiscoveryResult> {
  const started = Date.now();
  const normalized = ensureHttpUrl(url);
  const run = new Run(ctx);
  const done = (result: Omit<DiscoveryResult, "homepageUrl" | "log" | "fetches" | "verifications" | "durationMs">): DiscoveryResult =>
    ({ homepageUrl: normalized, ...result, log: run.log, fetches: run.fetches, verifications: run.verifications, durationMs: Date.now() - started });
  const catalogue = await verifiedCatalogueCandidate(normalized, ctx, run);
  if (catalogue) return done({ outcome: "resolved", best: catalogue, candidates: [catalogue], companyName: catalogue.companyName });
  const spec = ctx.resolveSpec(normalized);
  if (spec) {
    const verification = await run.verify(spec);
    if (verification.ok) {
      const candidate: DiscoveryCandidate = {
        spec,
        confidence: confidenceFor({ method: "pasted_ats", companyName: verification.companyName, count: verification.count }, {}),
        method: "pasted_ats",
        evidence: [`resolved directly from ${normalized}`],
        sample: verification.sample ?? [],
        count: verification.count,
        // The feed's own name when the adapter reads one; otherwise the board slug, which the
        // company chose (`hims-and-hers`), beats the domain label the row was created with.
        companyName: verification.companyName ?? (spec.atsSlug ? nameFromSlug(spec.atsSlug) : undefined),
      };
      run.say(`${normalized} is a ${spec.type} board (${verification.count ?? 0} postings)`);
      return done({ outcome: "resolved", best: candidate, candidates: [candidate], companyName: candidate.companyName });
    }
    // A pasted board is the answer or nothing: treating the vendor's URL as a homepage would crawl
    // the vendor's own site and could offer the vendor's own board for this company.
    run.say(`${normalized} looks like a ${spec.type} board but verification failed: ${verification.error}`);
    const retry = verification.transient ? `${spec.type}/${spec.atsSlug ?? spec.url} could not be verified for now (${verification.error ?? "temporary failure"})` : undefined;
    return done({ outcome: "not_found", candidates: [], retry });
  }

  const page = await run.fetch(normalized);
  if (page && !looksLikeSoft404(page.html)) {
    const links = harvestLinks(page.html, page.url);
    collectAtsFromPage(run, ctx, page.html, page.url, links);
    let postings = safeExtract(ctx, page.html, page.url);
    if (postings.length < 3 && isJsShell(page.html) && ctx.render) {
      const rendered = await renderAndScan(run, ctx, page.url);
      if (rendered) postings = safeExtract(ctx, rendered.html, rendered.url);
    }
    const domain = extractDomain(page.url);
    for (const candidate of run.ranked()) {
      const verification = await run.verify(candidate.spec);
      if (!verification.ok) continue;
      const identityUnconfirmed = !verification.companyName && !boardMatchesCompany(candidate.spec, undefined, domain);
      const best: DiscoveryCandidate = {
        spec: candidate.spec,
        confidence: confidenceFor({ ...candidate, companyName: verification.companyName }, { methodCount: 1, identityUnconfirmed }),
        method: candidate.method,
        evidence: candidate.evidence,
        sample: verification.sample ?? [],
        count: verification.count,
        companyName: verification.companyName,
      };
      return done({ outcome: outcomeFor(best.confidence), best, candidates: [best], companyName: best.companyName });
    }
    if (postings.length >= 3) {
      const candidate: DiscoveryCandidate = {
        spec: { type: "html", url: page.url },
        confidence: confidenceFor({ method: "pasted_listing" }, {}),
        method: "pasted_listing",
        evidence: [`${postings.length} postings found on the pasted page`],
        sample: postings.slice(0, 3),
        count: postings.length,
      };
      return done({ outcome: "resolved", best: candidate, candidates: [candidate] });
    }
  }

  run.say(`${normalized} is not a board or listing; treating it as a homepage`);
  const full = await discoverCareersSources(normalized, { ...ctx, maxFetches: Math.min(ctx.maxFetches ?? 15, 15) });
  full.log = [...run.log, ...full.log];
  full.fetches += run.fetches;
  full.verifications = (full.verifications ?? 0) + run.verifications;
  return full;
}

export { Run as _DiscoveryRunForTests };
