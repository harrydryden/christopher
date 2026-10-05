/**
 * The captured logo is served to signed-in readers only, sandboxed, cached hard by its capture
 * time, and absent — not blank, not a 500 — for a company the worker has never captured. Only the
 * versioned 200 may be held by the CDN, and a revalidation is answered without reading the bytes.
 */
import { beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
const version = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ requireUser: auth }));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@col/db", () => ({ readCompanyLogo: read, companyLogoVersion: version }));

import { GET } from "./route";

const ID = "11111111-2222-4333-8444-555555555555";
const FETCHED = new Date("2026-03-04T05:06:07.000Z");
const V = String(FETCHED.getTime());
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const request = (headers: Record<string, string> = {}, v = "1") => new Request(`http://localhost/api/companies/${ID}/logo?v=${v}`, { headers });
const CDN = "public, max-age=31536000, immutable";

beforeEach(() => {
  auth.mockReset(); auth.mockResolvedValue({ id: "user-1" });
  read.mockReset(); read.mockResolvedValue({ contentType: "image/png", bytes, fetchedAt: FETCHED });
  version.mockReset(); version.mockResolvedValue(FETCHED);
});

it("serves the stored bytes with their type, length and version, cached publicly for as long as the URL names them", async () => {
  const response = await GET(request({}, V), params());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-length")).toBe(String(bytes.length));
  expect(response.headers.get("etag")).toBe(`"${V}"`);
  expect(response.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
  expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  expect(read).toHaveBeenCalledWith({}, ID);
  // A URL that names another capture, or none, may be answered by a newer one: an hour, no longer.
  expect((await GET(request(), params())).headers.get("cache-control")).toBe("public, max-age=3600");
});

it("lets the CDN keep the 200 for the URL naming the stored capture, and nothing else", async () => {
  // Without a validator the bytes are read in one statement, as before: no extra round trip.
  const versioned = await GET(request({}, V), params());
  expect(versioned.status).toBe(200);
  expect(versioned.headers.get("cdn-cache-control")).toBe(CDN);
  expect(version).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);

  // Another capture's URL, or none: its answer changes when the logo does, so the CDN never holds it.
  for (const url of [`http://localhost/api/companies/${ID}/logo?v=1`, `http://localhost/api/companies/${ID}/logo`]) {
    const response = await GET(new Request(url), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("cdn-cache-control")).toBeNull();
  }
});

it("answers a matching if-none-match with 304 from the capture time alone, before the bytes are read", async () => {
  for (const validator of [`"${V}"`, `W/"${V}"`, `"1", "${V}"`, "*"]) {
    version.mockClear(); read.mockClear();
    const response = await GET(request({ "if-none-match": validator }, V), params());
    expect(response.status, validator).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(`"${V}"`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    // A 304 is never what the CDN keeps: it would answer a browser that has no copy.
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(version).toHaveBeenCalledWith({}, ID);
    expect(read).not.toHaveBeenCalled();
  }
});

it("answers a stale validator with the new bytes, not another 304", async () => {
  const response = await GET(request({ "if-none-match": '"1"' }, V), params());
  expect(response.status).toBe(200);
  expect(response.headers.get("cdn-cache-control")).toBe(CDN);
  expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
});

it("sandboxes every logo, so an SVG opened on its own cannot run in this origin", async () => {
  read.mockResolvedValue({ contentType: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), fetchedAt: FETCHED });
  for (const response of [await GET(request(), params()), await GET(request({ "if-none-match": `"${V}"` }), params())]) {
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
  }
});

it("refuses to serve a scripted SVG stored before capture learned to refuse one", async () => {
  read.mockResolvedValue({ contentType: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'/cv\')"></svg>'), fetchedAt: FETCHED });
  const response = await GET(request({}, V), params());
  expect(response.status).toBe(404);
  expect(response.headers.get("cdn-cache-control")).toBeNull();
  expect(await response.text()).not.toContain("onload");
});

it("is 404, never held by the CDN, for an id that is not a uuid and for a company with nothing captured", async () => {
  const notUuid = await GET(request({}, V), params("not-a-uuid"));
  expect(notUuid.status).toBe(404);
  expect(notUuid.headers.get("cdn-cache-control")).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expect(version).not.toHaveBeenCalled();
  read.mockResolvedValue(null);
  version.mockResolvedValue(null);
  for (const headers of [{}, { "if-none-match": `"${V}"` }] as Record<string, string>[]) {
    const response = await GET(request(headers, V), params());
    expect(response.status).toBe(404);
    expect(response.headers.get("cdn-cache-control")).toBeNull();
    expect(response.headers.get("cache-control")).toBeNull();
  }
});

it("authenticates before it reads anything", async () => {
  auth.mockRejectedValue(new Error("Unauthorised"));
  const response = await GET(request({ "if-none-match": `"${V}"` }, V), params());
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ ok: false, error: "Please sign in again." });
  expect(read).not.toHaveBeenCalled();
  expect(version).not.toHaveBeenCalled();
});
