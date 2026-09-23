/**
 * The captured logo is served to signed-in readers only, sandboxed, cached hard by its capture
 * time, and absent — not blank, not a 500 — for a company the worker has never captured.
 */
import { beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ requireUser: auth }));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@ava/db", () => ({ readCompanyLogo: read }));

import { GET } from "./route";

const ID = "11111111-2222-4333-8444-555555555555";
const FETCHED = new Date("2026-03-04T05:06:07.000Z");
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const request = (headers: Record<string, string> = {}, v = "1") => new Request(`http://localhost/api/companies/${ID}/logo?v=${v}`, { headers });

beforeEach(() => {
  auth.mockReset(); auth.mockResolvedValue({ id: "user-1" });
  read.mockReset(); read.mockResolvedValue({ contentType: "image/png", bytes, fetchedAt: FETCHED });
});

it("serves the stored bytes with their type, length and version, cached publicly for as long as the URL names them", async () => {
  const response = await GET(request({}, String(FETCHED.getTime())), params());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("content-length")).toBe(String(bytes.length));
  expect(response.headers.get("etag")).toBe(`"${FETCHED.getTime()}"`);
  expect(response.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
  expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  expect(read).toHaveBeenCalledWith({}, ID);
  // A URL that names another capture, or none, may be answered by a newer one: an hour, no longer.
  expect((await GET(request(), params())).headers.get("cache-control")).toBe("public, max-age=3600");
});

it("sandboxes every logo, so an SVG opened on its own cannot run in this origin", async () => {
  read.mockResolvedValue({ contentType: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), fetchedAt: FETCHED });
  for (const response of [await GET(request(), params()), await GET(request({ "if-none-match": `"${FETCHED.getTime()}"` }), params())]) {
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
  }
});

it("refuses to serve a scripted SVG stored before capture learned to refuse one", async () => {
  read.mockResolvedValue({ contentType: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'/cv\')"></svg>'), fetchedAt: FETCHED });
  const response = await GET(request(), params());
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("onload");
});

it("answers a matching if-none-match with 304 and no body", async () => {
  const response = await GET(request({ "if-none-match": `"${FETCHED.getTime()}"` }), params());
  expect(response.status).toBe(304);
  expect(response.headers.get("etag")).toBe(`"${FETCHED.getTime()}"`);
  expect(await response.text()).toBe("");
  // A stale validator is answered with the new bytes, not another 304.
  expect((await GET(request({ "if-none-match": '"1"' }), params())).status).toBe(200);
});

it("is 404 for an id that is not a uuid and for a company with nothing captured", async () => {
  expect((await GET(request(), params("not-a-uuid"))).status).toBe(404);
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValue(null);
  expect((await GET(request(), params())).status).toBe(404);
});

it("authenticates before it reads anything", async () => {
  auth.mockRejectedValue(new Error("Unauthorised"));
  const response = await GET(request(), params());
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ ok: false, error: "Please sign in again." });
  expect(read).not.toHaveBeenCalled();
});
