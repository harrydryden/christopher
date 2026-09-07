import { describe, expect, it, vi } from "vitest";
import { prepareForAdmission } from "./admission";
import { DEFAULT_GATE_SETTINGS, evaluateGate, type FetchContext } from "@christopher/core";
const source = { type: "html" as const, url: "https://example.com/jobs" };
const gate = { ...DEFAULT_GATE_SETTINGS, includeKeywords: ["strategy"], excludeKeywords: ["engineer"], matchFields: ["description" as const] };
function context(body: string, status = 200) {
  return { fetchText: vi.fn(async () => ({ body, status, url: "https://example.com/job" })) } as unknown as FetchContext;
}
describe("description admission", () => {
  it("reads descriptions before accepting or rejecting sparse postings", async () => {
    const posts = [{ title: "Director", url: "https://example.com/job", descriptionText: undefined as string | undefined }];
    const ctx = context(`<main>${"Lead strategy and operations. ".repeat(20)}</main>`);
    expect((await prepareForAdmission(posts, source, ctx, gate)).size).toBe(0);
    expect(evaluateGate({ ...posts[0]!, description: posts[0]!.descriptionText }, gate).inTable).toBe(true);
    posts[0]!.descriptionText = undefined;
    await prepareForAdmission(posts, source, context(`<main>${"Design and build products. ".repeat(25)}</main>`), gate);
    expect(evaluateGate({ ...posts[0]!, description: posts[0]!.descriptionText }, gate).inTable).toBe(false);
  });
  it("reuses a rejected fingerprint and retries after filter changes", async () => {
    const entries = new Set<string>();
    const cache = { has: (key: string) => entries.has(key), remember: (key: string) => entries.add(key) };
    const ctx = context(`<main>${"Build products. ".repeat(30)}</main>`);
    const posting = () => [{ title: 'Director', url: 'https://example.com/job' }];
    await prepareForAdmission(posting(), source, ctx, gate, cache);
    await prepareForAdmission(posting(), source, ctx, gate, cache);
    expect(ctx.fetchText).toHaveBeenCalledTimes(1);
    await prepareForAdmission(posting(), source, ctx, { ...gate, includeKeywords: ['products'] }, cache);
    expect(ctx.fetchText).toHaveBeenCalledTimes(2);
  });
  it("defers failed details without fabricating a description", async () => {
    const posts = [{ title: "Director", url: "https://example.com/job" }];
    expect(await prepareForAdmission(posts, source, context("unavailable", 503), gate)).toEqual(new Set([posts[0]!.url]));
  });
  it("does not fetch details for title-only filters or supplied descriptions", async () => {
    const ctx = context("");
    await prepareForAdmission([{ title: "Director", url: "https://example.com/job" }], source, ctx, DEFAULT_GATE_SETTINGS);
    await prepareForAdmission([{ title: "Director", url: "https://example.com/job", descriptionText: "Strategy" }], source, ctx, gate);
    expect(ctx.fetchText).not.toHaveBeenCalled();
  });
});
