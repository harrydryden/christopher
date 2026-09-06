/**
 * Headless Chromium rendering with network sniffing. Used when a careers page is a JavaScript shell.
 * One browser per process, one context per render, images/fonts/media blocked.
 */
import type { RenderedPage } from "@christopher/core";
import { log } from "./log";

type Playwright = typeof import("playwright");
type Browser = import("playwright").Browser;

export interface BrowserOptions {
  userAgent: string;
  executablePath?: string;
  hostMap?: Record<string, string>;
  navigationTimeoutMs?: number;
}

const COOKIE_BUTTON_TEXT = /^(accept( all)?( cookies)?|allow all|i agree|agree|got it|ok(ay)?|accept and close|accept & close)$/i;
const LOAD_MORE_TEXT = /(load|show|view|see) more|more (jobs|roles|positions|openings)/i;

export class BrowserRenderer {
  private browser: Browser | null = null;
  private pw: Playwright | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(private readonly opts: BrowserOptions) {}

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

  async render(url: string, opts: { scrollAndExpand?: boolean } = {}): Promise<RenderedPage> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: this.opts.userAgent,
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      javaScriptEnabled: true,
    });
    const requests: string[] = [];
    let status: number | null = null;
    try {
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs ?? 30_000);
      const hostMap = this.opts.hostMap ?? {};
      await page.route("**/*", async (route) => {
        const req = route.request();
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
              redirect: "follow",
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
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      status = response?.status() ?? null;
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

      const listingPages: Array<{ html: string; url: string }> = [];
      let incomplete = false;
      if (opts.scrollAndExpand) {
        await this.dismissCookieBanners(page);
        const seen = new Set<string>();
        const deadline = Date.now() + 60_000;
        for (let i = 0; i < 20; i++) {
          const html = await page.content();
          if (seen.has(html)) { incomplete = true; break; }
          seen.add(html);
          listingPages.push({ html, url: page.url() });
          if (Date.now() >= deadline) { incomplete = true; break; }
          const before = await page.locator("body").innerText();
          await page.mouse.wheel(0, 4000).catch(() => undefined);
          await page.waitForTimeout(600);
          const clicked = await this.clickListingControl(page);
          if (clicked) {
            await page.waitForFunction(old => document.body.innerText !== old, before, { timeout: 8000 }).catch(() => { incomplete = true; });
            await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
          }
          const after = await page.locator("body").innerText();
          if (!clicked && after === before) break;
          if (clicked && after === before) { incomplete = true; break; }
          if (i === 19) incomplete = true;
        }
      } else {
        await page.waitForTimeout(500);
      }
      const html = await page.content();
      return { html, finalUrl: page.url(), requests: [...new Set(requests)], status, listingPages, incomplete };

    } catch (err) {
      log.warn("render failed", { url, error: (err as Error).message });
      throw err;
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async dismissCookieBanners(page: import("playwright").Page): Promise<void> {
    const selectors = [
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
        await el.click({ timeout: 2000 }).catch(() => undefined);
        return;
      }
    }
    const buttons = page.locator("button, [role=button]");
    const n = Math.min(await buttons.count().catch(() => 0), 40);
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const text = ((await b.textContent().catch(() => "")) ?? "").trim();
      if (COOKIE_BUTTON_TEXT.test(text) && (await b.isVisible().catch(() => false))) {
        await b.click({ timeout: 2000 }).catch(() => undefined);
        return;
      }
    }
  }

  private async clickListingControl(page: import("playwright").Page): Promise<boolean> {
    const candidates = page.locator("button, a, [role=button]");
    const n = Math.min(await candidates.count().catch(() => 0), 500);
    for (let i = 0; i < n; i++) {
      const c = candidates.nth(i);
      const text = ((await c.getAttribute("aria-label")) || (await c.textContent()) || "").trim();
      const rel = await c.getAttribute("rel");
      const matches = text.length <= 60 && (LOAD_MORE_TEXT.test(text) || /^next(?: page| jobs| roles| results)?(?:\s*[›»→>])?$/i.test(text) || rel === "next");
      if (!matches || !(await c.isVisible()) || !(await c.isEnabled()) || await c.getAttribute("aria-disabled") === "true") continue;
      const href = await c.getAttribute("href");
      if (href && new URL(href, page.url()).origin !== new URL(page.url()).origin) continue;
      await c.click({ timeout: 3000 });
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
