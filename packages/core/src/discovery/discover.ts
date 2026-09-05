/**
 * Careers-source discovery. Given a homepage URL, find the page or feed that lists the company's jobs.
 * See docs/SPEC.md section 3.2. Every step adds candidates with a method; the best one decides the outcome.
 */
import { absoluteUrl, ensureHttpUrl, extractDomain, normalizeUrl, sameDomain, stripHtml } from "../normalize";
import type { RawPosting, SourceSpec } from "../types";
import { confidenceFor, outcomeFor } from "./confidence";
import { countAnchors, extractMeta, harvestLinks, scoreLink, WELL_KNOWN_PATHS } from "./links";
import { companyNameFromTitle, looksLikeSoft404 } from "./text";
import type { DiscoveryCandidate, DiscoveryContext, DiscoveryResult, HarvestedLink } from "./types";

const JOB_DETAIL_RE = /\/(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|opportunit(?:y|ies))\//i;
const MAX_CANDIDATE_PAGES = 4;
const MAX_BUNDLES = 8;
const MAX_BUNDLE_BYTES = 2_000_000;

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
  private readonly verified = new Map<string, { ok: boolean; count?: number; sample?: RawPosting[]; companyName?: string; error?: string }>();
  fetches = 0;
  readonly maxFetches: number;
  homepageCompanyName?: string;

  constructor(private readonly ctx: DiscoveryContext) {
    this.maxFetches = ctx.maxFetches ?? 40;
  }

  say(msg: string): void {
    this.log.push(msg);
    this.ctx.log?.(`discovery: ${msg}`);
  }

  budgetLeft(): boolean {
    if (this.fetches < this.maxFetches) return true;
    if (!this.log.some((l) => l.startsWith("fetch budget"))) this.say(`fetch budget of ${this.maxFetches} exhausted; stopping early`);
    return false;
  }

  async fetch(url: string): Promise<Fetched | null> {
    const key = normalizeUrl(url);
    const cached = this.pages.get(key);
    if (cached !== undefined) return cached;
    if (!this.budgetLeft()) return null;
    this.fetches++;
    try {
      const res = await this.ctx.fetchText(url);
      if (res.status >= 400) {
        this.say(`fetch ${url} -> HTTP ${res.status}`);
        this.pages.set(key, null);
        return null;
      }
      const page: Fetched = { html: res.body, url: res.url || url, status: res.status };
      this.pages.set(key, page);
      return page;
    } catch (err) {
      this.say(`fetch ${url} failed: ${(err as Error).message}`);
      this.pages.set(key, null);
      return null;
    }
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

  async verify(spec: SourceSpec) {
    const key = specKey(spec);
    const cached = this.verified.get(key);
    if (cached) return cached;
    if (!this.budgetLeft()) return { ok: false, error: "fetch budget exhausted" };
    this.fetches++;
    try {
      const result = await this.ctx.verifySpec(spec);
      this.verified.set(key, result);
      return result;
    } catch (err) {
      const result = { ok: false, error: (err as Error).message };
      this.verified.set(key, result);
      return result;
    }
  }
}

function specKey(spec: SourceSpec): string {
  return `${spec.type}|${spec.atsSlug ?? ""}|${spec.atsSite ?? ""}|${spec.atsSlug ? "" : normalizeUrl(spec.url)}`;
}

const METHOD_RANK: Record<string, number> = {
  ats_network: 9, pasted_ats: 9, ats_link: 8, ats_script: 8, ats_bundle: 7,
  listing_jsonld: 6, listing_html: 6, pasted_listing: 6, ai_listing: 5, ats_guess: 3, landing: 1,
};
function rank(method: string): number {
  return METHOD_RANK[method] ?? 0;
}

function hasJsonLdJobPosting(html: string): boolean {
  return /application\/ld\+json/i.test(html) && /"JobPosting"/i.test(html);
}

function isJsShell(html: string): boolean {
  return countAnchors(html) < 5 || stripHtml(html).length < 400;
}

/** Look for ATS references in a page's text, its links, and (optionally) its network requests. */
function collectAtsFromPage(run: Run, ctx: DiscoveryContext, html: string, pageUrl: string, links: HarvestedLink[], via?: string): void {
  const evidenceSuffix = via ? [`via ${via}`] : [];
  for (const link of links) {
    const spec = ctx.resolveSpec(link.href);
    if (spec) run.add({ spec, method: "ats_link", evidence: [`link on ${pageUrl}: ${link.href}`, ...evidenceSuffix] });
  }
  for (const spec of ctx.findSpecsInText(html, pageUrl)) {
    run.add({ spec, method: "ats_script", evidence: [`reference in ${pageUrl}`, ...evidenceSuffix] });
  }
}

