import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CV_PROMPT_IDS, PROMPTS, PROMPT_IDS, assertCacheLayout, cvCallSiteTable, layoutFor, promptSetVersion, promptVersion, resolveRoute, routedModel,
} from "./prompt-registry";
import { createAiEngine, type AiCallMeta, type AiUsageRecord } from "./engine";

describe("the prompt registry", () => {
  it("names every entry by its own key, with a short version hash of its prompt", () => {
    for (const id of PROMPT_IDS) {
      expect(PROMPTS[id].id).toBe(id);
      expect(PROMPTS[id].version).toMatch(/^[0-9a-f]{10}$/);
      expect(PROMPTS[id].effort).toBe(PROMPTS[id].route.effort);
    }
    expect(promptSetVersion()).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes the version when the prompt text or its schema changes, and only then", () => {
    const schema = z.object({ a: z.string() });
    expect(promptVersion("Do the thing.", schema)).toBe(promptVersion("Do the thing.", schema));
    expect(promptVersion("Do the thing!", schema)).not.toBe(promptVersion("Do the thing.", schema));
    expect(promptVersion("Do the thing.", z.object({ a: z.number() }))).not.toBe(promptVersion("Do the thing.", schema));
  });

  it("gives the same prompt the same version, so a re-audit and an improvement are the prompts they reuse", () => {
    expect(PROMPTS["cv.review_candidate"].version).toBe(PROMPTS["cv.review"].version);
    expect(PROMPTS["cv.improvement"].version).toBe(PROMPTS["cv.author"].version);
    expect(new Set(CV_PROMPT_IDS.map(id => PROMPTS[id].stage))).toEqual(new Set(["rubric", "planning", "author", "improvement", "review", "review_candidate"]));
  });

  it("refuses a layout the provider would refuse", () => {
    expect(() => assertCacheLayout("x", { system: "5m", stable: ["1h"] })).toThrow(/may not follow/);
    expect(() => assertCacheLayout("x", { system: null, stable: ["1h", "5m", null] })).not.toThrow();
    expect(() => assertCacheLayout("x", { system: "1h", stable: ["1h", "1h", "5m", "5m"] })).toThrow(/at most four/);
  });

  it("builds [system][stable…][tail] with a breakpoint exactly where the entry declares one", () => {
    const { system, content } = layoutFor(PROMPTS.A5, { stable: ["account"], tail: "role" });
    expect(system).toEqual([{ type: "text", text: PROMPTS.A5.system, cache_control: { type: "ephemeral" } }]);
    expect(content).toEqual([{ type: "text", text: "account", cache_control: { type: "ephemeral" } }, { type: "text", text: "role" }]);
    expect(layoutFor(PROMPTS.A1, { tail: "links" }).content).toBe("links");
    expect(() => layoutFor(PROMPTS.A5, { tail: "role" })).toThrow(/declares 1 stable block/);
  });

  it("routes by the administrator's override where there is one, and by the entry otherwise", () => {
    expect(resolveRoute(PROMPTS["cv.review"])).toEqual({ model: "cvModel", effort: "high" });
    expect(resolveRoute(PROMPTS["cv.review"], { "cv.review": { effort: "medium" } })).toEqual({ model: "cvModel", effort: "medium" });
    expect(resolveRoute(PROMPTS["cv.review"], { "cv.review": { model: "claude-sonnet-5" } })).toEqual({ model: "claude-sonnet-5", effort: "high" });
    // An effort the provider does not know is ignored rather than sent.
    expect(resolveRoute(PROMPTS.A1, { A1: { effort: "extreme" as never } }).effort).toBe("low");
    expect(routedModel({ model: "cvModel", effort: "high" }, { cvModel: "claude-fable-5-1", callSite: "claude-sonnet-5" }, "x")).toBe("claude-fable-5-1");
    expect(routedModel({ model: "callSite", effort: "low" }, { cvModel: "claude-fable-5-1", callSite: "claude-sonnet-5" }, "x")).toBe("claude-sonnet-5");
    expect(routedModel({ model: "claude-haiku-4-5", effort: "low" }, { cvModel: "claude-fable-5-1" }, "x")).toBe("claude-haiku-4-5");
  });
});

describe("the engine and the registry", () => {
  it("names the entry beside every request, and records it on every row", async () => {
    const seen: Array<AiCallMeta | undefined> = [];
    const usage: AiUsageRecord[] = [];
    const engine = createAiEngine({
      getModel: () => "claude-opus-5",
      onUsage: record => { usage.push(record); },
      client: { messages: { create: async (_params, _options, call) => {
        seen.push(call);
        return { parsed_output: { score: 50, verdict: "possible", rationale: "ok", flags: [] }, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" };
      } } },
    });
    await engine.scoreJob({ profileMarkdown: "", decisionDigest: "", job: { title: "Ops", company: "Acme" } });
    expect(seen).toEqual([{ promptId: "A5", promptVersion: PROMPTS.A5.version }]);
    expect(usage[0]).toMatchObject({ callSite: "A5", promptId: "A5", promptVersion: PROMPTS.A5.version });
    expect(usage[0]!.stage).toBeUndefined();
  });
});

/**
 * SPEC §4's table of CV call sites is generated from the registry. Run with UPDATE_SPEC=1 to
 * rewrite it after changing an entry; otherwise a drift fails here.
 */
describe("the spec", () => {
  const spec = fileURLToPath(new URL("../../../docs/SPEC.md", import.meta.url));
  const START = "<!-- cv-call-sites:start (generated by packages/ai/src/prompt-registry.test.ts; UPDATE_SPEC=1 to rewrite) -->";
  const END = "<!-- cv-call-sites:end -->";

  it("lists the CV call sites exactly as the registry defines them", () => {
    const text = readFileSync(spec, "utf8");
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    expect(start, "SPEC.md has lost its generated CV call-site table markers").toBeGreaterThan(-1);
    const current = text.slice(start + START.length, end).trim();
    const expected = cvCallSiteTable();
    if (process.env.UPDATE_SPEC === "1" && current !== expected) {
      writeFileSync(spec, `${text.slice(0, start + START.length)}\n${expected}\n${text.slice(end)}`);
      return;
    }
    expect(current).toBe(expected);
  });
});
