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
const LOAD_MORE_TEXT = /(load|show|view|see) more|more (jobs|roles|positions|openings)|next page|^next$/i;

export class BrowserRenderer {
  private browser: Browser | null = null;
  private pw: Playwright | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(private readonly opts: BrowserOptions) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      this.pw = await import("playwright");
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

      if (opts.scrollAndExpand) {
        await this.dismissCookieBanners(page);
        for (let i = 0; i < 10; i++) {
          const before = await page.evaluate(() => document.body?.innerHTML.length ?? 0);
          await page.mouse.wheel(0, 4000).catch(() => undefined);
          await page.waitForTimeout(600);
          const clicked = await this.clickLoadMore(page);
          if (clicked) await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
          const after = await page.evaluate(() => document.body?.innerHTML.length ?? 0);
          if (!clicked && after === before) break;
        }
      } else {
        await page.waitForTimeout(500);
      }
      const html = await page.content();
      return { html, finalUrl: page.url(), requests: [...new Set(requests)], status };
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

  private async clickLoadMore(page: import("playwright").Page): Promise<boolean> {
    const candidates = page.locator("button, a, [role=button]");
    const n = Math.min(await candidates.count().catch(() => 0), 200);
    for (let i = 0; i < n; i++) {
      const c = candidates.nth(i);
      const text = ((await c.textContent().catch(() => "")) ?? "").trim();
      if (text.length <= 40 && LOAD_MORE_TEXT.test(text) && (await c.isVisible().catch(() => false))) {
        await c.click({ timeout: 2000 }).catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