async function scanBundles(run: Run, ctx: DiscoveryContext, links: HarvestedLink[], pageUrl: string): Promise<void> {
  const scripts = links.filter((l) => l.kind === "script" && sameDomain(l.href, pageUrl)).slice(0, MAX_BUNDLES);
  for (const script of scripts) {
    if (!run.budgetLeft()) return;
    const page = await run.fetch(script.href);
    if (!page || page.html.length > MAX_BUNDLE_BYTES) continue;
    for (const spec of ctx.findSpecsInText(page.html, script.href)) {
      run.add({ spec, method: "ats_bundle", evidence: [`reference in bundle ${script.href}`] });
    }
  }
}

async function renderAndScan(run: Run, ctx: DiscoveryContext, url: string, via?: string): Promise<Fetched | null> {
  if (!ctx.render || !run.budgetLeft()) return null;
  run.fetches++;
  try {
    const rendered = await ctx.render(url, { scrollAndExpand: true });
    run.say(`rendered ${url} (${rendered.requests.length} requests)`);
    for (const request of rendered.requests) {
      const spec = ctx.resolveSpec(request);
      if (spec) run.add({ spec, method: "ats_network", evidence: [`network request from ${url}: ${request}`, ...(via ? [`via ${via}`] : [])] });
    }
    const links = harvestLinks(rendered.html, rendered.finalUrl);
    collectAtsFromPage(run, ctx, rendered.html, rendered.finalUrl, links, via);
    return { html: rendered.html, url: rendered.finalUrl, status: rendered.status ?? 200 };
  } catch (err) {
    run.say(`render ${url} failed: ${(err as Error).message}`);
    return null;
  }
}

/** Inspect one candidate page: is it a listing, a landing page, or neither? */
async function inspectPage(run: Run, ctx: DiscoveryContext, url: string, depth: number, via?: string): Promise<void> {
  const page = await run.fetch(url);
  if (!page) return;
  if (looksLikeSoft404(page.html)) {
    run.say(`${url} looks like a soft 404; skipped`);
    return;
  }
  let html = page.html;
  let finalUrl = page.url;
  let links = harvestLinks(html, finalUrl);
  collectAtsFromPage(run, ctx, html, finalUrl, links, via);

  let postings = safeExtract(ctx, html, finalUrl);
  if (postings.length < 3 && isJsShell(html) && ctx.render) {
    const rendered = await renderAndScan(run, ctx, finalUrl, via);
    if (rendered) {
      html = rendered.html;
      finalUrl = rendered.url;
      links = harvestLinks(html, finalUrl);
      postings = safeExtract(ctx, html, finalUrl);
    }
  }

  if (postings.length >= 3) {
    const method = hasJsonLdJobPosting(html) ? "listing_jsonld" : "listing_html";
    run.add({
      spec: { type: "html", url: finalUrl },
      method,
      evidence: [`${postings.length} postings found on ${finalUrl}`, ...(via ? [`via ${via}`] : [])],
      sample: postings.slice(0, 3),
      count: postings.length,
    });
    run.say(`${finalUrl} is a listing (${postings.length} postings, ${method})`);
    return;
  }

  if (depth > 0) {
    const onward = links
      .map((link) => ({ link, score: scoreLink(link, finalUrl, { resolveSpec: ctx.resolveSpec }) }))
      .filter((x) => x.score >= 0.5 && normalizeUrl(x.link.href) !== normalizeUrl(finalUrl))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    if (onward.length > 0) {
      run.say(`${finalUrl} looks like a landing page; following ${onward.length} link(s)`);
      const before = run.candidates.size;
      for (const { link } of onward) {
        if (ctx.resolveSpec(link.href)) continue; // already captured as an ATS candidate
        await inspectPage(run, ctx, link.href, depth - 1, `landing ${finalUrl}`);
      }
      if (run.candidates.size === before) {
        run.add({ spec: { type: "html", url: finalUrl }, method: "landing", evidence: [`careers landing page, no listing within one hop`] });
      }
      return;
    }
  }

  if (ctx.ai?.classifyPage) {
    try {
      const verdict = await ctx.ai.classifyPage({ url: finalUrl, text: stripHtml(html).slice(0, 6000), links: links.slice(0, 120) });
      run.say(`model classified ${finalUrl} as ${verdict.kind} (${verdict.confidence})`);
      if (verdict.kind === "listing" && verdict.confidence >= 0.7) {
        run.add({ spec: { type: "html", url: finalUrl }, method: "ai_listing", evidence: [`model classified as a listing page`], sample: postings.slice(0, 3), count: postings.length });
        return;
      }
      if (verdict.kind === "landing" && verdict.nextHopUrl && depth > 0) {
        const next = absoluteUrl(verdict.nextHopUrl, finalUrl);
        if (next) await inspectPage(run, ctx, next, depth - 1, `model hop from ${finalUrl}`);
        return;
      }
    } catch (err) {
      run.say(`model classification failed: ${(err as Error).message}`);
    }
  }
}

