import { expect, it, vi } from "vitest";
import { discoverCareersSources, probeUrlAsSource } from "./discover";
import { ats } from "../index";
import { createFakeFetchContext } from "../testing";
import type { DiscoveryContext } from "./types";
// The stub verifies the catalogue board only. Discovery now carries on past an
// unreachable homepage to guess an ATS slug, and a stub that approved every
// board would turn that guess into a candidate these tests never meant to test.
function context(companyName: string): DiscoveryContext {
  let calls = 0;
  return { ...createFakeFetchContext({ routes: {} }), resolveSpec: ats.specFromAnyUrl, findSpecsInText: () => [], extractFromHtml: () => [],
    verifySpec: async () => calls++ === 0 ? { ok: true, companyName, count: 2211, sample: [] } : { ok: false, error: "unknown board" } };
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
  for (const discover of [discoverCareersSources, probeUrlAsSource]) {
    const ctx = context("Waymo");
    ctx.render = vi.fn();
    const result = await discover(url, ctx);
    expect(result.outcome).toBe("resolved");
    expect(result.best?.spec.atsSlug).toBe("waymo");
    expect(result.best?.spec.apiUrl).toBe("https://boards-api.greenhouse.io/v1/boards/waymo/jobs");
    expect(result.best?.method).toBe("verified_catalogue");
    expect(result.fetches).toBe(1);
    expect(ctx.render).not.toHaveBeenCalled();
  }
});
it("falls back when Waymo's feed is unavailable or has the wrong identity", async () => {
  for (const companyName of ["Other company", "Not Waymo"]) {
    // The catalogue entry is refused on identity, so the board is never accepted
    // silently. Discovery then reaches it again as a slug guessed from the
    // domain, which is only ever offered for confirmation with the feed's real
    // name shown — the user decides, not the catalogue.
    const result = await discoverCareersSources("https://waymo.com/", context(companyName));
    expect(result.outcome).toBe("needs_confirmation");
    expect(result.best?.method).toBe("ats_guess");
    expect(result.best?.companyName).toBe(companyName);
  }
  const ctx = context("Waymo");
  ctx.verifySpec = async () => ({ ok: false, error: "Feed unavailable" });
  expect((await discoverCareersSources("https://waymo.com/", ctx)).outcome).toBe("not_found");
});
it("does not use Waymo's catalogue for a lookalike domain", async () => {
  const ctx = context("Waymo");
  ctx.verifySpec = vi.fn(async () => ({ ok: false, error: "unknown board" }));
  const result = await discoverCareersSources("https://notwaymo.com/", ctx);
  expect(result.best).toBeUndefined();
  // The only verification is the slug guessed from the domain, never the Waymo catalogue board.
  for (const call of (ctx.verifySpec as ReturnType<typeof vi.fn>).mock.calls) expect((call[0] as { atsSlug?: string }).atsSlug).not.toBe("waymo");
});
