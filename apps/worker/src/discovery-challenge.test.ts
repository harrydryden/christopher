import { expect, it } from "vitest";
import { discovery } from "@col/core";
import { PoliteFetcher } from "./fetcher";
import { startTestServer, type RouteTable } from "./test-server";

const hosts = ["www.guard.test", "challenge.guard.test", "careers.guard.test"];

async function inspect(routes: RouteTable) {
  const site = await startTestServer(routes, hosts);
  try {
    const fetcher = new PoliteFetcher({ userAgent: "test", hostMap: site.hostMap, perHostDelayMs: 0, respectRobots: () => true });
    const result = await discovery.discoverCareersSources("https://www.guard.test/", {
      fetchText: (url, init) => fetcher.fetchText(url, init),
      resolveSpec: () => null,
      findSpecsInText: () => [],
      verifySpec: async () => ({ ok: false, error: "no board" }),
      extractFromHtml: () => [],
      maxFetches: 8,
      maxDurationMs: 3000,
    });
    return { requests: site.requests, result };
  } finally {
    await site.close();
  }
}

it("stops a challenged final host and its redirecting alias while allowing another host", async () => {
  const { requests, result } = await inspect({
    "www.guard.test": {
      "/robots.txt": { status: 404, body: "" },
      "/": { status: 302, body: "", headers: { location: "https://challenge.guard.test/" } },
      "/careers": { body: "Should not be requested" },
    },
    "challenge.guard.test": {
      "/robots.txt": { status: 404, body: "" },
      "/": { status: 403, body: "ordinary wrapper", headers: { "cf-mitigated": "challenge" } },
      "/careers": { body: "Should not be requested" },
    },
    "careers.guard.test": {
      "/robots.txt": { status: 404, body: "" },
      "/": { status: 302, body: "", headers: { location: "https://challenge.guard.test/careers" } },
    },
  });
  expect(requests.filter(request => request.host === "www.guard.test" && request.url !== "/robots.txt")).toHaveLength(1);
  expect(requests.filter(request => request.host === "challenge.guard.test" && request.url !== "/robots.txt")).toHaveLength(1);
  expect(requests.some(request => request.host === "careers.guard.test" && request.url === "/")).toBe(true);
  expect(result.log.join("\n")).toContain("explicit bot challenge on challenge.guard.test");
});

it("does not suppress a host after a bare path 403", async () => {
  const { requests, result } = await inspect({
    "www.guard.test": {
      "/robots.txt": { status: 404, body: "" },
      "/": { status: 403, body: "Forbidden" },
      "/careers": { body: "<html><body>Nothing here</body></html>" },
    },
    "careers.guard.test": { "/robots.txt": { status: 404, body: "" } },
  });
  expect(requests.some(request => request.host === "www.guard.test" && request.url === "/careers")).toBe(true);
  expect(result.log.join("\n")).not.toContain("explicit bot challenge");
});

it("does not suppress a host after a robots denial", async () => {
  const { requests, result } = await inspect({
    "www.guard.test": {
      "/robots.txt": { body: "User-agent: *\nDisallow: /\nAllow: /careers\n", contentType: "text/plain" },
      "/": { body: "Should not be requested" },
      "/careers": { body: "<html><body>Allowed careers page</body></html>" },
    },
    "careers.guard.test": { "/robots.txt": { status: 404, body: "" } },
  });
  expect(requests.some(request => request.host === "www.guard.test" && request.url === "/")).toBe(false);
  expect(requests.some(request => request.host === "www.guard.test" && request.url === "/careers")).toBe(true);
  expect(result.log.join("\n")).not.toContain("explicit bot challenge");
});
