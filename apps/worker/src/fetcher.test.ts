/** The polite fetcher: identification, robots.txt, rate limiting, and bot-protection detection. */
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceFetchError } from "@christopher/core";
import { createDb, listHttpHostDaily } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { sha1 } from "@christopher/core";
import { ATS_API_DELAY_MS, DEFAULT_HOST_DELAY_MS, HARD_MAX_BODY_BYTES, hostDelayMs, HttpTrafficLedger, PoliteFetcher, userAgentFor } from "./fetcher";
import { startTestServer, type TestServer } from "./test-server";

let server: TestServer;

const HOSTS = ["www.example.test", "blocked.test", "boards-api.greenhouse.io"];

beforeAll(async () => {
  server = await startTestServer(
    {
      "www.example.test": {
        "/": { body: "<html><body>home</body></html>" },
        "/allowed": { body: "<html><body>allowed</body></html>" },
        "/private/secret": { body: "<html><body>secret</body></html>" },
        "/robots.txt": { body: "User-agent: *\nDisallow: /private/\nAllow: /private/public\n", contentType: "text/plain" },
        "/private/public": { body: "<html><body>public under a disallowed prefix</body></html>" },
        "/echo": (req) => ({ body: JSON.stringify({ ua: req.headers["user-agent"], host: req.headers["x-forwarded-host"] }) }),
      },
      "blocked.test": {
        "/robots.txt": { status: 404, body: "" },
        "/403": { status: 403, body: "<html><body>forbidden</body></html>" },
        "/429": { status: 429, body: "<html><body>slow down</body></html>", headers: { "retry-after": "5" } },
        "/429-no-hint": { status: 429, body: "<html><body>slow down</body></html>" },
        "/503": { status: 503, body: "<html><body>unavailable</body></html>" },
        "/503-challenge": { status: 503, body: "<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>" },
        "/challenge": { body: "<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>" },
      },
      "boards-api.greenhouse.io": {
        "/robots.txt": { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" },
        "/v1/boards/acme/jobs": { body: { jobs: [] } },
        "/429": { status: 429, body: "slow down", headers: { "retry-after": "30" } },
      },
    },
    HOSTS,
  );
});

afterAll(async () => {
  await server?.close();
});

function fetcher(over: Partial<ConstructorParameters<typeof PoliteFetcher>[0]> = {}) {
  return new PoliteFetcher({
    userAgent: userAgentFor("you@example.com"),
    hostMap: server.hostMap,
    perHostDelayMs: 0,
    respectRobots: () => true,
    ...over,
  });
}

describe("conditional HTTP cache", () => {
  it("reuses a validated body on 304 and reads changed ETags", async () => {
    const seen: unknown[] = [];
    let tag = 'v1';
    const fixture = await startTestServer({ 'cache.test': { '/': req => {
      seen.push(req.headers['if-none-match']);
      return req.headers['if-none-match'] === tag ? { status: 304, body: '', headers: { etag: tag } } : { body: tag, headers: { etag: tag } };
    } } }, ['cache.test']);
    try {
      const fetcher = new PoliteFetcher({ userAgent: 'test', hostMap: fixture.hostMap, perHostDelayMs: 0 });
      expect((await fetcher.fetchText('https://cache.test/')).body).toBe('v1');
      expect((await fetcher.fetchText('https://cache.test/')).body).toBe('v1');
      tag = 'v2';
      expect((await fetcher.fetchText('https://cache.test/')).body).toBe('v2');
      expect(seen).toEqual([undefined, 'v1', 'v1']);
    } finally { await fixture.close(); }
  });
});

describe("polite fetcher", () => {
  it("identifies itself with a contact address", async () => {
    const res = await fetcher().fetchText("https://www.example.test/echo");
    const body = JSON.parse(res.body) as { ua: string; host: string };
    expect(body.ua).toContain("ChristopherJobMonitor");
    expect(body.ua).toContain("mailto:you@example.com");
    // The logical hostname is preserved even though the request went to the test server.
    expect(body.host).toBe("www.example.test");
    expect(res.url).toContain("https://www.example.test/echo");
  });

  it("honours robots.txt, including a more specific Allow", async () => {
    const f = fetcher();
    await expect(f.fetchText("https://www.example.test/private/secret")).rejects.toThrow(SourceFetchError);
    await expect(f.fetchText("https://www.example.test/allowed")).resolves.toMatchObject({ status: 200 });
    await expect(f.fetchText("https://www.example.test/private/public")).resolves.toMatchObject({ status: 200 });
  });

  it("can be told to ignore robots.txt", async () => {
    const f = fetcher({ respectRobots: () => false });
    await expect(f.fetchText("https://www.example.test/private/secret")).resolves.toMatchObject({ status: 200 });
  });

  it("reads applicant tracking feeds regardless of robots.txt, since they are published for job boards", async () => {
    const f = fetcher();
    const res = await f.fetchText("https://boards-api.greenhouse.io/v1/boards/acme/jobs");
    expect(res.status).toBe(200);
  });

  it("reports bot protection as blocked rather than as a normal failure", async () => {
    const f = fetcher();
    const error = await f.fetchText("https://blocked.test/403").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceFetchError);
    expect((error as SourceFetchError).kind).toBe("blocked");
    expect((error as SourceFetchError).status).toBe(403);
    const challenge = await f.fetchText("https://blocked.test/challenge").catch((e: unknown) => e);
    expect((challenge as SourceFetchError).kind).toBe("blocked");
  });

  it("treats 429 and 503 as a back-off: rate limited, paced, never blocked", async () => {
    // A blocked source stays blocked until someone clears it. A host asking us to come back in a
    // minute must not cost a source that, so it is a rate limit: the host is paced and the scan
    // fails and retries like any other failure.
    const paced: Array<{ host: string; delayMs: number }> = [];
    const f = fetcher({ deferHost: async (host, delayMs) => { paced.push({ host, delayMs }); } });
    for (const [path, status, delayMs] of [["/429", 429, 5000], ["/429-no-hint", 429, 60_000], ["/503", 503, 60_000]] as const) {
      const error = await f.fetchText(`https://blocked.test${path}`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SourceFetchError);
      expect((error as SourceFetchError).kind).toBe("rate_limited");
      expect((error as SourceFetchError).status).toBe(status);
      expect(paced.at(-1)).toEqual({ host: "blocked.test", delayMs });
    }
    // Bot protection served under a 503 is still bot protection: waiting does not fix it.
    const challenge = await f.fetchText("https://blocked.test/503-challenge").catch((e: unknown) => e);
    expect((challenge as SourceFetchError).kind).toBe("blocked");
  });

  it("waits between requests to the same host", async () => {
    const f = fetcher({ perHostDelayMs: 120 });
    const started = Date.now();
    await Promise.all([
      f.fetchText("https://www.example.test/"),
      f.fetchText("https://www.example.test/allowed"),
      f.fetchText("https://www.example.test/echo"),
    ]);
    // Three requests to one host: at least two gaps.
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it("times out instead of hanging", async () => {
    const f = fetcher({ defaultTimeoutMs: 1 });
    const error = await f.fetchText("https://www.example.test/").catch((e: unknown) => e);
    if (error instanceof SourceFetchError) expect(["timeout", "network"]).toContain(error.kind);
  });

  it("refuses a host the test map does not name, rather than reaching the real internet", async () => {
    // Discovery guesses applicant tracking slugs from a domain name as a last resort. Without this
    // rule a test would query real boards, and whether it passed would depend on who happens to
    // own that slug.
    const error = await fetcher().fetchText("https://api.lever.co/v0/postings/orbital?mode=json").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceFetchError);
    expect((error as SourceFetchError).kind).toBe("network");
    expect((error as Error).message).toContain("not in the test host map");
  });

  it("maps every host when the map has a wildcard", async () => {
    const f = new PoliteFetcher({ userAgent: "test", hostMap: { "*": server.hostMap["www.example.test"]! }, perHostDelayMs: 0 });
    await expect(f.fetchText("https://anything.test/")).resolves.toMatchObject({ status: 404 });
  });

  it("returns a 404 as a response rather than throwing", async () => {
    const res = await fetcher().fetchText("https://www.example.test/nope");
    expect(res.status).toBe(404);
  });
});

  it("rejects an oversized response instead of passing truncated HTML to extraction", async () => {
    const f = fetcher({ maxBodyBytes: 10, respectRobots: () => false });
    await expect(f.fetchText("https://www.example.test/")).rejects.toThrow("refusing truncated");
    const normal = fetcher({ respectRobots: () => false });
    await expect(normal.fetchText("https://www.example.test/", { maxBodyBytes: 10 })).rejects.toThrow("refusing truncated");
    await expect(normal.fetchText("https://www.example.test/", { maxBodyBytes: 100 })).resolves.toMatchObject({ status: 200 });
    // Each adapter asks for what its feed needs, so the per-request cap wins over the
    // fetcher-wide option rather than the other way round.
    await expect(f.fetchText("https://www.example.test/", { maxBodyBytes: 100 })).resolves.toMatchObject({ status: 200 });
  });

describe("memory bounds", () => {
  it("refuses a body over the global ceiling however much the caller allows", async () => {
    // The Greenhouse board that killed the worker answered with 41 MB against a caller-set
    // allowance of 60 MB. No caller may raise the ceiling: the request fails cleanly instead,
    // which a scan records as a failed scan rather than as a dead process.
    const huge = await startTestServer({ "huge.test": { "/board": { body: "x".repeat(HARD_MAX_BODY_BYTES + 1_000_000), contentType: "application/json" } } }, ["huge.test"]);
    try {
      const f = new PoliteFetcher({ userAgent: "test", hostMap: huge.hostMap, perHostDelayMs: 0 });
      const error = await f.fetchText("https://huge.test/board", { maxBodyBytes: 60_000_000 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SourceFetchError);
      expect((error as Error).message).toContain(`Response exceeds ${HARD_MAX_BODY_BYTES} bytes`);
    } finally { await huge.close(); }
  }, 60_000);

  it("keeps the revalidation cache bounded: no large bodies, oldest evicted first", async () => {
    // Every cached body is held for a week, so an unbounded cache leaks the heap a feed at a time.
    const conditional: string[] = [];
    const body = (n: number) => "y".repeat(n);
    const store = await startTestServer({ "bounded.test": {
      "/big": (req) => { conditional.push(`big:${req.headers["if-none-match"] ?? "none"}`); return { body: body(600_000), headers: { etag: "big-1" } }; },
      ...Object.fromEntries(Array.from({ length: 34 }, (_, i) => [`/page/${i}`, (req: { headers: Record<string, string | undefined> }) => {
        conditional.push(`page/${i}:${req.headers["if-none-match"] ?? "none"}`);
        return { body: body(500_000), headers: { etag: `page-${i}` } };
      }])),
    } }, ["bounded.test"]);
    try {
      const f = new PoliteFetcher({ userAgent: "test", hostMap: store.hostMap, perHostDelayMs: 0 });
      // A body over the per-entry limit is never stored, so the second read is unconditional.
      await f.fetchText("https://bounded.test/big");
      await f.fetchText("https://bounded.test/big");
      expect(conditional.filter(c => c.startsWith("big:"))).toEqual(["big:none", "big:none"]);

      // 34 x 500 KB is more than the 16 MB total, so the first pages are evicted and the last kept.
      for (let i = 0; i < 34; i++) await f.fetchText(`https://bounded.test/page/${i}`);
      conditional.length = 0;
      await f.fetchText("https://bounded.test/page/0");
      await f.fetchText("https://bounded.test/page/33");
      expect(conditional).toEqual(["page/0:none", "page/33:page-33"]);
    } finally { await store.close(); }
  }, 60_000);
});

describe("per-host pacing", () => {
  it("paces a shared applicant-tracking API faster than a company's own site", () => {
    // Every Greenhouse board in the catalogue and every per-role description fetch goes to one
    // hostname. At two seconds a request that is half an hour of a daily run spent waiting.
    expect(hostDelayMs("boards-api.greenhouse.io")).toBe(ATS_API_DELAY_MS);
    expect(hostDelayMs("boards-api.eu.greenhouse.io")).toBe(ATS_API_DELAY_MS);
    expect(hostDelayMs("api.lever.co")).toBe(ATS_API_DELAY_MS);
    // A company's own careers page is one site serving one employer, and keeps the 2s promise.
    expect(hostDelayMs("careers.example.com")).toBe(DEFAULT_HOST_DELAY_MS);
    expect(hostDelayMs("www.example.test")).toBe(2000);
    // An override (the test host map) never paces a host faster than it asks for.
    expect(hostDelayMs("boards-api.greenhouse.io", 50)).toBe(50);
  });

  it("reserves each host for its own interval, and a Retry-After still overrides both", async () => {
    const reserved: Array<{ host: string; delayMs: number }> = [];
    const paced: Array<{ host: string; delayMs: number }> = [];
    const f = new PoliteFetcher({
      userAgent: "test",
      hostMap: server.hostMap,
      reserveHost: async (host, delayMs) => { reserved.push({ host, delayMs }); return 0; },
      deferHost: async (host, delayMs) => { paced.push({ host, delayMs }); },
    });
    await f.fetchText("https://boards-api.greenhouse.io/v1/boards/acme/jobs");
    await f.fetchText("https://www.example.test/allowed");
    expect(reserved).toEqual([
      { host: "boards-api.greenhouse.io", delayMs: 250 },
      { host: "www.example.test", delayMs: 2000 },
    ]);

    // The back-off is written to the shared pacing table at the host's own request, and the 250ms
    // interval has nothing to say about it: a host asking for thirty seconds gets thirty seconds.
    await expect(f.fetchText("https://boards-api.greenhouse.io/429")).rejects.toThrow(SourceFetchError);
    expect(paced).toEqual([{ host: "boards-api.greenhouse.io", delayMs: 30_000 }]);
  });
});

describe("revalidating a listing too large to cache", () => {
  it("keeps validators without the body, honours a 304, and spots an identical body by hash", async () => {
    // A body over the cache's per-entry limit used to be re-downloaded and re-parsed every day,
    // because nothing was kept of it to make a conditional request with.
    const conditional: Array<string | undefined> = [];
    const big = "y".repeat(600_000);
    const store = await startTestServer({ "large.test": {
      "/board": (req) => {
        conditional.push(req.headers["if-none-match"] as string | undefined);
        return req.headers["if-none-match"] === "L1" ? { status: 304, body: "", headers: { etag: "L1" } } : { body: big, headers: { etag: "L1" } };
      },
      // A host that publishes no validator at all: the hash has to stand on its own.
      "/unvalidated": { body: big },
    } }, ["large.test"]);
    try {
      const f = new PoliteFetcher({ userAgent: "test", hostMap: store.hostMap, perHostDelayMs: 0 });
      const first = await f.fetchText("https://large.test/board", { revalidateLargeBody: true });
      expect(first.body.length).toBe(600_000);
      expect(first.unchanged).toBeUndefined();
      expect(first.contentHash).toBe(sha1(big));

      const second = await f.fetchText("https://large.test/board", { revalidateLargeBody: true });
      expect(conditional).toEqual([undefined, "L1"]);
      expect(second).toMatchObject({ status: 304, revalidated: true, unchanged: true, body: "", contentHash: sha1(big) });

      // Nothing of the body was retained, so a caller that cannot handle an empty answer — anything
      // that does not ask for this — still gets the whole listing, unconditionally.
      const plain = await f.fetchText("https://large.test/board");
      expect(plain.body.length).toBe(600_000);
      expect(plain.unchanged).toBeUndefined();
      expect(conditional.at(-1)).toBeUndefined();

      const once = await f.fetchText("https://large.test/unvalidated", { revalidateLargeBody: true });
      expect(once.unchanged).toBeUndefined();
      const twice = await f.fetchText("https://large.test/unvalidated", { revalidateLargeBody: true });
      // The bytes came down the wire, so this is no transfer saved; what it saves is the parse and
      // everything the parse feeds.
      expect(twice.unchanged).toBe(true);
      expect(twice.revalidated).toBeUndefined();
      expect(twice.body.length).toBe(600_000);
    } finally { await store.close(); }
  }, 60_000);
});

describe("outbound traffic counters", () => {
  const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";
  const today = () => new Date().toISOString().slice(0, 10);
  let traffic: TestServer;
  let blackhole: net.Server;
  const hungSockets = new Set<net.Socket>();
  let client: ReturnType<typeof createDb>;

  beforeAll(async () => {
    traffic = await startTestServer({ "traffic.test": {
      "/etagged": (req) => req.headers["if-none-match"] === "t1" ? { status: 304, body: "", headers: { etag: "t1" } } : { body: "hello world", headers: { etag: "t1" } },
      "/429": { status: 429, body: "slow", headers: { "retry-after": "1" } },
      "/403": { status: 403, body: "nope" },
    } }, ["traffic.test"]);
    // Accepts the connection and never answers, so the abort is the only way out: a real timeout
    // rather than a race between a local response and a one-millisecond deadline.
    blackhole = net.createServer(socket => { hungSockets.add(socket); socket.on("close", () => hungSockets.delete(socket)); });
    await new Promise<void>(resolve => blackhole.listen(0, "127.0.0.1", resolve));
    client = createDb(DATABASE_URL, { max: 2 });
    await runMigrations(client.db);
  }, 60_000);

  afterAll(async () => {
    await traffic?.close();
    // The aborted request leaves its socket open, and close() waits for every one of them.
    for (const socket of hungSockets) socket.destroy();
    await new Promise<void>(resolve => blackhole?.close(() => resolve()));
    await client?.pool.end();
  });

  /** The mixed sequence, run against a ledger, so each assertion can name the outcome it counts. */
  async function runMixedSequence(ledger: HttpTrafficLedger) {
    const slowPort = (blackhole.address() as net.AddressInfo).port;
    const f = new PoliteFetcher({ userAgent: "test", perHostDelayMs: 0, traffic: ledger,
      hostMap: { ...traffic.hostMap, "slow.test": `127.0.0.1:${slowPort}` } });
    const first = await f.fetchText("https://traffic.test/etagged");
    expect(first.revalidated).toBeUndefined();
    const second = await f.fetchText("https://traffic.test/etagged");
    // Nothing came down the wire, and the caller is told so: a 304 must not read as a transfer.
    expect(second.revalidated).toBe(true);
    expect(second.body).toBe("hello world");
    await expect(f.fetchText("https://traffic.test/429")).rejects.toThrow(SourceFetchError);
    await expect(f.fetchText("https://traffic.test/403")).rejects.toThrow(SourceFetchError);
    await expect(f.fetchText("https://traffic.test/etagged", { maxBodyBytes: 3 })).rejects.toThrow("refusing truncated");
    await expect(f.fetchText("https://slow.test/hang", { timeoutMs: 100 })).rejects.toThrow(SourceFetchError);
  }

  it("counts 200, 304, 429, 403, a body over the cap and a timeout, per host and day", async () => {
    const ledger = new HttpTrafficLedger(null);
    await runMixedSequence(ledger);
    const rows = ledger.snapshot().sort((a, b) => a.host.localeCompare(b.host));
    expect(rows.map(r => [r.day, r.host, r.via])).toEqual([[today(), "slow.test", "http"], [today(), "traffic.test", "http"]]);

    const board = rows.find(r => r.host === "traffic.test")!;
    expect(board.requests).toBe(5);
    expect(board.ok2xx).toBe(2);
    expect(board.notModified304).toBe(1);
    expect(board.client4xx).toBe(2);
    // The status mix accounts for every request once; the reasons sit on top of it, so the 429 is
    // both a 4xx and a rate limit.
    expect(board.rateLimited).toBe(1);
    expect(board.blocked).toBe(1);
    expect(board.capRejected).toBe(1);
    // "hello world" twice (the second read is over the cap but was still transferred), plus the
    // two short error bodies. The 304 transferred nothing.
    expect(board.bytesIn).toBe("hello world".length * 2 + "slow".length + "nope".length);
    expect(board.latencyBuckets[0]).toBe(5);
    expect(board.durationMsSum).toBeGreaterThanOrEqual(0);

    const hung = rows.find(r => r.host === "slow.test")!;
    expect(hung.requests).toBe(1);
    expect(hung.timeouts).toBe(1);
    expect(hung.bytesIn).toBe(0);
    expect(hung.ok2xx + hung.client4xx + hung.server5xx + hung.redirects3xx + hung.notModified304).toBe(0);
  });

  it("counts a robots denial without counting a request for it", async () => {
    const ledger = new HttpTrafficLedger(null);
    const f = new PoliteFetcher({ userAgent: "test", perHostDelayMs: 0, traffic: ledger, hostMap: server.hostMap, respectRobots: () => true });
    await expect(f.fetchText("https://www.example.test/private/secret")).rejects.toThrow(SourceFetchError);
    const [row] = ledger.snapshot();
    expect(row!.robotsDenied).toBe(1);
    // One request was made: robots.txt itself. The page was never asked for.
    expect(row!.requests).toBe(1);
  });

  it("flushes one row per day, host and via, and a second flush adds to it", async () => {
    await client.db.execute(sql`delete from http_host_daily where host in ('traffic.test','slow.test')`);
    const ledger = new HttpTrafficLedger(client.db, { flushIntervalMs: 3_600_000 });
    try {
      await runMixedSequence(ledger);
      await ledger.flush();
      // Flushing empties the accumulator: what is written is never written twice.
      expect(ledger.snapshot()).toEqual([]);
      const first = (await listHttpHostDaily(client.db, 1)).filter(r => r.host === "traffic.test");
      expect(first).toHaveLength(1);
      expect(first[0]!.requests).toBe(5);
      expect(first[0]!.latencyBuckets[0]).toBe(5);

      await runMixedSequence(ledger);
      await ledger.flush();
      const second = (await listHttpHostDaily(client.db, 1)).filter(r => r.host === "traffic.test");
      // Still one row for the day, with both runs in it: the rollup adds, it does not replace.
      expect(second).toHaveLength(1);
      expect(second[0]!.requests).toBe(10);
      expect(second[0]!.notModified304).toBe(2);
      expect(second[0]!.rateLimited).toBe(2);
      expect(second[0]!.latencyBuckets[0]).toBe(10);
      expect(second[0]!.bytesIn).toBe(first[0]!.bytesIn * 2);
    } finally {
      await ledger.close();
      await client.db.execute(sql`delete from http_host_daily where host in ('traffic.test','slow.test')`);
    }
  }, 60_000);
});
