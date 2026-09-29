import { ats, IncompleteListingError, normalizeUrl, type FetchContext, type RawPosting, type SourceSpec } from "@ava/core";

/**
 * Uncached, AI-free HTML observation for the public acceptance diagnostic. The worker's real
 * scan additionally supports persisted recipes/caches and AI recovery. Keep the same essential
 * safety rule: unparsed markup is not evidence of an empty board. Never call a stopped traversal
 * complete, even when useful postings were collected before it stopped.
 */
export async function observeHtmlListing(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const postings = new Map<string, RawPosting>();
  const seen = new Set<string>();
  const add = (items: RawPosting[]) => { for (const item of items) postings.set(normalizeUrl(item.url), item); };
  const incomplete = (message: string): never => { throw new IncompleteListingError(message, [...postings.values()]); };
  let next: string | null = spec.url;
  for (let pageIndex = 0; next && pageIndex < 20; pageIndex++) {
    const key = normalizeUrl(next);
    if (seen.has(key)) incomplete("HTML pagination revisited a page; completeness is unverified");
    seen.add(key);
    try {
      const page = await ats.fetchHtmlPage({ ...spec, url: next }, ctx);
      const items = ats.extractPostingsFromHtml(page.html, page.url, spec.recipe);
      const nextPage = ats.nextListingPage(page.html, page.url);
      const externalContinuation = ats.hasUnfollowableListingContinuation(page.html, page.url);
      const expandable = !nextPage && ats.hasListingExpansionControl(page.html, page.url);
      const wantsRender = items.length === 0 || expandable;
      if (wantsRender && ctx.render) {
        // Preserve useful HTTP items if the browser fails or admits incomplete traversal.
        add(items);
        const rendered = await ctx.render(page.url, { scrollAndExpand: true });
        if (rendered.status !== null && rendered.status >= 400) incomplete(`HTML browser returned HTTP ${rendered.status}`);
        const captures = rendered.listingPages?.length ? rendered.listingPages : [{ html: rendered.html, url: rendered.finalUrl }];
        let confirmedCapture = false;
        let unverifiedAfterConfirmation = false;
        for (const capture of captures) {
          const captured = ats.extractPostingsFromHtml(capture.html, capture.url, spec.recipe);
          add(captured);
          if (captured.length || ats.isExplicitEmptyListing(capture.html, capture.url)) confirmedCapture = true;
          else if (confirmedCapture) unverifiedAfterConfirmation = true;
        }
        if (externalContinuation || captures.some(capture => ats.hasUnfollowableListingContinuation(capture.html, capture.url)))
          incomplete("HTML listing advertises a next page on another origin; completeness is unverified");
        const lastCapture = captures[captures.length - 1]!;
        if (ats.hasListingExpansionControl(lastCapture.html, lastCapture.url) && !ats.nextListingPage(lastCapture.html, lastCapture.url))
          incomplete("HTML final browser capture still has an unvisited expansion control");
        if (rendered.incomplete || !confirmedCapture || unverifiedAfterConfirmation) incomplete("HTML browser did not establish a complete listing or a verified empty state");
        // The renderer can click visible controls but not a head <link rel="next">. Preserve
        // any advertised page it did not capture, including one exposed by its final capture.
        const capturedUrls = new Set(captures.map(capture => normalizeUrl(capture.url)));
        const continuations = [nextPage, ...captures.map(capture => ats.nextListingPage(capture.html, capture.url))];
        next = continuations.find(candidate => candidate && !capturedUrls.has(normalizeUrl(candidate))) ?? null;
        if (postings.size >= 500 && next) incomplete("HTML observation reached its posting limit with more pages to read");
        if (next) continue;
        return [...postings.values()];
      }
      add(items);
      if (externalContinuation) incomplete("HTML listing advertises a next page on another origin; completeness is unverified");
      if (!items.length && !ats.isExplicitEmptyListing(page.html, page.url)) incomplete("HTML extraction found no verifiable postings; an empty board is unproven");
      if (expandable) incomplete("HTML listing has an unvisited expansion control; enable the browser to observe it");
      next = nextPage;
      if (postings.size >= 500 && next) incomplete("HTML observation reached its posting limit with more pages to read");
    } catch (error) {
      if (error instanceof IncompleteListingError) throw error;
      if (postings.size) incomplete(`HTML traversal failed after reading postings: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  if (next) incomplete("HTML observation reached its page limit with more pages to read");
  return [...postings.values()];
}
