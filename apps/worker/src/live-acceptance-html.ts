import { ats, IncompleteListingError, looksRemote, normalizeUrl, type FetchContext, type RawPosting, type SourceSpec } from "@col/core";
import { listingCaptures } from "./listing-captures";

/**
 * Uncached, AI-free HTML observation for the public acceptance diagnostic. The worker's real
 * scan additionally supports persisted recipes/caches and AI recovery. Keep the same essential
 * safety rule: unparsed markup is not evidence of an empty board. Never call a stopped traversal
 * complete, even when useful postings were collected before it stopped.
 */
export async function observeHtmlListing(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const postings = new Map<string, RawPosting>();
  const postingBytes = new Map<string, number>();
  let metadataBytes = 0;
  let postingCapExceeded = false;
  const seen = new Set<string>();
  const add = (items: RawPosting[]) => {
    for (const item of items) {
      const key = normalizeUrl(item.url);
      const previous = postings.get(key);
      const locations = new Set([...(previous?.locations ?? []), ...(previous?.location ? [previous.location] : []),
        ...(item.locations ?? []), ...(item.location ? [item.location] : [])]);
      const merged = previous ? { ...previous, locations: [...locations], remote: previous.remote || item.remote || [...locations].some(looksRemote) || undefined } : item;
      const bytes = Buffer.byteLength(JSON.stringify(merged), "utf8");
      const previousBytes = postingBytes.get(key) ?? 0;
      if ((!postingBytes.has(key) && postings.size >= ats.MAX_POSTINGS) || metadataBytes - previousBytes + bytes > 4_000_000) {
        postingCapExceeded = true;
        break;
      }
      postings.set(key, merged);
      postingBytes.set(key, bytes);
      metadataBytes += bytes - previousBytes;
    }
  };
  const incomplete = (message: string): never => { throw new IncompleteListingError(message, [...postings.values()]); };
  let advertisedTotal = 0;
  let next: string | null = spec.url;
  for (let pageIndex = 0; next && pageIndex < 20; pageIndex++) {
    const key = normalizeUrl(next);
    if (seen.has(key)) incomplete("HTML pagination revisited a page; completeness is unverified");
    seen.add(key);
    try {
      const page = await ats.fetchHtmlPage({ ...spec, url: next }, ctx);
      advertisedTotal = Math.max(advertisedTotal, ats.advertisedDistinctJobTotal(page.html) ?? 0);
      const items = ats.extractPostingsFromHtml(page.html, page.url, spec.recipe);
      const nextPage = ats.nextListingPage(page.html, page.url);
      const externalContinuation = ats.hasUnfollowableListingContinuation(page.html, page.url);
      const expandable = !nextPage && ats.hasListingExpansionControl(page.html, page.url);
      const wantsRender = items.length === 0 || expandable;
      if (wantsRender && ctx.render) {
        // Preserve useful HTTP items if the browser fails or admits incomplete traversal.
        add(items);
        if (postingCapExceeded) incomplete("HTML listing exceeded its posting or parsed-metadata limit");
        const rendered = await ctx.render(page.url, { scrollAndExpand: true });
        if (rendered.status !== null && rendered.status >= 400) incomplete(`HTML browser returned HTTP ${rendered.status}`);
        let confirmedCapture = false;
        let unverifiedAfterConfirmation = false;
        let externalCapturedContinuation = false;
        let finalExpansionPending = false;
        const capturedUrls = new Set<string>();
        const continuations: string[] = [];
        for (const capture of listingCaptures(rendered)) {
          advertisedTotal = Math.max(advertisedTotal, ats.advertisedDistinctJobTotal(capture.html) ?? 0);
          const captured = ats.extractPostingsFromHtml(capture.html, capture.url, spec.recipe);
          add(captured);
          if (postingCapExceeded) incomplete("HTML listing exceeded its posting or parsed-metadata limit");
          if (captured.length || ats.isExplicitEmptyListing(capture.html, capture.url)) confirmedCapture = true;
          else if (confirmedCapture) unverifiedAfterConfirmation = true;
          externalCapturedContinuation ||= ats.hasUnfollowableListingContinuation(capture.html, capture.url);
          const nextCaptured = ats.nextListingPage(capture.html, capture.url);
          if (nextCaptured) continuations.push(nextCaptured);
          finalExpansionPending = ats.hasListingExpansionControl(capture.html, capture.url) && !nextCaptured;
          capturedUrls.add(normalizeUrl(capture.url));
        }
        if (externalContinuation || externalCapturedContinuation)
          incomplete("HTML listing advertises a next page on another origin; completeness is unverified");
        if (finalExpansionPending)
          incomplete("HTML final browser capture still has an unvisited expansion control");
        if (rendered.incomplete || !confirmedCapture || unverifiedAfterConfirmation) incomplete("HTML browser did not establish a complete listing or a verified empty state");
        // The renderer can click visible controls but not a head <link rel="next">. Preserve
        // any advertised page it did not capture, including one exposed by its final capture.
        next = [nextPage, ...continuations].find(candidate => candidate && !capturedUrls.has(normalizeUrl(candidate))) ?? null;
        if (postings.size >= 500 && next) incomplete("HTML observation reached its posting limit with more pages to read");
        if (next) continue;
        if (postings.size < advertisedTotal) incomplete(`HTML listing advertised ${advertisedTotal} distinct jobs but verified ${postings.size}`);
        return [...postings.values()];
      }
      add(items);
      if (postingCapExceeded) incomplete("HTML listing exceeded its posting or parsed-metadata limit");
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
  if (postings.size < advertisedTotal) incomplete(`HTML listing advertised ${advertisedTotal} distinct jobs but verified ${postings.size}`);
  return [...postings.values()];
}