function safeExtract(ctx: DiscoveryContext, html: string, url: string): RawPosting[] {
  try {
    return ctx.extractFromHtml(html, url);
  } catch {
    return [];
  }
}

function parseSitemapUrls(xml: string): { sitemaps: string[]; urls: string[] } {
  const sitemaps = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi)].map((m) => (m[1] ?? "").trim());
  const urls = [...xml.matchAll(/<url>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/url>/gi)].map((m) => (m[1] ?? "").trim());
  if (sitemaps.length === 0 && urls.length === 0) {
    const bare = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) => (m[1] ?? "").trim());
    return { sitemaps: [], urls: bare.slice(0, 2000) };
  }
  return { sitemaps: sitemaps.slice(0, 2), urls: urls.slice(0, 2000) };
}

/** Look through robots.txt and sitemaps for a page that parents several job-detail URLs. */
async function scanSitemaps(run: Run, ctx: DiscoveryContext, origin: string): Promise<string[]> {
  const found: string[] = [];
  const robots = await run.fetch(`${origin}/robots.txt`);
  const sitemapUrls = robots
    ? [...robots.html.matchAll(/^\s*sitemap:\s*(\S+)\s*$/gim)].map((m) => (m[1] ?? "").trim()).filter(Boolean)
    : [];
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
      if (JOB_DETAIL_RE.test(url)) jobUrls.push(url);
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

  let home = await run.fetch(normalized);
  if (!home) {
    run.say(`could not fetch the homepage ${normalized}`);
    result.fetches = run.fetches;
    result.durationMs = Date.now() - started;
    return result;
  }
  result.finalHomepageUrl = home.url;
  const domain = extractDomain(home.url);
  const meta = extractMeta(home.html, home.url);
  result.companyName = meta.siteName ?? companyNameFromTitle(meta.title, domain);
  result.faviconUrl = meta.faviconUrl;
  run.homepageCompanyName = result.companyName;
  run.say(`homepage ${home.url} (company "${result.companyName}")`);

  if (isJsShell(home.html) && ctx.render) {
    run.say("homepage looks like a JavaScript shell; rendering");
    const rendered = await renderAndScan(run, ctx, home.url);
    if (rendered) home = rendered;
  }

  let links = harvestLinks(home.html, home.url);
  collectAtsFromPage(run, ctx, home.html, home.url, links);
  await scanBundles(run, ctx, links, home.url);

  const scored = links
    .filter((l) => l.kind === "a")
    .map((link) => ({ link, score: scoreLink(link, home!.url, { resolveSpec: ctx.resolveSpec }) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score);
  run.say(`${scored.length} careers-like link(s) on the homepage`);

  const visited = new Set<string>([normalizeUrl(home.url)]);
  const visit = async (url: string, via?: string) => {
    const key = normalizeUrl(url);
    if (visited.has(key)) return;
    visited.add(key);
    await inspectPage(run, ctx, url, 1, via);
  };

  for (const { link } of scored.filter((x) => sameDomain(x.link.href, home!.url)).slice(0, MAX_CANDIDATE_PAGES)) {
    if (!run.budgetLeft()) break;
    await visit(link.href, "homepage link");
  }
  // Off-domain careers links (a hosted board on a different domain) are worth one visit each.
  for (const { link } of scored.filter((x) => !sameDomain(x.link.href, home!.url)).slice(0, 2)) {
    if (!run.budgetLeft()) break;
    if (ctx.resolveSpec(link.href)) continue;
    await visit(link.href, "homepage link (off-domain)");
  }

  if (run.candidates.size === 0) {
    const origin = new URL(home.url).origin;
    for (const path of WELL_KNOWN_PATHS) {
      if (!run.budgetLeft() || run.candidates.size > 0) break;
      await visit(`${origin}${path}`, "probe_path");
    }
    for (const prefix of ["careers", "jobs", "join"]) {
      if (!run.budgetLeft() || run.candidates.size > 0) break;
      await visit(`https://${prefix}.${domain}/`, "probe_subdomain");
    }
  }

  if (run.candidates.size === 0 && run.budgetLeft()) {
    const origin = new URL(home.url).origin;
    for (const url of await scanSitemaps(run, ctx, origin)) await visit(url, "sitemap");
  }

  if (run.candidates.size === 0 && ctx.ai?.chooseCareersLinks && run.budgetLeft()) {
    try {
      const suggestions = await ctx.ai.chooseCareersLinks({ companyName: result.companyName ?? domain, homepageUrl: home.url, links: links.slice(0, 300) });
      run.say(`model suggested ${suggestions.length} careers link(s)`);
      for (const suggestion of suggestions.slice(0, 2)) {
        const abs = absoluteUrl(suggestion.url, home.url);
        if (abs) await visit(abs, "model suggestion");
      }
    } catch (err) {
      run.say(`model link suggestion failed: ${(err as Error).message}`);
    }
  }

  if (run.candidates.size === 0 && run.budgetLeft()) {
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

  // Verify every ATS candidate before it is offered.
  const finalCandidates: DiscoveryCandidate[] = [];
  for (const candidate of run.candidates.values()) {
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
      continue;
    }
    const enriched = { ...candidate, companyName: verification.companyName ?? candidate.companyName, count: verification.count ?? candidate.count };
    finalCandidates.push({
      spec: candidate.spec,
      confidence: confidenceFor(enriched, { homepageCompanyName: run.homepageCompanyName, methodCount: methodCount(candidate) }),
      method: candidate.method,
      evidence: candidate.evidence,
      sample: verification.sample ?? candidate.sample ?? [],
      count: verification.count ?? candidate.count,
      companyName: verification.companyName ?? candidate.companyName,
    });
  }

  finalCandidates.sort((a, b) => b.confidence - a.confidence || rank(b.method) - rank(a.method));
  result.candidates = finalCandidates.slice(0, 5);
  result.best = result.candidates[0];
  result.outcome = outcomeFor(result.best?.confidence);
  result.fetches = run.fetches;
  result.durationMs = Date.now() - started;
  if (result.candidates.length === 0) run.say("no careers source found");
  else run.say(`best: ${result.best?.spec.type} ${result.best?.spec.atsSlug ?? result.best?.spec.url} at ${result.best?.confidence} (${result.best?.method}) -> ${result.outcome}`);
  return result;
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
        companyName: verification.companyName,
      };
      run.say(`${normalized} is a ${spec.type} board (${verification.count ?? 0} postings)`);
      return { homepageUrl: normalized, outcome: "resolved", best: candidate, candidates: [candidate], log: run.log, fetches: run.fetches, durationMs: Date.now() - started };
    }
    run.say(`${normalized} looks like a ${spec.type} board but verification failed: ${verification.error}`);
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
    const atsCandidates = [...run.candidates.values()];
    for (const candidate of atsCandidates) {
      const verification = await run.verify(candidate.spec);
      if (!verification.ok) continue;
      const best: DiscoveryCandidate = {
        spec: candidate.spec,
        confidence: confidenceFor({ ...candidate, companyName: verification.companyName }, {}),
        method: candidate.method,
        evidence: candidate.evidence,
        sample: verification.sample ?? [],
        count: verification.count,
        companyName: verification.companyName,
      };
      return { homepageUrl: normalized, outcome: outcomeFor(best.confidence), best, candidates: [best], log: run.log, fetches: run.fetches, durationMs: Date.now() - started };
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
      return { homepageUrl: normalized, outcome: "resolved", best: candidate, candidates: [candidate], log: run.log, fetches: run.fetches, durationMs: Date.now() - started };
    }
  }

  run.say(`${normalized} is not a board or listing; treating it as a homepage`);
  const full = await discoverCareersSources(normalized, { ...ctx, maxFetches: Math.min(ctx.maxFetches ?? 15, 15) });
  full.log = [...run.log, ...full.log];
  full.fetches += run.fetches;
  return full;
}
