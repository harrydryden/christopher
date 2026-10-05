import { expect, it, vi } from "vitest";
import { SourceFetchError, type FetchContext } from "@col/core";
import { guardedDiscoveryFetchContext } from "./discovery-host-guard";

it("reports an explicit challenge before an adapter can swallow its fetch error", async () => {
  const error = new SourceFetchError("challenge", "blocked", 403, "final.test");
  const underlying = vi.fn(async () => { throw error; });
  const context: FetchContext = { fetchText: underlying };
  const seen: Array<[unknown, string]> = [];
  const guarded = guardedDiscoveryFetchContext(context, () => {}, (caught, url) => seen.push([caught, url]));
  const adapter = async () => {
    try { await guarded.fetchText("https://start.test/jobs"); }
    catch { return { ok: false }; }
    return { ok: true };
  };
  expect(await adapter()).toEqual({ ok: false });
  expect(seen).toEqual([[error, "https://start.test/jobs"]]);
});

it("carries the guard into a verification redirect and preserves an existing guard", async () => {
  const calls: string[] = [];
  const context: FetchContext = {
    fetchText: async (_url, init) => {
      await init?.allowHost?.("challenged.test");
      calls.push("network");
      return { status: 200, url: "https://challenged.test/jobs", headers: {}, body: "" };
    },
  };
  const guarded = guardedDiscoveryFetchContext(context, host => {
    calls.push(`run:${host}`);
    if (host === "challenged.test") throw new Error("suppressed");
  });
  await expect(guarded.fetchText("https://other.test/jobs", { allowHost: host => { calls.push(`prior:${host}`); } })).rejects.toThrow("suppressed");
  expect(calls).toEqual(["run:challenged.test"]);
});
