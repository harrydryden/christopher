/**
 * Headless Chromium: renders a page whose roles arrive from JavaScript, and captures the API call
 * the page makes so the applicant tracking system can be identified from it.
 * Skipped when AVA_DISABLE_BROWSER=1 (CI without a browser).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BrowserRenderer } from "./browser";
import { listingCaptures } from "./listing-captures";
import { HttpTrafficLedger } from "./fetcher";
import { startTestServer, type TestServer } from "./test-server";
import { ats, discovery, renamedEnv, SourceFetchError } from "@ava/core";

const skip = renamedEnv(process.env, "AVA_DISABLE_BROWSER", "CHRISTOPHER_DISABLE_BROWSER") === "1";
const GH_API = "https://boards-api.greenhouse.io/v1/boards/acmeindustries/jobs?content=true";

const SHELL_PAGE = `<!doctype html><html><head><title>Open Roles | Acme Industries</title></head><body>
  <div id="root">Loading…</div>
  <script>
    fetch(${JSON.stringify(GH_API)})
      .then(function (r) { return r.json(); })
      .then(function (data) {
        document.getElementById("root").innerHTML = data.jobs
          .map(function (j) {
            return '<li><a href="' + j.absolute_url + '">' + j.title + '</a><span class="loc">' + j.location.name + '</span></li>';
          })
          .join("");
      })
      .catch(function () { document.getElementById("root").innerHTML = "failed"; });
  </script></body></html>`;

const MEDIA_PAGE = `<html><head><link rel="stylesheet" href="/style.css"></head><body>
  <img src="/logo.png" alt="logo"><video src="/clip.mp4" autoplay muted></video><p>Brand type</p></body></html>`;

/** Each "Load more" appends about 100 KB of roles, so the snapshots grow without bound. */
const GROWING_PAGE = `<html><body><ul id="jobs"><li><a href="/jobs/0">Role 0</a></li></ul>
  <button onclick="var list = document.getElementById('jobs'); var n = list.children.length; var html = ''; for (var i = 0; i < 1000; i++) html += '<li><a href=/jobs/' + (n + i) + '>Role ' + (n + i) + ' ' + 'x'.repeat(60) + '</a></li>'; list.insertAdjacentHTML('beforeend', html);">Load more</button></body></html>`;

/** Three hundred role links ahead of the control that reveals one more. */
const MANY_LINKS_PAGE = `<html><body><ul id="jobs">${Array.from({ length: 300 }, (_, i) => `<li><a href="/jobs/${i}">Analyst ${i}</a></li>`).join("")}</ul>
  <button onclick="document.getElementById('jobs').insertAdjacentHTML('beforeend', '<li><a href=/jobs/last>Finance Director</a></li>'); this.disabled = true">Load more</button></body></html>`;

