import { expect, it } from "vitest";
import {
  captureCompanyLogo, logoCandidates, logoRetryDelayMs, sniffImageType, unsafeSvgReason,
  LogoCaptureError, LOGO_MAX_BYTES,
} from "./logo-capture";
import type { FetchBytesResponse, FetchContext, FetchInit, FetchResponse } from "./types";

const filled = (signature: number[], length = 200): Uint8Array => {
  const bytes = new Uint8Array(length);
  bytes.set(signature, 0);
  return bytes;
};
const PNG = filled([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO = filled([0x00, 0x00, 0x01, 0x00]);
const HTML = new TextEncoder().encode("<!doctype html><title>Not found</title>".padEnd(300, " "));

const page = (url: string, body: string, status = 200): FetchResponse =>
  ({ url, body, status, headers: { "content-type": "text/html" } });
const asset = (url: string, bytes: Uint8Array, status = 200, contentType = "image/png"): FetchBytesResponse =>
  ({ url, status, bytes, headers: { "content-type": contentType } });

/** A fetcher that answers from a map of URL to response; anything else is a 404. */
function scripted(script: { homepage?: FetchResponse | Error; assets?: Record<string, FetchBytesResponse | Error> }) {
  const asked: Array<{ url: string; init?: FetchInit }> = [];
  const ctx: FetchContext = {
    async fetchText(url) {
      if (script.homepage instanceof Error) throw script.homepage;
      if (!script.homepage) throw new Error("no homepage scripted");
      return script.homepage;
    },
    async fetchBytes(url, init) {
      asked.push({ url, init });
      const hit = script.assets?.[url];
      if (hit instanceof Error) throw hit;
      return hit ?? { url, status: 404, bytes: new Uint8Array(), headers: {} };
    },
  };
  return { ctx, asked, urls: () => asked.map((a) => a.url) };
}

it("reads the icon the site declares, in preference to an icon service", async () => {
  const { ctx, urls, asked } = scripted({
    homepage: page("https://www.example.com/", '<link rel="icon" href="/brand.png">'),
    assets: { "https://www.example.com/brand.png": asset("https://www.example.com/brand.png", PNG) },
  });
  const logo = await captureCompanyLogo("https://example.com/", "example.com", ctx);
  expect(logo).toMatchObject({ contentType: "image/png", source: "site_icon", sourceUrl: "https://www.example.com/brand.png" });
  expect(logo.bytes.length).toBe(200);
  expect(urls()).toEqual(["https://www.example.com/brand.png"]);
  expect(asked[0]?.init).toMatchObject({ timeoutMs: 5_000, maxBodyBytes: LOGO_MAX_BYTES });
});

it("captures through an icon service when the homepage refuses the worker", async () => {
  const { ctx, urls } = scripted({
    homepage: Object.assign(new Error("blocked (403)"), { status: 403 }),
    assets: { "https://icons.duckduckgo.com/ip3/example.com.ico": asset("https://icons.duckduckgo.com/ip3/example.com.ico", ICO, 200, "image/x-icon") },
  });
  const logo = await captureCompanyLogo("https://example.com/", "example.com", ctx);
  expect(logo).toMatchObject({ contentType: "image/x-icon", source: "icon_service" });
  // The conventional location is still tried first: it costs one request and belongs to the site.
  expect(urls()).toEqual([
    "https://example.com/favicon.ico",
    "https://icons.duckduckgo.com/ip3/example.com.ico",
  ]);
});

it("rejects a candidate whose bytes are a web page, however the response labels them", async () => {
  const { ctx } = scripted({
    homepage: page("https://example.com/", '<link rel="icon" href="/brand.png">'),
    assets: {
      "https://example.com/brand.png": asset("https://example.com/brand.png", HTML, 200, "image/png"),
      "https://example.com/favicon.ico": asset("https://example.com/favicon.ico", PNG),
    },
  });
  const logo = await captureCompanyLogo("https://example.com/", "example.com", ctx);
  expect(logo.sourceUrl).toBe("https://example.com/favicon.ico");
});

it("rejects a body over the cap and moves on", async () => {
  const { ctx } = scripted({
    homepage: page("https://example.com/", '<link rel="icon" href="/huge.png">'),
    assets: {
      "https://example.com/huge.png": new Error(`body exceeds ${LOGO_MAX_BYTES} bytes`),
      "https://example.com/favicon.ico": asset("https://example.com/favicon.ico", PNG),
    },
  });
  const logo = await captureCompanyLogo("https://example.com/", "example.com", ctx);
  expect(logo.sourceUrl).toBe("https://example.com/favicon.ico");
  // A body the fetcher hands over anyway is rejected here rather than stored half-read.
  const oversize = scripted({
    homepage: page("https://example.com/", ""),
    assets: { "https://example.com/favicon.ico": asset("https://example.com/favicon.ico", filled([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], LOGO_MAX_BYTES + 1)) },
  });
  await expect(captureCompanyLogo("https://example.com/", "example.com", oversize.ctx)).rejects.toThrow(LogoCaptureError);
});

it("names every URL it tried when nothing is usable", async () => {
  const { ctx } = scripted({ homepage: page("https://example.com/", '<link rel="icon" href="/brand.png">') });
  const error = await captureCompanyLogo("https://example.com/", "example.com", ctx).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LogoCaptureError);
  expect((error as Error).message).toBe("No usable icon found for example.com");
  expect((error as LogoCaptureError).tried.join("\n")).toContain("https://example.com/brand.png: HTTP 404");
  expect((error as LogoCaptureError).tried).toHaveLength(4);
  expect((error as LogoCaptureError).tried.map((t) => t.split(": ")[0])).toEqual([
    "https://example.com/brand.png",
    "https://example.com/favicon.ico",
    "https://icons.duckduckgo.com/ip3/example.com.ico",
    "https://www.google.com/s2/favicons?domain=example.com&sz=128",
  ]);
});

it("tries the icon it captured last time first, and only once", async () => {
  const previous = "https://example.com/favicon.ico";
  const { ctx, urls } = scripted({
    homepage: page("https://example.com/", '<link rel="icon" href="/brand.png">'),
    assets: { [previous]: asset(previous, PNG) },
  });
  const logo = await captureCompanyLogo("https://example.com/", "example.com", ctx, { previousUrl: previous });
  expect(logo.sourceUrl).toBe(previous);
  expect(urls()).toEqual([previous]);
});

it("refuses to guess when the context cannot fetch bytes", async () => {
  const ctx: FetchContext = { fetchText: async (url) => page(url, "") };
  await expect(captureCompanyLogo("https://example.com/", "example.com", ctx)).rejects.toThrow("Binary fetch unavailable");
});

it("orders candidates: touch icon, declared icons, the conventional location, then the services", () => {
  const html = '<link rel="icon" href="/white.ico"><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/white.ico">';
  expect(logoCandidates(html, "https://www.example.com/", "Example.com")).toEqual([
    { url: "https://www.example.com/touch.png", source: "site_icon" },
    { url: "https://www.example.com/white.ico", source: "site_icon" },
    { url: "https://www.example.com/favicon.ico", source: "site_icon" },
    { url: "https://icons.duckduckgo.com/ip3/example.com.ico", source: "icon_service" },
    { url: "https://www.google.com/s2/favicons?domain=example.com&sz=128", source: "icon_service" },
  ]);
  expect(logoCandidates(null, "https://www.example.com/", "www.example.com").map((c) => c.url)).toEqual([
    "https://www.example.com/favicon.ico",
    "https://icons.duckduckgo.com/ip3/example.com.ico",
    "https://www.google.com/s2/favicons?domain=example.com&sz=128",
  ]);
});

it("names an image from its bytes and nothing else", () => {
  expect(sniffImageType(PNG)).toBe("image/png");
  expect(sniffImageType(ICO)).toBe("image/x-icon");
  expect(sniffImageType(filled([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  expect(sniffImageType(new TextEncoder().encode("GIF89a........"))).toBe("image/gif");
  const webp = filled([0x52, 0x49, 0x46, 0x46]);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  expect(sniffImageType(webp)).toBe("image/webp");
  expect(sniffImageType(filled([0x42, 0x4d]))).toBe("image/bmp");
  expect(sniffImageType(new TextEncoder().encode('  <svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
  expect(sniffImageType(new TextEncoder().encode('﻿<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>'))).toBe("image/svg+xml");
  expect(sniffImageType(HTML)).toBeNull();
  expect(sniffImageType(new Uint8Array([0x89]))).toBeNull();
});

it("widens the retry after each failure and stops at a month", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 99].map(logoRetryDelayMs)).toEqual([
    3_600_000, 21_600_000, 86_400_000, 259_200_000, 604_800_000, 2_592_000_000, 2_592_000_000, 2_592_000_000,
  ]);
  expect(logoRetryDelayMs(0)).toBe(3_600_000);
});

const svg = (inner: string, attrs = "") => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"${attrs}>${inner}</svg>`.padEnd(200, " "));

it("passes over a scripted SVG icon for the next candidate, and says why", async () => {
  // The catalogue is shared, so a scripted icon on one company's site would be served to everyone.
  const { ctx, urls } = scripted({
    homepage: page("https://evil.example/", '<link rel="icon" href="/i.svg">'),
    assets: {
      "https://evil.example/i.svg": asset("https://evil.example/i.svg", svg("<script>fetch('/cv')</script><rect width='64' height='64'/>"), 200, "image/svg+xml"),
      "https://evil.example/favicon.ico": asset("https://evil.example/favicon.ico", PNG),
    },
  });
  const logo = await captureCompanyLogo("https://evil.example/", "evil.example", ctx);
  expect(logo).toMatchObject({ contentType: "image/png", sourceUrl: "https://evil.example/favicon.ico" });
  expect(urls()).toEqual(["https://evil.example/i.svg", "https://evil.example/favicon.ico"]);

  const refused = scripted({
    homepage: page("https://evil.example/", '<link rel="icon" href="/i.svg">'),
    assets: { "https://evil.example/i.svg": asset("https://evil.example/i.svg", svg("", ' onload="alert(1)"')) },
  });
  const error = await captureCompanyLogo("https://evil.example/", "evil.example", refused.ctx).catch((e: unknown) => e);
  expect((error as LogoCaptureError).tried[0]).toBe("https://evil.example/i.svg: SVG refused because it has an event handler");
});

it("keeps a plain SVG logo", async () => {
  const plain = svg('<defs><linearGradient id="g"/></defs><use href="#g"/><image href="data:image/png;base64,iVBORw0KGgo="/><path d="M0 0h64v64H0z" fill="url(#g)"/>');
  expect(unsafeSvgReason(plain)).toBeNull();
  const { ctx } = scripted({
    homepage: page("https://example.com/", '<link rel="icon" href="/logo.svg">'),
    assets: { "https://example.com/logo.svg": asset("https://example.com/logo.svg", plain, 200, "image/svg+xml") },
  });
  expect(await captureCompanyLogo("https://example.com/", "example.com", ctx)).toMatchObject({ contentType: "image/svg+xml" });
});

it.each([
  ["a script element", svg("<script>alert(1)</script>"), "it contains a script"],
  ["a namespaced script", svg('<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>'), "it contains a script"],
  ["an event handler", svg('<rect onclick="alert(1)"/>'), "it has an event handler"],
  ["an event handler after a quote", svg('<rect x="0"onmouseover="alert(1)"/>'), "it has an event handler"],
  ["embedded HTML", svg("<foreignObject><iframe src='https://evil.example/'></iframe></foreignObject>"), "it embeds HTML"],
  ["HTML without a foreignObject", svg('<h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="https://evil.example/"/>'), "it embeds HTML"],
  ["a javascript: link", svg('<a href="JavaScript:alert(1)"><rect/></a>'), "it has a javascript: URL"],
  ["an entity that can expand into markup", new TextEncoder().encode('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "&#60;script&#62;">]><svg>&x;</svg>'), "it declares an entity"],
  ["an XSLT stylesheet", new TextEncoder().encode('<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="#x"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'), "it names a stylesheet"],
  ["an animated link target", svg('<a><set attributeName="href" to="&#106;avascript:alert(1)"/><rect/></a>'), "it animates a reference"],
  ["an external image", svg('<image href="https://tracker.example/pixel.png"/>'), "it refers to something outside itself"],
  ["an external xlink reference", svg("<use xlink:href='https://evil.example/sprite.svg#a'/>"), "it refers to something outside itself"],
  ["an embedded SVG", svg('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'), "it refers to something outside itself"],
])("refuses an SVG with %s", (_, bytes, reason) => {
  expect(unsafeSvgReason(bytes)).toBe(reason);
});
