/**
 * Headless Chromium rendering with network sniffing. Used when a careers page is a JavaScript shell.
 * One browser per process, one context per render, images/fonts/media blocked.
 *
 * The page is somebody else's code running inside the worker's network, so every request it makes
 * — the navigation, each redirect hop, every script, fetch and frame, every WebSocket — passes the
 * same address guard as the fetcher before it is sent. Chromium resolves names itself, so a name
 * that answers public to the guard and private to Chromium a moment later is not caught here.
 */
import { SourceFetchError, type RenderedPage } from "@col/core";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { AddressGuard, explicitBotChallenge, type HttpTrafficLedger, type ResolveHost } from "./fetcher";
import { MAX_DECODED_LISTING_BYTES } from "./listing-captures";
import { log } from "./log";
import { within } from "./timers";

type Playwright = typeof import("playwright");
type Browser = import("playwright").Browser;
type BrowserContext = import("playwright").BrowserContext;

export interface RenderOptions {
  scrollAndExpand?: boolean;
  /** Additional deny-only, run-local guard for every request and WebSocket. */
  allowHost?: (hostname: string) => void | Promise<void>;
  /** Gives the render up: a queued one leaves the queue, a running one has its page closed. */
  signal?: AbortSignal;
}

/** What `render` needs to reach inside a render it is giving up on. */
interface RenderJob {
  context?: BrowserContext;
  /** Set when the deadline or the signal won: whatever the render does afterwards is discarded. */
  abandoned: boolean;
}

/**
 * How long Chromium is kept after its last render. It costs about 100 MiB outside V8 while it sits
 * there, and renders come in bursts (a discovery, a scan of a JavaScript board) hours apart; a
 * relaunch costs a second or two on the first render after a quiet spell.
 */
export const BROWSER_IDLE_CLOSE_MS = 5 * 60_000;

/** The longest one render may take, navigation to last snapshot, before its page is closed. */
export const RENDER_TIMEOUT_MS = 60_000;
/** Each decoded page and all retained compressed captures have this separate byte ceiling. */
export const MAX_RENDER_BYTES = MAX_DECODED_LISTING_BYTES;
/** A hard safeguard; the render deadline will usually stop changing listings sooner. */
export const MAX_LISTING_STEPS = 100;
/** How many elements whose text reads as a listing control are examined on one pass. */
const MAX_LISTING_CONTROL_CANDIDATES = 200;

export interface BrowserOptions {
  userAgent: string;
  executablePath?: string;
  hostMap?: Record<string, string>;
  navigationTimeoutMs?: number;
  concurrency?: number;
  /** Politeness for one navigation: reserved once, before the page is opened, never per subresource. */
  beforeNavigate?: (host: string) => Promise<void>;
  /** Robots/policy guard for every top-level document request, including redirects. */
  allowNavigate?: (url: string, allowHost?: RenderOptions["allowHost"]) => Promise<void>;
  /**
   * The same ledger the fetcher writes to, so a render is visible as traffic too. A render is
   * counted as one request under `via: "browser"` — the subresources it makes are the page's
   * doing, not ours, and counting them would drown the number that says what a board costs us.
   */
  traffic?: HttpTrafficLedger;
  /** Every address a name has, asked before a request is let through. Tests inject one. */
  resolveHost?: ResolveHost;
  /** Which addresses may be reached. Defaults to `isPublicAddress`; a test substitutes one for a local fixture. */
  isAllowedAddress?: (address: string) => boolean;
  /**
   * The page's own navigation answered 429 or 503: the host is asking us to back off, and the next
   * render, discovery or import must hear it as a fetch would. Given the response's headers, for
   * its `Retry-After`; wired to `PoliteFetcher.backOff`.
   */
  onRateLimited?: (host: string, headers: Record<string, string>) => Promise<void>;
  /**
   * The longest one render may take (default 60 s). A page that loops in its main thread leaves
   * `page.content()` waiting for ever; at the deadline the page is closed, which ends it, and the
   * render fails as a timeout rather than holding the browser for every render behind it.
   */
  renderTimeoutMs?: number;
  /**
   * The most decoded HTML per capture, and the total retained gzip bytes (default 5 MB for each).
   * At either cap the render says it is incomplete, so a scan closes nothing.
   */
  maxRenderBytes?: number;
  /** How long an unused browser is kept before it is closed (default five minutes); relaunched on the next render. */
  idleCloseMs?: number;
}

