// @vitest-environment jsdom
/**
 * The vitals beacon, in a browser: one load in four reports, once, on hide, with the seven keys the
 * route accepts and nothing that names an account, a record or a query.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Metric } from "web-vitals";

const callbacks = vi.hoisted(() => new Map<string, (metric: Metric) => void>());
vi.mock("web-vitals", () => ({
  onLCP: (cb: (m: Metric) => void) => callbacks.set("LCP", cb),
  onINP: (cb: (m: Metric) => void) => callbacks.set("INP", cb),
  onCLS: (cb: (m: Metric) => void) => callbacks.set("CLS", cb),
  onTTFB: (cb: (m: Metric) => void) => callbacks.set("TTFB", cb),
  onFCP: (cb: (m: Metric) => void) => callbacks.set("FCP", cb),
}));

import { resetVitalsForTests, startVitals } from "./NavigationMetrics";
import { readVitalsBeacon } from "@/lib/web-vitals";

const beacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
let visibility: DocumentVisibilityState = "visible";

const metric = (name: Metric["name"], value: number, rating: Metric["rating"] = "good") =>
  ({ name, value, rating, delta: value, id: `v5-${name}-1234`, entries: [], navigationType: "navigate", navigationId: 1 }) as unknown as Metric;

function hide() {
  visibility = "hidden";
  window.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  resetVitalsForTests();
  callbacks.clear();
  beacon.mockClear();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
  Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 8 });
  window.history.replaceState(null, "", `/companies/${crypto.randomUUID()}?view=auto-matched`);
});
afterEach(() => vi.restoreAllMocks());

it("watches nothing, loads nothing and sends nothing on the three loads in four that are not sampled", async () => {
  expect(await startVitals(() => 0.25)).toBe(false);
  expect(callbacks.size).toBe(0);
  hide();
  expect(beacon).not.toHaveBeenCalled();
});

it("sends a sampled load's metrics in one beacon on hide, with the landing route and no identifiers", async () => {
  expect(await startVitals(() => 0.1)).toBe(true);
  expect([...callbacks.keys()].sort()).toEqual(["CLS", "FCP", "INP", "LCP", "TTFB"]);
  callbacks.get("TTFB")!(metric("TTFB", 180));
  callbacks.get("LCP")!(metric("LCP", 1_900));
  callbacks.get("CLS")!(metric("CLS", 0.02));
  hide();
  expect(beacon).toHaveBeenCalledTimes(1);
  const [url, body] = beacon.mock.calls[0]!;
  expect(url).toBe("/api/performance");
  const sent = JSON.parse(String(body)) as Array<Record<string, unknown>>;
  expect(sent).toEqual([
    { route: "/companies/:id", metric: "TTFB", value: 180, rating: "good", navType: "navigate", deviceClass: "high", effectiveType: "unknown" },
    { route: "/companies/:id", metric: "LCP", value: 1_900, rating: "good", navType: "navigate", deviceClass: "high", effectiveType: "unknown" },
    { route: "/companies/:id", metric: "CLS", value: 0.02, rating: "good", navType: "navigate", deviceClass: "high", effectiveType: "unknown" },
  ]);
  // What the route accepts, exactly: the metric's id and the query string never leave the browser.
  expect(readVitalsBeacon(String(body))).not.toBeNull();
  expect(String(body)).not.toMatch(/v5-|view=|[0-9a-f]{8}-[0-9a-f]{4}/);
});

it("sends each metric once per load, however often the tab is hidden, and only what arrived since", async () => {
  await startVitals(() => 0);
  callbacks.get("LCP")!(metric("LCP", 1_000));
  hide();
  visibility = "visible";
  callbacks.get("LCP")!(metric("LCP", 1_500));
  callbacks.get("INP")!(metric("INP", 240, "needs-improvement"));
  hide();
  expect(beacon).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(beacon.mock.calls[1]![1])).map((r: { metric: string }) => r.metric)).toEqual(["INP"]);
  hide();
  expect(beacon).toHaveBeenCalledTimes(2);
});

it("leaves Lighthouse and headless browsers out of the field data", async () => {
  for (const agent of ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36 Chrome-Lighthouse", "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/139.0.0.0 Safari/537.36"]) {
    resetVitalsForTests();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    expect(await startVitals(() => 0)).toBe(false);
  }
  expect(callbacks.size).toBe(0);
});

it("decides once per load: a second start does nothing", async () => {
  expect(await startVitals(() => 0)).toBe(true);
  expect(await startVitals(() => 0)).toBe(false);
});
