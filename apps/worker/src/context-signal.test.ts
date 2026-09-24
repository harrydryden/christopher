import { describe, expect, it } from "vitest";
import type { FetchInit, FetchResponse, RenderedPage } from "@ava/core";
import type { Ref } from "@ava/ai";
import { makeDiscoveryContext, makeFetchContext, type WorkerDeps } from "./context";

/**
 * A run's signal reaching what a handler does outside the model: its fetches and renders.
 *
 * The queue aborts the signal when a run outruns its deadline or loses its lease; a handler that
 * builds its fetch context with it stops starting new requests and stops waiting on one in flight.
 */
function depsWith(fetchText: (url: string, init?: FetchInit) => Promise<FetchResponse>, render?: (url: string, opts?: object) => Promise<RenderedPage>) {
  const asked: Ref[] = [];
  const deps = {
    fetcher: { fetchText, fetchBytes: async () => ({ status: 200, url: "", headers: {}, bytes: new Uint8Array() }) },
    browser: render ? { render } : null,
    now: () => new Date("2026-09-23T12:00:00Z"),
    ai: {
      enabled: true,
      chooseCareersLinks: async (_input: unknown, ref: Ref) => { asked.push(ref); return []; },
      classifyPage: async (_input: unknown, ref: Ref) => { asked.push(ref); return null; },
    },
  } as unknown as WorkerDeps;
  return { deps, asked };
}

const page = (url: string): FetchResponse => ({ status: 200, url, headers: {}, body: "<html></html>" });
const lease = () => Object.assign(new Error("Task lease lost; another worker holds it"), { name: "LeaseLostError" });

describe("the fetch context under a run's signal", () => {
  it("hands the signal to every fetch and render", async () => {
    const seen: Array<FetchInit | object | undefined> = [];
    const stop = new AbortController();
    const { deps } = depsWith(
      async (url, init) => { seen.push(init); return page(url); },
      async (url, opts) => { seen.push(opts); return { html: "", finalUrl: url, requests: [], status: 200 }; },
    );
    const ctx = makeFetchContext(deps, { signal: stop.signal });
    await ctx.fetchText("https://acme.example/careers", { timeoutMs: 5_000 });
    await ctx.render!("https://acme.example/careers", { scrollAndExpand: true });
    expect(seen[0]).toEqual({ timeoutMs: 5_000, signal: stop.signal });
    expect(seen[1]).toEqual({ scrollAndExpand: true, signal: stop.signal });
  });

  it("takes the run's signal from the deps the queue handed the task", async () => {
    const seen: Array<FetchInit | undefined> = [];
    const run = new AbortController();
    const { deps } = depsWith(async (url, init) => { seen.push(init); return page(url); });
    const runDeps = { ...deps, signal: run.signal } as WorkerDeps;
    await makeFetchContext(runDeps).fetchText("https://acme.example/careers");
    expect(seen[0]).toEqual({ signal: run.signal });
    run.abort(lease());
    await expect(makeFetchContext(runDeps).fetchText("https://acme.example/careers")).rejects.toThrow("Task lease lost");
    await expect(makeDiscoveryContext(runDeps).fetchText("https://acme.example/careers")).rejects.toThrow("Task lease lost");
  });

  it("starts nothing once the run has been stopped", async () => {
    let fetched = 0;
    const stop = new AbortController();
    stop.abort(lease());
    const { deps } = depsWith(async url => { fetched++; return page(url); });
    await expect(makeFetchContext(deps, { signal: stop.signal }).fetchText("https://acme.example/careers")).rejects.toThrow("Task lease lost");
    expect(fetched).toBe(0);
  });

  it("stops waiting on a request in flight the moment the run is stopped", async () => {
    const stop = new AbortController();
    // A host that never answers, and a fetcher that does not yet listen to the signal itself.
    const { deps } = depsWith(() => new Promise(() => {}));
    const pending = makeFetchContext(deps, { signal: stop.signal }).fetchText("https://slow.example/careers");
    await new Promise(resolve => setTimeout(resolve, 5));
    stop.abort(lease());
    await expect(pending).rejects.toThrow("Task lease lost");
  });

  it("keeps a request's own signal, and passes none when there is none", async () => {
    const seen: Array<FetchInit | undefined> = [];
    const { deps } = depsWith(async (url, init) => { seen.push(init); return page(url); });
    expect((await makeFetchContext(deps).fetchText("https://acme.example/careers")).status).toBe(200);
    const own = new AbortController();
    await makeFetchContext(deps, { signal: new AbortController().signal }).fetchText("https://acme.example/careers", { signal: own.signal });
    expect(seen).toEqual([{ signal: undefined }, { signal: own.signal }]);
  });
});

describe("discovery's model calls", () => {
  it("carry the account and the run's signal in the ref, so the account's budget holds them", async () => {
    const stop = new AbortController();
    const { deps, asked } = depsWith(async url => page(url));
    const ctx = makeDiscoveryContext(deps, { userId: "user-1", signal: stop.signal });
    await ctx.ai!.chooseCareersLinks!({ companyName: "Acme", homepageUrl: "https://acme.example", links: [] });
    await ctx.ai!.classifyPage!({ url: "https://acme.example/careers", text: "", links: [] });
    expect(asked).toEqual([{ userId: "user-1", signal: stop.signal }, { userId: "user-1", signal: stop.signal }]);
  });

  it("carry the ref discovery hands each hook, laid over the run's own", async () => {
    const stop = new AbortController();
    const { deps, asked } = depsWith(async url => page(url));
    const ctx = makeDiscoveryContext(deps, { signal: stop.signal });
    const aiRef = { refType: "company", refId: "company-1", userId: "user-2" };
    await ctx.ai!.chooseCareersLinks!({ companyName: "Acme", homepageUrl: "https://acme.example", links: [] }, aiRef);
    await ctx.ai!.classifyPage!({ url: "https://acme.example/careers", text: "", links: [] }, aiRef);
    expect(asked).toEqual([{ ...aiRef, signal: stop.signal }, { ...aiRef, signal: stop.signal }]);
  });

  it("carry nothing for the shared catalogue, which stays under the deployment's caps", async () => {
    const { deps, asked } = depsWith(async url => page(url));
    await makeDiscoveryContext(deps).ai!.chooseCareersLinks!({ companyName: "Acme", homepageUrl: "https://acme.example", links: [] });
    expect(asked).toEqual([{}]);
  });
});