/** Schemes whose content never leaves the browser, so there is no destination to guard. */
const LOCAL_SCHEMES = /^(?:data|blob|about):/i;

const COOKIE_BUTTON_TEXT = /^(accept( all)?( cookies)?|allow all|i agree|agree|got it|ok(ay)?|accept and close|accept & close)$/i;
const LOAD_MORE_TEXT = /^(?:(?:load|show|view|see) more(?: (?:jobs|roles|positions|openings|results))?|more (?:jobs|roles|positions|openings))$/i;
// Keep this label set aligned with NEXT_TEXT_RE in packages/core/src/ats/html.ts: a control
// recognised as pending expansion must also be clickable by the renderer.
const NEXT_TEXT = /^(?:next(?: page| jobs| roles| results| pagination page)?(?:\s*[›»→>]+)?|go to next page(?:,\s*number\s*\d+)?)$/i;

interface ListingState {
  roleSignature: string;
  roleCount: number;
  textSignature: string;
  loading: boolean;
}

export class BrowserRenderer {
  private browser: Browser | null = null;
  private pw: Playwright | null = null;
  private active = 0;
  private waiters: Array<{ resolve: () => void }> = [];
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly guard: AddressGuard;

  constructor(private readonly opts: BrowserOptions) {
    this.guard = new AddressGuard({ resolveHost: opts.resolveHost, isAllowedAddress: opts.isAllowedAddress });
  }

