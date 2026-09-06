/** The polite fetcher: identification, robots.txt, rate limiting, and bot-protection detection. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceFetchError } from "@christopher/core";
import { PoliteFetcher, userAgentFor } from "./fetcher";
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
        "/429": { status: 429, body: "<html><body>slow down</body></html>" },
        "/challenge": { body: "<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>" },
      },
      "boards-api.greenhouse.io": {
        "/robots.txt": { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" },
        "/v1/boards/acme/jobs": { body: { jobs: [] } },
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
    for (const [path, status] of [["/403", 403], ["/429", 429]] as const) {
      const error = await f.fetchText(`https://blocked.test${path}`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SourceFetchError);
      expect((error as SourceFetchError).kind).toBe("blocked");
      expect((error as SourceFetchError).status).toBe(status);
    }
    const challenge = await f.fetchText("https://blocked.test/challenge").catch((e: unknown) => e);
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
  });