const JOBS = {
  jobs: [
    { id: 5001, title: "Operations Manager", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5001", location: { name: "Costa Mesa, CA" } },
    { id: 5002, title: "Mission Operations Lead", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5002", location: { name: "London, UK" } },
    { id: 5003, title: "Supply Chain Operations", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5003", location: { name: "Costa Mesa, CA" } },
  ],
};

let server: TestServer;
let renderer: BrowserRenderer;

beforeAll(async () => {
  if (skip) return;
  server = await startTestServer(
    {
      "www.acmeind.example": { "/open-roles": { body: SHELL_PAGE },
        "/challenge-header": { status: 403, body: "<html><body>restricted</body></html>", headers: { "cf-mitigated": "challenge" } },
        "/captcha-widget-listing": { body: `<html><body><a href="/jobs/one">Operations Director</a><div class="g-recaptcha"></div></body></html>` },
        "/guarded-assets": { body: `<html><body>careers<script src="https://boards-api.greenhouse.io/guarded.js"></script></body></html>` },
        "/paginated": { body: `<html><body><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul><button id="next" onclick="document.getElementById('jobs').innerHTML='<li><a href=/jobs/two>Finance Director</a></li>';this.disabled=true">Next</button></body></html>` },
        "/pagination-labels": { body: `<html><body><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul>
          <button aria-label="Go to Next Page, Number 2" onclick="window.step=(window.step||0)+1;
            document.getElementById('jobs').innerHTML=window.step===1
              ? '<li><a href=/jobs/two>Finance Director</a></li>'
              : '<li><a href=/jobs/three>People Director</a></li>';
            if(window.step===1){this.removeAttribute('aria-label');this.textContent='Next &gt;&gt;';}
            else this.disabled=true">Next</button></body></html>` },
        "/javascript-pagination": { body: `<html><head><style>.next{display:inline-block;width:40px;height:25px}</style></head><body>
          <ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul>
          <a class="next" href="javascript:pagination(2)" aria-label="Next pagination page"></a>
          <script>function pagination(n){document.getElementById('jobs').innerHTML='<li><a href=/jobs/two>Finance Director</a></li>';
            document.querySelector('.next').setAttribute('aria-disabled','true');}</script></body></html>` },
        "/consent": { body: `<html><body>${'<button>Other</button>'.repeat(45)}<a role="button" data-bs-toggle="collapse" href=".locations">Show more</a><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul><button onclick="document.getElementById('jobs').innerHTML='<li><a href=/jobs/two>Finance Director</a></li>';this.disabled=true">Next</button><div class="consent-modal" role="dialog" aria-label="Cookie consent" style="position:fixed;inset:0;background:white;z-index:999"><button class="consent-reject" onclick="this.parentElement.remove()">I do not accept</button></div></body></html>` },
        "/consent-decline": { body: `<html><body><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul><button onclick="document.getElementById('jobs').innerHTML='<li><a href=/jobs/two>Finance Director</a></li>';this.disabled=true">Next</button><div id="twcc__mechanism" role="dialog" aria-label="Cookie consent" style="position:fixed;inset:0;background:white;z-index:999"><button id="twcc__accept-button" onclick="this.parentElement.remove()">Accept</button><button id="twcc__decline-button" onclick="this.parentElement.remove()">Decline</button></div></body></html>` },
        "/delayed-pagination": { body: `<html><body><main><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul><span id="state"></span><button onclick="document.getElementById('state').textContent='Loading jobs';setTimeout(()=>{document.getElementById('jobs').innerHTML='<li><a href=/jobs/two>Finance Director</a></li>';document.getElementById('state').textContent='';this.disabled=true},600)">Next</button></main></body></html>` },
        "/append-pagination": { body: `<html><body><main><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul><button onclick="setTimeout(()=>{document.getElementById('jobs').insertAdjacentHTML('beforeend','<li><a href=/jobs/two>Finance Director</a></li>');this.disabled=true},250)">Load more</button></main></body></html>` },
        "/same-roles-next": { body: `<html><body><main><p id="page">Page 1</p><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul><button onclick="document.getElementById('page').textContent='Page 2';this.disabled=true">Next</button></main></body></html>` },
        "/request-noise": { body: `<html><body><main><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul><button onclick="setInterval(()=>fetch('/noise'),75);setTimeout(()=>{document.getElementById('jobs').innerHTML='<li><a href=/jobs/two>Finance Director</a></li>';this.disabled=true},150)">Next</button></main></body></html>` },
        "/noise": { body: "ok", contentType: "text/plain" },
        "/non-anchor-list": { body: `<html><body><main><div id="jobs">Operations Director</div><button onclick="document.getElementById('jobs').textContent='Finance Director';this.disabled=true">Next</button></main></body></html>` },
        "/stuck": { body: `<html><body><ul><li><a href="/jobs/one">Operations Director</a></li></ul><button>Next</button></body></html>` },
        "/media": { body: MEDIA_PAGE },
        "/style.css": { body: "@font-face { font-family: Brand; src: url(/brand.woff2); } body { font-family: Brand; background: url(/hero.jpg); }", contentType: "text/css" },
        "/logo.png": { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" },
        "/hero.jpg": { body: Buffer.from([0xff, 0xd8, 0xff]), contentType: "image/jpeg" },
        "/brand.woff2": { body: Buffer.from("wOF2"), contentType: "font/woff2" },
        "/clip.mp4": { body: Buffer.from("mp4"), contentType: "video/mp4" },
        "/hang": { body: `<html><body><ul><li><a href="/jobs/one">Operations Director</a></li></ul><script>document.addEventListener("DOMContentLoaded", function () { setTimeout(function () { for (;;) {} }, 300); });</script></body></html>` },
        "/fine": { body: "<html><body><p>fine</p></body></html>" },
        "/queued": { body: "<html><body><p>queued</p></body></html>" },
        "/grow": { body: GROWING_PAGE },
        "/big": { body: `<html><body>${"<p>role</p>".repeat(1000)}</body></html>` },
        "/busy": { status: 429, body: "<html><body>slow down</body></html>", headers: { "retry-after": "30" } },
        "/many-links": { body: MANY_LINKS_PAGE } },
      "boards-api.greenhouse.io": { "/v1/boards/acmeindustries/jobs": { body: JOBS }, "/guarded.js": { body: "window.assetLoaded = true", contentType: "application/javascript" } },
    },
    ["www.acmeind.example", "boards-api.greenhouse.io"],
  );
  renderer = new BrowserRenderer({
    userAgent: "AVAJobMonitor/0.1 (test)",
    hostMap: server.hostMap,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  });
}, 120_000);

afterAll(async () => {
  await renderer?.close();
  await server?.close();
});

describe.skipIf(skip)("headless rendering", () => {
  it("reports an explicit challenge but keeps a normal listing with a captcha widget", async () => {
    await expect(renderer.render("https://www.acmeind.example/challenge-header")).rejects.toMatchObject({
      kind: "blocked", status: 403, challengeHost: "www.acmeind.example",
    });
    const listing = await renderer.render("https://www.acmeind.example/captcha-widget-listing");
    expect(listing.html).toContain("Operations Director");
  });

  it("keeps challenged-host subresources out of a different page's render", async () => {
    const before = server.requests.filter(request => request.host === "boards-api.greenhouse.io" && request.url === "/guarded.js").length;
    const checked: string[] = [];
    const result = await renderer.render("https://www.acmeind.example/guarded-assets", { allowHost: host => {
      checked.push(host);
      if (host === "boards-api.greenhouse.io") throw new Error("run-local challenged host");
    } });
    expect(result.html).toContain("careers");
    expect(checked).toContain("boards-api.greenhouse.io");
    expect(server.requests.filter(request => request.host === "boards-api.greenhouse.io" && request.url === "/guarded.js")).toHaveLength(before);
  });

  it("preserves roles from every JavaScript page and stops at a disabled next button", async () => {
    const page = await renderer.render("https://www.acmeind.example/paginated", { scrollAndExpand: true });
    const postings = [...listingCaptures(page)].flatMap(p => ats.extractPostingsFromHtml(p.html, p.url));
    expect(postings.map(p => p.title)).toEqual(["Operations Director", "Finance Director"]);
    expect(page.incomplete).toBe(false);
  }, 120000);
  it("follows accessible next-page labels and repeated arrow controls", async () => {
    const page = await renderer.render("https://www.acmeind.example/pagination-labels", { scrollAndExpand: true });
    const postings = [...listingCaptures(page)].flatMap(capture => ats.extractPostingsFromHtml(capture.html, capture.url));
    expect(postings.map(posting => posting.title)).toEqual(["Operations Director", "Finance Director", "People Director"]);
    expect(page.incomplete).toBe(false);
  }, 120_000);
  it("clicks a labelled JavaScript pagination anchor without following its href as a URL", async () => {
    const page = await renderer.render("https://www.acmeind.example/javascript-pagination", { scrollAndExpand: true });
    const postings = [...listingCaptures(page)].flatMap(capture => ats.extractPostingsFromHtml(capture.html, capture.url));
    expect(postings.map(posting => posting.title)).toEqual(["Operations Director", "Finance Director"]);
    expect(page.incomplete).toBe(false);
  }, 120_000);
  it("dismisses a consent overlay and ignores location expanders while following pagination", async () => {
    const page = await renderer.render("https://www.acmeind.example/consent", { scrollAndExpand: true });
    const titles = [...listingCaptures(page)].flatMap(p => ats.extractPostingsFromHtml(p.html, p.url)).map(p => p.title);
    expect(titles).toContain("Finance Director");
    expect(page.incomplete).toBe(false);
  }, 120000);
  it("marks an unresponsive next button incomplete", async () => {
    const page = await renderer.render("https://www.acmeind.example/stuck", { scrollAndExpand: true });
    expect(page.incomplete).toBe(true);
  }, 120000);
  it("renders roles that only exist after JavaScript runs", async () => {
    const page = await renderer.render("https://www.acmeind.example/open-roles", { scrollAndExpand: true });
    expect(page.html).toContain("Mission Operations Lead");

    const postings = ats.extractPostingsFromHtml(page.html, page.finalUrl);
    expect(postings).toHaveLength(3);
    expect(postings.find((p) => p.title === "Mission Operations Lead")?.location).toBe("London, UK");
  }, 120_000);
  it("declines an obstructing cookie overlay before clicking pagination", async () => {
    const page = await renderer.render("https://www.acmeind.example/consent-decline", { scrollAndExpand: true });
    const postings = [...listingCaptures(page)].flatMap(capture => ats.extractPostingsFromHtml(capture.html, capture.url));
    expect(postings.map(posting => posting.title)).toEqual(["Operations Director", "Finance Director"]);
    expect(page.incomplete).toBe(false);
  }, 120_000);
  it("waits for role identities after loading text, cumulative append and request noise", async () => {
    for (const path of ["/delayed-pagination", "/append-pagination", "/request-noise"]) {
      const page = await renderer.render(`https://www.acmeind.example${path}`, { scrollAndExpand: true });
      const titles = [...listingCaptures(page)].flatMap(capture => ats.extractPostingsFromHtml(capture.html, capture.url)).map(posting => posting.title);
      expect(titles, path).toContain("Finance Director");
      expect(page.incomplete, path).toBe(false);
    }
  }, 120_000);
  it("does not certify a changed page number or body-only listing as completed pagination", async () => {
    for (const path of ["/same-roles-next", "/non-anchor-list"]) {
      const page = await renderer.render(`https://www.acmeind.example${path}`, { scrollAndExpand: true });
      expect(page.incomplete, path).toBe(true);
    }
  }, 120_000);

  it("captures the API call the page makes, so the board can be identified from it", async () => {
    const page = await renderer.render("https://www.acmeind.example/open-roles");
    const specs = page.requests.map((url) => ats.specFromAnyUrl(url)).filter((s) => s !== null);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.type).toBe("greenhouse");
    expect(specs[0]!.atsSlug).toBe("acmeindustries");
    // This is the evidence discovery scores as `ats_network`, its highest-confidence method.
    expect(discovery.confidenceFor({ method: "ats_network" })).toBeGreaterThanOrEqual(discovery.AUTO_ACCEPT_CONFIDENCE);
  }, 120_000);

  it("blocks images, fonts and media so pages load quickly", async () => {
    // Counted where they would arrive: the page's stylesheet is fetched, and nothing it or the
    // markup points at that is an image, a font or a video ever reaches the server.
    const before = server.requests.length;
    const page = await renderer.render("https://www.acmeind.example/media");
    expect(page.status).toBe(200);
    const asked = server.requests.slice(before).map(r => r.url);
    expect(asked).toContain("/style.css");
    expect(asked.filter(url => /\.(png|jpe?g|woff2?|mp4)$/.test(url))).toEqual([]);
  }, 120_000);

  it("finds the load-more control after hundreds of role links", async () => {
    const page = await renderer.render("https://www.acmeind.example/many-links", { scrollAndExpand: true });
    const titles = [...listingCaptures(page)].flatMap(p => ats.extractPostingsFromHtml(p.html, p.url)).map(p => p.title);
    expect(titles).toContain("Finance Director");
    expect(page.incomplete).toBe(false);
    // The mark the search leaves for the click is gone before the next snapshot is taken.
    expect([...listingCaptures(page)].some(p => p.html.includes("data-ava-listing-control"))).toBe(false);
  }, 120_000);

  it("stops snapshotting at the byte cap and says the listing is incomplete", async () => {
    const capped = new BrowserRenderer({ userAgent: "AVAJobMonitor/0.1 (test)", hostMap: server.hostMap, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, maxRenderBytes: 300_000 });
    try {
      const page = await capped.render("https://www.acmeind.example/grow", { scrollAndExpand: true });
      expect(page.incomplete).toBe(true);
      const held = page.compressedListingPages!.reduce((sum, capture) => sum + capture.gzip.byteLength, 0);
      expect(page.listingPages).toBeUndefined();
      expect(page.compressedListingPages!.length).toBeGreaterThan(1);
      expect(held).toBeLessThanOrEqual(300_000);
      expect(page.compressedListingPages!.every(capture => capture.decodedBytes <= 300_000)).toBe(true);
      // A single page larger than the cap is refused, as the fetcher refuses an oversized body.
      const tiny = new BrowserRenderer({ userAgent: "AVAJobMonitor/0.1 (test)", hostMap: server.hostMap, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, maxRenderBytes: 5_000 });
      try {
        await expect(tiny.render("https://www.acmeind.example/big")).rejects.toMatchObject({ kind: "parse" });
      } finally { await tiny.close(); }
    } finally { await capped.close(); }
  }, 120_000);

  it("defers a host whose page answers 429, as the fetcher would", async () => {
    const deferred: Array<{ host: string; retryAfter?: string }> = [];
    const ledger = new HttpTrafficLedger(null);
    const polite = new BrowserRenderer({
      userAgent: "AVAJobMonitor/0.1 (test)", hostMap: server.hostMap, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, traffic: ledger,
      onRateLimited: async (host, headers) => { deferred.push({ host, retryAfter: headers["retry-after"] }); },
    });
    try {
      const page = await polite.render("https://www.acmeind.example/busy");
      expect(page.status).toBe(429);
      expect(deferred).toEqual([{ host: "www.acmeind.example", retryAfter: "30" }]);
      expect(ledger.snapshot()[0]).toMatchObject({ requests: 1, rateLimited: 1, client4xx: 1 });
    } finally { await polite.close(); }
  }, 120_000);

  it("closes an idle browser after its quiet period and launches another for the next render", async () => {
    const idle = new BrowserRenderer({ userAgent: "AVAJobMonitor/0.1 (test)", hostMap: server.hostMap, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, idleCloseMs: 500 });
    try {
      expect((await idle.render("https://www.acmeind.example/fine")).html).toContain("fine");
      expect(idle.running).toBe(true);
      // A render inside the quiet period keeps the same browser.
      await new Promise(resolve => setTimeout(resolve, 200));
      expect((await idle.render("https://www.acmeind.example/fine")).html).toContain("fine");
      expect(idle.running).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 1_500));
      expect(idle.running).toBe(false);
      expect((await idle.render("https://www.acmeind.example/fine")).html).toContain("fine");
      expect(idle.running).toBe(true);
    } finally { await idle.close(); }
  }, 60_000);

  it("gives up a page that hangs its main thread, and the renders queued behind it still run", async () => {
    const ledger = new HttpTrafficLedger(null);
    const bounded = new BrowserRenderer({ userAgent: "AVAJobMonitor/0.1 (test)", hostMap: server.hostMap, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, renderTimeoutMs: 5_000, concurrency: 1, traffic: ledger });
    try {
      const started = Date.now();
      const hung = bounded.render("https://www.acmeind.example/hang");
      hung.catch(() => undefined);
      // Waiting for the one slot; its signal gives it up before it ever opens a page.
      const controller = new AbortController();
      const reason = new Error("task abandoned");
      const queued = bounded.render("https://www.acmeind.example/queued", { signal: controller.signal });
      const next = bounded.render("https://www.acmeind.example/fine");
      setTimeout(() => controller.abort(reason), 100);
      await expect(queued).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(3_000);
      await expect(hung).rejects.toMatchObject({ kind: "timeout" });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect((await next).html).toContain("fine");
      expect(server.requests.some(r => r.url === "/queued")).toBe(false);
      // The hung render is counted once, as a timeout.
      expect(ledger.snapshot()[0]).toMatchObject({ requests: 2, timeouts: 1, ok2xx: 1 });
    } finally { await bounded.close(); }
  }, 120_000);

  it("guards a redirect destination before sending it", async () => {
    const checked: string[] = [];
    const paced: string[] = [];
    let privateRequests = 0;
    const redirectServer = createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/private" });
        return res.end();
      }
      if (req.url === "/client") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<html><body>moving<script>location.href="/private"</script></body></html>');
      }
      if (req.url === "/client-pagination") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<html><body><a href="/jobs/one">Operations Director</a><button onclick="location.href=\'/private\'">Next</button></body></html>');
      }
      if (req.url === "/private") privateRequests++;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>private</body></html>");
    });
    await new Promise<void>(resolve => redirectServer.listen(0, "127.0.0.1", resolve));
    const address = redirectServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const startUrl = `http://127.0.0.1:${port}/start`;
    const guarded = new BrowserRenderer({
      userAgent: "AVAJobMonitor/0.1 (test)",
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
      // The fixture is on loopback, which the address guard would otherwise refuse outright.
      isAllowedAddress: address => address === "127.0.0.1",
      beforeNavigate: async host => { paced.push(host); },
      allowNavigate: async url => {
        checked.push(url);
        if (new URL(url).pathname === "/private") throw new SourceFetchError(`robots.txt disallows ${url}`, "blocked", 999);
      },
    });
    try {
      await expect(guarded.render(startUrl)).rejects.toMatchObject({ kind: "blocked", status: 999 });
      expect(checked.map(url => new URL(url).pathname)).toEqual(["/start", "/private"]);
      expect(paced).toEqual(["127.0.0.1", "127.0.0.1"]);
      expect(privateRequests).toBe(0);

      checked.length = 0;
      paced.length = 0;
      await expect(guarded.render(`http://127.0.0.1:${port}/client`)).rejects.toMatchObject({ kind: "blocked", status: 999 });
      expect(checked.map(url => new URL(url).pathname)).toEqual(["/client", "/private"]);
      expect(privateRequests).toBe(0);

      checked.length = 0;
      paced.length = 0;
      const partial = await guarded.render(`http://127.0.0.1:${port}/client-pagination`, { scrollAndExpand: true });
      expect(partial.incomplete).toBe(true);
      expect(partial.compressedListingPages).toHaveLength(1);
      expect(ats.extractPostingsFromHtml(partial.html, partial.finalUrl).map(posting => posting.title)).toEqual(["Operations Director"]);
      expect(checked.map(url => new URL(url).pathname)).toEqual(["/client-pagination", "/private"]);
      expect(privateRequests).toBe(0);
    } finally {
      await guarded.close();
      await new Promise<void>(resolve => redirectServer.close(() => resolve()));
    }
  }, 120_000);

  it("keeps the page from reaching the private network: no script, frame, redirect or websocket gets through", async () => {
    // The page is on 127.0.0.1, which this renderer's policy treats as public. A second loopback
    // address plays the worker's private network: macOS does not bind 127.0.0.2 by default.
    const hits: string[] = [];
    const internal = createServer((req, res) => { hits.push(req.url ?? "/"); res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" }); res.end("internal secret"); });
    internal.on("upgrade", (req, socket) => { hits.push(`upgrade ${req.url}`); socket.destroy(); });
    const internalHost = process.platform === "darwin" ? "::1" : "127.0.0.2";
    const internalAuthority = internalHost.includes(":") ? `[${internalHost}]` : internalHost;
    const listen = (server: ReturnType<typeof createServer>, host: string) => new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, host);
    });
    const close = (server: ReturnType<typeof createServer>) => server.listening
      ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      : Promise.resolve();
    let inside = "";
    const page = createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { location: `${inside}/redirected` }); return res.end(); }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><div id="out">waiting</div><iframe src="${inside}/frame"></iframe><script>
        try { new WebSocket(${JSON.stringify(inside.replace("http", "ws") + "/socket")}); } catch (e) {}
        fetch(${JSON.stringify(inside + "/fetched")}).then(function (r) { return r.text(); })
          .then(function (t) { document.getElementById("out").textContent = t; })
          .catch(function () { document.getElementById("out").textContent = "refused"; });
      </script></body></html>`);
    });
    let guarded: BrowserRenderer | undefined;
    try {
      await listen(internal, internalHost);
      inside = `http://${internalAuthority}:${(internal.address() as AddressInfo).port}`;
      await listen(page, "127.0.0.1");
      const outside = `http://127.0.0.1:${(page.address() as AddressInfo).port}`;
      guarded = new BrowserRenderer({
        userAgent: "AVAJobMonitor/0.1 (test)",
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        isAllowedAddress: address => address === "127.0.0.1",
      });
      const rendered = await guarded.render(`${outside}/careers`);
      expect(rendered.html).toContain("refused");
      expect(rendered.html).not.toContain("internal secret");
      await expect(guarded.render(`${outside}/redirect`)).rejects.toMatchObject({ kind: "blocked" });
      // Refused in Node before any browser work, as the fetcher would.
      await expect(guarded.render(`${inside}/direct`)).rejects.toMatchObject({ kind: "blocked" });
      await expect(guarded.render("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ kind: "blocked" });
      expect(hits).toEqual([]);
    } finally {
      await guarded?.close();
      await close(page);
      await close(internal);
    }
  }, 120_000);
});
