import { expect, it, vi } from "vitest";
import { discoverCompanyLogo } from "./logo";
import { dedupeKeyFor } from "../tasks";
import type { FetchContext, FetchResponse } from "../types";
const response = (url: string, body = "", contentType = "image/png", status = 200): FetchResponse => ({ url, body, status, headers: { "content-type": contentType } });
it("reads the main website icon using its final URL, without rendering", async () => {
  const fetchText = vi.fn().mockResolvedValueOnce(response("https://www.example.com/", '<link rel="icon" href="/brand.png">', "text/html"))
    .mockResolvedValueOnce(response("https://www.example.com/brand.png"));
  const render = vi.fn();
  expect(await discoverCompanyLogo("https://example.com/", { fetchText, render })).toBe("https://www.example.com/brand.png");
  expect(fetchText.mock.calls[1]?.[0]).toBe("https://www.example.com/brand.png");
  expect(render).not.toHaveBeenCalled();
});
it("falls back when the declared icon returns an HTML error page", async () => {
  const fetchText = vi.fn().mockResolvedValueOnce(response("https://example.com/", '<link rel="icon" href="/missing.png">', "text/html"))
    .mockResolvedValueOnce(response("https://example.com/missing.png", "Not found", "text/html"))
    .mockResolvedValueOnce(response("https://example.com/favicon.ico", "", "image/x-icon"));
  expect(await discoverCompanyLogo("https://example.com/", { fetchText })).toBe("https://example.com/favicon.ico");
});
it("uses a bounded GET if HEAD is unsupported", async () => {
  const fetchText = vi.fn().mockResolvedValueOnce(response("https://example.com/", "", "text/html"))
    .mockResolvedValueOnce(response("https://example.com/favicon.ico", "", "text/plain", 405))
    .mockResolvedValueOnce(response("https://example.com/favicon.ico"));
  expect(await discoverCompanyLogo("https://example.com/", { fetchText })).toBe("https://example.com/favicon.ico");
  expect(fetchText.mock.calls[2]?.[1]).toMatchObject({ maxBodyBytes: 262144 });
});
it("does not store an unavailable icon", async () => {
  const ctx: FetchContext = { fetchText: async url => response(url, "", "text/html", url.endsWith(".ico") ? 404 : 200) };
  expect(await discoverCompanyLogo("https://example.com/", ctx)).toBeNull();
});
it("keeps logo tasks for different website revisions separate from careers discovery", () => {
  const payload = { companyId: "one", logoOnly: true, homepageUrl: "https://old.example/" };
  expect(dedupeKeyFor("discover", payload)).not.toBe(dedupeKeyFor("discover", { companyId: "one" }));
  expect(dedupeKeyFor("discover", payload)).not.toBe(dedupeKeyFor("discover", { ...payload, homepageUrl: "https://new.example/" }));
});