  /**
   * Refuse a request the page makes to a private or local destination. A test host map is
   * exhaustive and already refuses every host it does not name, so under one there is nothing
   * left for the guard to do.
   */
  private async guardRequest(url: string): Promise<void> {
    if (Object.keys(this.opts.hostMap ?? {}).length > 0 || LOCAL_SCHEMES.test(url)) return;
    await this.guard.check(url.replace(/^ws(s?):/i, "http$1:"));
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      // The bundler must not follow this: the interface imports the worker's handlers for its
      // cron route, and a serverless deployment has no Chromium to drive. It is only reached
      // when a browser render is actually requested.
      this.pw = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "playwright")) as Playwright;
      const browser = await this.pw.chromium.launch({
        headless: true,
        executablePath: this.opts.executablePath,
        args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-gpu"],
      });
      browser.on("disconnected", () => {
        this.browser = null;
      });
      this.browser = browser;
      return browser;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /**
   * Render `url`, one render per slot. The render has an overall deadline, and `opts.signal` can
   * give it up early; either way its page is closed — which ends a page stuck in a loop, since
   * nothing else can — before the slot passes to the next render. A render that is still waiting
   * for a slot when its signal aborts simply leaves the queue.
   */
  async render(url: string, opts: RenderOptions = {}): Promise<RenderedPage> {
    await this.acquire(opts.signal);
    if (opts.signal?.aborted) {
      this.release();
      throw opts.signal.reason;
    }
    const started = Date.now();
    const timeoutMs = this.opts.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
    const job: RenderJob = { abandoned: false };
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SourceFetchError(`render of ${url} passed its ${Math.round(timeoutMs / 1000)} s deadline`, "timeout")), timeoutMs);
      if (opts.signal) {
        onAbort = () => reject(opts.signal!.reason);
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    // Settled on its own, as opposed to being outrun by the deadline or the signal.
    let ended = false;
    const rendering = this.renderPage(url, opts, job, started + timeoutMs).finally(() => { ended = true; });
    try {
      return await Promise.race([rendering, stopped]);
    } catch (error) {
      if (!ended) {
        job.abandoned = true;
        rendering.catch(() => undefined);
        await this.abandon(job);
        const timedOut = error instanceof SourceFetchError && error.kind === "timeout";
        this.opts.traffic?.request(new URL(url).hostname, "browser", { status: null, bytes: 0, durationMs: Date.now() - started, failure: timedOut ? "timeouts" : undefined });
        log.warn("render abandoned", { url, error: (error as Error).message });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      this.release();
    }
  }

  /** Take a render slot, or wait for one; a signal that aborts while waiting leaves the queue. */
  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.cancelIdleClose();
    if (this.active < (this.opts.concurrency ?? 1)) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(signal!.reason);
      };
      // Handed the slot synchronously by `release`, so an abort can no longer strand it.
      const waiter = { resolve: () => { signal?.removeEventListener("abort", onAbort); resolve(); } };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active--;
    if (this.active === 0) this.scheduleIdleClose();
  }

  /** Whether a Chromium process is running now. */
  get running(): boolean {
    return !!this.browser;
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Close the browser once nothing has rendered for `idleCloseMs`; the next render launches another. */
  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    if (!this.browser) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active > 0 || this.launching || !this.browser) return;
      const browser = this.browser;
      this.browser = null;
      log.info("closing the idle browser", { idleMs: this.opts.idleCloseMs ?? BROWSER_IDLE_CLOSE_MS });
      void within(browser.close(), 10_000, undefined);
    }, this.opts.idleCloseMs ?? BROWSER_IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  /**
   * Close a render's page from outside it. Closing the context kills its renderer, which is the
   * only way out of a page busy in its main thread. A close that does not settle means Chromium
   * itself is stuck: that browser is dropped and the next render launches a fresh one.
   */
  private async abandon(job: RenderJob): Promise<void> {
    if (!job.context) return;
    const closed = await within(job.context.close().then(() => true), 10_000, false);
    if (closed) return;
    log.warn("render context did not close; relaunching the browser");
    const browser = this.browser;
    this.browser = null;
    await within(browser?.close(), 10_000, undefined);
  }

  /**
   * The page's HTML, or null when it is more than `budget` bytes. Measured in the page first, so
   * an oversized DOM is never copied into this process only to be refused: a UTF-16 length over
   * the budget is a UTF-8 length over it too.
   */
  private async snapshot(page: import("playwright").Page, budget: number): Promise<string | null> {
    // A page between documents has nothing to measure; the snapshot below is measured anyway.
    const chars = await page.evaluate(() => document.documentElement ? document.documentElement.outerHTML.length : 0).catch(() => 0);
    if (chars > budget) return null;
    const html = await page.content();
    return Buffer.byteLength(html, "utf8") > budget ? null : html;
  }

  private async renderPage(url: string, opts: RenderOptions, job: RenderJob, deadlineAt: number): Promise<RenderedPage> {
    const started = Date.now();
    const host = new URL(url).hostname;
    // Resolved here, in Node, before a browser is involved: a private address costs nothing.
    await this.guardRequest(url);
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: this.opts.userAgent,
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      javaScriptEnabled: true,
      serviceWorkers: "block",
    });
    job.context = context;
    // Given up while the context was opening: close it at once rather than render for nobody.
    if (job.abandoned) {
      await context.close().catch(() => undefined);
      throw new SourceFetchError(`render of ${url} was given up`, "timeout");
    }
    const maxBytes = Math.min(this.opts.maxRenderBytes ?? MAX_RENDER_BYTES, MAX_RENDER_BYTES);
    const requests: string[] = [];
    let status: number | null = null;
    let navigationError: unknown;
    try {
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs ?? 30_000);
      // Every locator call is bounded: an element that vanished mid-scan otherwise waits 30 s.
      page.setDefaultTimeout(8_000);
      // Playwright's route handler is not invoked again for a server redirect after route.continue.
      // Chromium Fetch interception is: guard each request before any bytes reach the destination,
      // including every hop in a redirect chain, and pace and robots-check the page's own
      // navigations, never its subresources.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      const frameTree = await cdp.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
      const mainFrameId = frameTree.frameTree.frame.id;
      cdp.on("Fetch.requestPaused", async (event: { requestId: string; frameId?: string; request: { url: string }; resourceType?: string }) => {
        const navigation = event.frameId === mainFrameId && event.resourceType === "Document";
        try {
          await opts.allowHost?.(new URL(event.request.url).hostname);
          await this.guardRequest(event.request.url);
          if (navigation) {
            await this.opts.beforeNavigate?.(new URL(event.request.url).hostname);
            await this.opts.allowNavigate?.(event.request.url, opts.allowHost);
          }
          await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
        } catch (error) {
          if (navigation) navigationError = error;
          else log.info("render refused a request", { url: event.request.url, error: (error as Error).message });
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
        }
      });
      // Neither interception sees a WebSocket, so it is guarded where Playwright hands it over.
      await page.routeWebSocket(/.*/, async (ws) => {
        try {
          await opts.allowHost?.(new URL(ws.url()).hostname);
          await this.guardRequest(ws.url());
          ws.connectToServer();
        } catch (error) {
          log.info("render refused a websocket", { url: ws.url(), error: (error as Error).message });
          await ws.close({ code: 1008, reason: "blocked" }).catch(() => undefined);
        }
      });
      const hostMap = this.opts.hostMap ?? {};
      await page.route("**/*", async (route) => {
        const req = route.request();
        try { await opts.allowHost?.(new URL(req.url()).hostname); }
        catch { return route.abort(); }
        const type = req.resourceType();
        if (type === "image" || type === "font" || type === "media") return route.abort();
        const target = new URL(req.url());
        const mapped = hostMap[target.hostname] ?? hostMap["*"];
        // A configured host map is exhaustive, so a test cannot reach the real internet through
        // the browser either.
        if (!mapped && Object.keys(hostMap).length > 0) return route.abort();
        if (mapped) {
          // Used only by tests, which point real hostnames at a local server. Playwright refuses to
          // rewrite across protocols, so the request is made here and the response fulfilled.
          const [h, p] = mapped.split(":");
          const original = target.hostname;
          target.protocol = "http:";
          target.hostname = h ?? "127.0.0.1";
          target.port = p ?? "";
          try {
            const response = await fetch(target.toString(), {
              method: req.method(),
              headers: { ...req.headers(), "x-forwarded-host": original },
              body: (req.postDataBuffer() as unknown as BodyInit | null) ?? undefined,
              // Let Chromium follow redirects so every new top-level URL passes allowNavigate.
              redirect: "manual",
            });
            const headers: Record<string, string> = {};
            response.headers.forEach((v, k) => {
              if (k.toLowerCase() !== "content-encoding" && k.toLowerCase() !== "content-length") headers[k] = v;
            });
            return route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
          } catch {
            return route.abort();
          }
        }
        return route.continue();
      });
      page.on("request", (req) => {
        if (["xhr", "fetch", "document", "script"].includes(req.resourceType())) requests.push(req.url());
      });
      // Reserve once per top-level document navigation (including redirects), never per subresource.
      const response = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(error => { throw navigationError ?? error; });
      status = response?.status() ?? null;
      if (response) {
        const headers = await response.allHeaders();
        // Read only bounded title/script evidence before the normal size-capped DOM snapshot.
        const snippet = await page.evaluate(() => {
          const title = `<title>${document.title.slice(0, 200)}</title>`;
          const scripts = Array.from(document.querySelectorAll("script")).slice(0, 20)
            .map(script => `${script.getAttribute("src") ?? ""} ${script.textContent?.slice(0, 500) ?? ""}`);
          return [title, ...scripts].join("\n").slice(0, 20_000);
        });
        if (explicitBotChallenge(headers, snippet, status ?? 200))
          throw new SourceFetchError(`bot challenge while rendering ${url}`, "blocked", status ?? 403, new URL(response.url()).hostname);
      }
      if (response && (status === 429 || status === 503)) {
        // The fetcher defers a host that says this; a render must too, or the next render asks
        // again at the ordinary pace.
        const answered = new URL(response.url()).hostname;
        this.opts.traffic?.reason(answered, "browser", "rateLimited");
        await this.opts.onRateLimited?.(answered, await response.allHeaders().catch(() => ({})));
      }
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

      const compressedListingPages: NonNullable<RenderedPage["compressedListingPages"]> = [];
      let incomplete = false;
      let latestHtml: string | undefined;
      let latestUrl = page.url();
      let lastDigest: string | undefined;
      const seen = new Set<string>();
      let held = 0;
      const digest = (html: string) => createHash("sha256").update(html).digest("hex");
      const retain = (html: string, captureUrl: string): "added" | "seen" | "cap" => {
        const key = digest(html);
        if (seen.has(key)) return "seen";
        const gzip = gzipSync(html);
        if (held + gzip.byteLength > maxBytes) return "cap";
        seen.add(key);
        lastDigest = key;
        held += gzip.byteLength;
        latestHtml = html;
        latestUrl = captureUrl;
          compressedListingPages.push({ gzip, decodedBytes: Buffer.byteLength(html, "utf8"), url: captureUrl });
        return "added";
      };
      if (opts.scrollAndExpand) {
        await this.dismissCookieBanners(page);
        // Stops short of the render's own deadline, so what was read is returned as incomplete
        // rather than lost to the timeout.
        const deadline = Math.min(Date.now() + 60_000, deadlineAt - 10_000);
        for (let i = 0; i < MAX_LISTING_STEPS; i++) {
          if (navigationError) { incomplete = true; break; }
          const html = await this.snapshot(page, maxBytes);
          if (html === null) { incomplete = true; break; }
          if (retain(html, page.url()) !== "added") { incomplete = true; break; }
          if (Date.now() >= deadline) { incomplete = true; break; }
          const before = await page.locator("body").innerText();
          await this.dismissCookieBanners(page);
          let beforeListing = await this.listingState(page);
          let clicked: boolean;
          try { clicked = await this.clickListingControl(page); }
          catch { incomplete = true; break; }
          if (!clicked) {
            // A real Next/Load more control scrolls into view during Playwright's click. Only an
            // infinite-scroll board needs a wheel; paying this delay on every explicit page can
            // consume the whole render deadline before the last roles are reached.
            await page.mouse.wheel(0, 4000).catch(() => undefined);
            await page.waitForTimeout(600);
            if (Date.now() >= deadline) { incomplete = true; break; }
            await this.dismissCookieBanners(page);
            beforeListing = await this.listingState(page);
            try { clicked = await this.clickListingControl(page); }
            catch { incomplete = true; break; }
          }
          if (clicked) {
            const remaining = Math.min(8_000, Math.max(0, deadline - Date.now()));
            const transition = await this.waitForListingTransition(page, beforeListing, remaining);
            if (!transition.trustworthy) incomplete = true;
            if (!transition.advanced) break;
          }
          if (navigationError) { incomplete = true; break; }
          const after = await page.locator("body").innerText();
          if (!clicked && after === before) break;
          if (i === MAX_LISTING_STEPS - 1) incomplete = true;
        }
      } else {
        await page.waitForTimeout(500);
      }
      // A later client-side pagination request can be denied after the first listing was read.
      // Keep that verified first page as partial evidence, while never treating the denied
      // navigation as a successful, complete render. Initial/uncaptured denials still throw.
      if (navigationError) {
        if (!(navigationError instanceof SourceFetchError && navigationError.kind === "blocked" && latestHtml)) throw navigationError;
        log.info("render continuation blocked after a listing capture", { url, error: navigationError.message });
        const bytes = response ? await within(response.request().sizes().then(sizes => sizes.responseBodySize), 2_000, 0) : 0;
        if (!job.abandoned) this.opts.traffic?.request(host, "browser", { status, bytes, durationMs: Date.now() - started });
        return { html: latestHtml, finalUrl: latestUrl, requests: [...new Set(requests)], status, compressedListingPages, incomplete: true };
      }
      let html = await this.snapshot(page, maxBytes);
      if (navigationError) throw navigationError;
      let finalCaptureUnstored = false;
      let fellBackToLatest = false;
      if (html === null) {
        // Too large to decode. What the listing snapshots already read is kept, marked incomplete;
        // with nothing read, the render is refused as the fetcher refuses an oversized body.
        if (!latestHtml) throw new SourceFetchError(`Rendered page exceeds ${maxBytes} bytes; refusing truncated content`, "parse");
        html = latestHtml;
        fellBackToLatest = true;
        incomplete = true;
      } else if (opts.scrollAndExpand) {
        const finalDigest = digest(html);
        if (finalDigest !== lastDigest) {
          if (seen.has(finalDigest)) incomplete = true;
          else if (retain(html, page.url()) === "cap") { finalCaptureUnstored = true; incomplete = true; }
        }
      }
      if (explicitBotChallenge({}, html, 200))
        throw new SourceFetchError(`bot challenge while rendering ${page.url()}`, "blocked", 403, new URL(page.url()).hostname);
      // What came over the wire for the page itself, not the size of the DOM its scripts built.
      const bytes = response ? await within(response.request().sizes().then(sizes => sizes.responseBodySize), 2_000, 0) : 0;
      if (!job.abandoned) this.opts.traffic?.request(host, "browser", { status, bytes, durationMs: Date.now() - started });
      return { html, finalUrl: fellBackToLatest ? latestUrl : page.url(), requests: [...new Set(requests)], status,
        compressedListingPages, finalCaptureUnstored, incomplete };

    } catch (err) {
      // A render that never produced a page is still traffic: a navigation timeout and a dead
      // host are the two ways a board costs us a browser and returns nothing.
      // Abandoned renders were counted once, by `render`, when they were given up.
      if (job.abandoned) throw err;
      const timedOut = (err as Error).name === "TimeoutError" || /timeout/i.test((err as Error).message);
      this.opts.traffic?.request(host, "browser", { status, bytes: 0, durationMs: Date.now() - started, failure: timedOut ? "timeouts" : "networkErrors" });
      log.warn("render failed", { url, error: (err as Error).message });
      throw err;
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async dismissCookieBanners(page: import("playwright").Page): Promise<void> {
    const selectors = [
      ".consent-modal .consent-reject",
      ".consent-modal .consent-agree",
      "#twcc__decline-button",
      "#onetrust-accept-btn-handler",
      "button#accept-cookies",
      "button[data-testid*='accept']",
      "button[aria-label*='accept' i]",
      ".cc-accept",
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    ];
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        if (await el.click({ timeout: 2000 }).then(() => true, () => false)) return;
      }
    }
    const buttons = page.locator("button, [role=button]");
    const n = Math.min(await buttons.count().catch(() => 0), 40);
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const text = ((await b.textContent().catch(() => "")) ?? "").trim();
      if (COOKIE_BUTTON_TEXT.test(text) && (await b.isVisible().catch(() => false))) {
        if (await b.click({ timeout: 2000 }).then(() => true, () => false)) return;
      }
    }
  }

  /** A changed page number or spinner alone is not evidence that the next role slice arrived. */
  private async listingState(page: import("playwright").Page): Promise<ListingState> {
    return page.evaluate(() => {
      const root = document.querySelector("main, [role='main']") ?? document.body;
      const roleLinks: string[] = [];
      for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        if (link.closest("nav, [class*='pagination' i], [id*='pagination' i]")) continue;
        let target: URL;
        try { target = new URL(link.getAttribute("href") ?? "", location.href); } catch { continue; }
        if (!/^https?:$/.test(target.protocol)) continue;
        const rolePath = /\/(?:jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|roles?|apply|detail|job-details?|joblisting)\//i.test(target.pathname);
        let roleQuery = false;
        for (const key of target.searchParams.keys()) {
          if (/^(?:gh_jid|jobid|job_id|reqid|requisitionid)$/i.test(key)) { roleQuery = true; break; }
        }
        if (!rolePath && !roleQuery) continue;
        roleLinks.push(`${target.href}|${(link.textContent ?? "").replace(/\s+/g, " ").trim()}`);
      }
      for (const script of root.querySelectorAll<HTMLScriptElement>("script[type='application/ld+json']")) {
        if (/JobPosting/i.test(script.textContent ?? "")) roleLinks.push(script.textContent ?? "");
      }
      const roles = [...new Set(roleLinks)].sort();
      let roleHash = 2166136261;
      for (const role of roles) for (let i = 0; i < role.length; i++) roleHash = Math.imul(roleHash ^ role.charCodeAt(i), 16777619);
      const text = (root as HTMLElement).innerText ?? "";
      let textHash = 2166136261;
      for (let i = 0; i < Math.min(text.length, 50_000); i++) textHash = Math.imul(textHash ^ text.charCodeAt(i), 16777619);
      let loading = false;
      for (const element of root.querySelectorAll<HTMLElement>("[aria-busy='true'], [role='progressbar'], [class*='loading' i], [class*='spinner' i]")) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden") { loading = true; break; }
      }
      return { roleSignature: `${roles.length}:${(roleHash >>> 0).toString(16)}`, roleCount: roles.length,
        textSignature: `${text.length}:${(textHash >>> 0).toString(16)}`, loading };
    });
  }

  /** Wait for changed role identities to settle; body-only changes stay explicitly unverified. */
  private async waitForListingTransition(page: import("playwright").Page, before: ListingState, timeoutMs: number): Promise<{ advanced: boolean; trustworthy: boolean }> {
    const until = Date.now() + timeoutMs;
    let candidate = "";
    let stableSince = 0;
    while (Date.now() < until) {
      await page.waitForTimeout(100);
      const after = await this.listingState(page).catch(() => null);
      if (!after || after.loading) { candidate = ""; continue; }
      const roleChanged = after.roleCount > 0 && after.roleSignature !== before.roleSignature;
      const bodyChanged = after.textSignature !== before.textSignature;
      const next = roleChanged ? `roles:${after.roleSignature}` : before.roleCount === 0 && bodyChanged ? `body:${after.textSignature}` : "";
      if (!next) { candidate = ""; continue; }
      if (next !== candidate) { candidate = next; stableSince = Date.now(); continue; }
      if (Date.now() - stableSince >= 250) return { advanced: true, trustworthy: roleChanged };
    }
    return { advanced: false, trustworthy: false };
  }

  /**
   * Find and click the page's "load more" or "next" control. The search runs in the page, in one
   * round trip, and marks what it found for the click: asking the protocol about each of hundreds
   * of links in turn cost thousands of round trips a pass. Every element is read for its text,
   * which is cheap, and the first `MAX_LISTING_CONTROL_CANDIDATES` whose text reads as a control
   * are examined further; capping the elements themselves instead would miss a button placed
   * after a few hundred role links, and pagination that silently ends early is a listing that
   * reads as complete.
   */
  private async clickListingControl(page: import("playwright").Page): Promise<boolean> {
    const found = await page.evaluate(({ loadMore, next, limit }) => {
      const loadMoreText = new RegExp(loadMore.source, loadMore.flags);
      const nextText = new RegExp(next.source, next.flags);
      document.querySelectorAll("[data-ava-listing-control]").forEach(el => el.removeAttribute("data-ava-listing-control"));
      let examined = 0;
      for (const el of Array.from(document.querySelectorAll("button, a, [role=button]"))) {
        const text = (el.getAttribute("aria-label") || el.textContent || "").trim();
        const rel = el.getAttribute("rel");
        if (text.length > 60 || !(loadMoreText.test(text) || nextText.test(text) || rel === "next")) continue;
        if (++examined > limit) break;
        if (el.getAttribute("data-toggle") === "collapse" || el.getAttribute("data-bs-toggle") === "collapse") continue;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
        if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") continue;
        const href = el.getAttribute("href");
        if (href) {
          let target: URL;
          try { target = new URL(href, location.href); } catch { return "unparsable"; }
          // Some job boards paginate through an explicitly labelled javascript: control. The
          // guarded browser may click it; every network request it starts is still checked.
          if (target.protocol !== "javascript:" && target.origin !== location.origin) continue;
        }
        el.setAttribute("data-ava-listing-control", "");
        return "found";
      }
      return "none";
    }, { loadMore: { source: LOAD_MORE_TEXT.source, flags: LOAD_MORE_TEXT.flags }, next: { source: NEXT_TEXT.source, flags: NEXT_TEXT.flags }, limit: MAX_LISTING_CONTROL_CANDIDATES });
    if (found === "unparsable") throw new Error("A listing control has an unparsable link");
    if (found === "none") return false;
    await page.locator("[data-ava-listing-control]").first().click({ timeout: 3000 });
    // The marker is ours, not the page's: it must not reach a snapshot.
    await page.evaluate(() => document.querySelectorAll("[data-ava-listing-control]").forEach(el => el.removeAttribute("data-ava-listing-control"))).catch(() => undefined);
    return true;
  }

  async close(): Promise<void> {
    this.cancelIdleClose();
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
