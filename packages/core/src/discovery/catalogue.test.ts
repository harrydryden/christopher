import { expect, it } from "vitest";
import { discoverCareersSources } from "./discover";
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
