import { expect, it, vi } from "vitest";
import { discoverCareersSources, probeUrlAsSource } from "./discover";
import { ats } from "../index";
import { createFakeFetchContext } from "../testing";
import type { DiscoveryContext } from "./types";
function context(companyName: string): DiscoveryContext {
  return { ...createFakeFetchContext({ routes: {} }), resolveSpec: ats.specFromAnyUrl, findSpecsInText: () => [], extractFromHtml: () => [],
    verifySpec: async () => ({ ok: true, companyName, count: 2211, sample: [] }) };
}
it("resolves Anduril's verified board without a slow homepage crawl", async () => {
  const result = await discoverCareersSources("https://www.anduril.com", context("Anduril Industries"));
  expect(result.outcome).toBe("resolved"); expect(result.best?.spec.atsSlug).toBe("andurilindustries"); expect(result.fetches).toBe(1);
});
it("rejects a catalogue board with a different company identity", async () => {
  const result = await discoverCareersSources("https://anduril.com", context("Some Other Company"));
  expect(result.outcome).toBe("not_found");
});

it.each(["https://waymo.com/", "https://www.waymo.com/", "https://careers.withwaymo.com/jobs/search"])("resolves %s through the verified feed without rendering", async (url) => {
  const ctx = context("Waymo");
  ctx.render = vi.fn();
  for (const discover of [discoverCareersSources, probeUrlAsSource]) {
    const result = await discover(url, ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.atsSlug).toBe("waymo");
    expect(result.best?.spec.apiUrl).toContain("content=true");
    expect(result.best?.method).toBe("verified_catalogue");
    expect(result.fetches).toBe(1);
  }
  expect(ctx.render).not.toHaveBeenCalled();
});
it("falls back when Waymo's feed is unavailable or has the wrong identity", async () => {
  for (const companyName of ["Other company", "Not Waymo"]) {
    const result = await discoverCareersSources("https://waymo.com/", context(companyName));
    expect(result.outcome).toBe("not_found");
  }
  const ctx = context("Waymo");
  ctx.verifySpec = async () => ({ ok: false, error: "Feed unavailable" });
  expect((await discoverCareersSources("https://waymo.com/", ctx)).outcome).toBe("not_found");
});
it("does not use Waymo's catalogue for a lookalike domain", async () => {
  const ctx = context("Waymo");
  ctx.verifySpec = vi.fn(ctx.verifySpec);
  const result = await discoverCareersSources("https://notwaymo.com/", ctx);
  expect(result.best).toBeUndefined();
  expect(ctx.verifySpec).not.toHaveBeenCalled();
});
