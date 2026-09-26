import { describe, expect, it } from "vitest";
import { cvTailoringEvidence, groupCvLibrary, type CvLibrary } from "@ava/core";
import { cvEvidenceItems } from "@ava/core/cv-assessment";
import { createAiEngine, type AiClientLike, type AiUsageRecord, type ParseResponse } from "./engine";
import { canonicalEvidence, canonicalEvidenceBlock, canonicalEvidenceItems, evidenceBlockId } from "./evidence";
import { estimateCostUsd } from "./pricing";

type Block = { type: string; text: string; cache_control?: { type: string; ttl?: string } };

function capture(answer: unknown, usage: ParseResponse["usage"] = { input_tokens: 10, output_tokens: 5 }) {
  const calls: Array<Record<string, unknown>> = [];
  const client: AiClientLike = { messages: { create: async params => {
    calls.push(params);
    return { parsed_output: answer, usage, stop_reason: "end_turn", model: params.model as string };
  } } };
  return { client, calls };
}
const blocksOf = (params: Record<string, unknown>) => (params.messages as Array<{ content: Block[] }>)[0]!.content;
const systemOf = (params: Record<string, unknown>) => params.system as Block[];

const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} delivered outcome number ${i} across three regions, saving £${i}00k.`);
const library: CvLibrary = groupCvLibrary({
  name: "Candidate", contact: "London", profile: "Operations leader with a record of delivery.",
  stylePreferences: "Plain British English.", preferredWording: "Kept wording.",
  employment: [
    { id: "job1", company: "Acme", jobTitle: "Director", startDate: "2020-01", endDate: "", current: true, industryDescriptions: "Logistics" },
    { id: "job2", company: "Beta", jobTitle: "Manager", startDate: "2015-01", endDate: "2019-12", current: false, industryDescriptions: "Retail" },
  ],
  entries: [
    { id: "e1", kind: "experience", heading: "Director", employmentId: "job1", details: rows("Acme", 6).join("\n"), confirmedResponsibilities: rows("Acme", 6),
      rowFacets: { [rows("Acme", 6)[0]!]: ["outcome", "metric"] } },
    { id: "e2", kind: "experience", heading: "Manager", employmentId: "job2", details: rows("Beta", 4).join("\n"), confirmedResponsibilities: rows("Beta", 4) },
    { id: "ed", kind: "education", heading: "MSc Operations", details: "MSc Operations Management, Distinction, 2012." },
    { id: "sk", kind: "skill", heading: "Tools", details: "Reporting and analysis tools", skillItems: ["SQL", "Power BI", "Lean"] },
    { id: "old", kind: "interest", status: "inactive", heading: "Old", details: "An archived interest that is not evidence." },
  ],
});
const plan = { summary: "Operations leader", sections: [{ entryId: "e1", bullets: ["Led"] }], gaps: [] };

describe("canonical evidence", () => {
  it("writes every citable row once, under its entry, with the ids the validators accept", () => {
    const evidence = canonicalEvidence(library);
    const flat = cvTailoringEvidence(library);
    const ids = [evidence.profile!.id, ...evidence.entries.flatMap(entry => [...entry.rows, ...(entry.skillItems ?? [])].map(row => row.id))];
    expect(ids.sort()).toEqual(flat.map(item => item.id).sort());
    expect(evidence.entries.map(entry => entry.id)).not.toContain("old");
    const acme = evidence.entries.find(entry => entry.id === "e1")!;
    expect(acme.sourceId).toBe("entry:e1");
    expect(acme.employment).toMatchObject({ company: "Acme", industryDescriptions: "Logistics" });
    expect(acme.rows[0]).toEqual({ id: "entry:e1:row:0", text: rows("Acme", 6)[0], facets: ["outcome", "metric"] });
    expect(acme.rows[1]!.facets).toBeUndefined();
    expect(evidence.entries.find(entry => entry.id === "sk")!.skillItems!.map(item => item.text)).toEqual(["SQL", "Power BI", "Lean"]);
    // Deterministic, so a block built from it is byte-identical between calls.
    expect(canonicalEvidenceBlock(library)).toBe(canonicalEvidenceBlock(structuredClone(library)));
    // No preferences, appearance or identity: those are not evidence.
    for (const text of ["Plain British English", "Kept wording", "Candidate", "London"]) expect(canonicalEvidenceBlock(library)).not.toContain(text);
  });

  it("reads back as the audit's whole-block sources, and names a row's block", () => {
    const items = canonicalEvidenceItems(canonicalEvidence(library));
    const stored = cvEvidenceItems(library).filter(item => item.id !== "entry:old");
    expect(items.map(item => item.id)).toEqual(stored.map(item => item.id));
    for (const row of rows("Acme", 6)) expect(items.find(item => item.id === "entry:e1")!.text).toContain(row);
    expect(evidenceBlockId("entry:e1:row:3")).toBe("entry:e1");
    expect(evidenceBlockId("entry:a:b:skill:0")).toBe("entry:a:b");
    expect(evidenceBlockId("source:profile")).toBe("source:profile");
    expect(evidenceBlockId("e1", new Set(["e1"]))).toBe("entry:e1");
    expect(evidenceBlockId("e1")).toBe("e1");
  });
});

describe("the writer's user turn", () => {
  it("sends each evidence row exactly once: the library, then the role, both cached for an hour, then the volatile tail", async () => {
    const { client, calls } = capture(plan);
    const engine = createAiEngine({ client, getModel: () => "claude-fable-5-1" });
    const tailoringPlan = { requirements: [{ requirementId: "r1", status: "demonstrated" as const, evidence: [{ sourceId: "entry:e1:row:0", quote: "Acme delivered" }], reason: "Direct." }], gapQuestions: [] };
    await engine.buildCv({ library, jobTitle: "Head of Operations", company: "Meridian", description: "Lead operations.",
      tailoringPlan, writingBudget: { summaryCharacters: 300, blocks: [] } as never, improvements: ["Add the supplier evidence."] }).catch(() => null);
    const blocks = blocksOf(calls[0]!);
    const user = blocks.map(block => block.text).join("");
    for (const item of cvTailoringEvidence(library).filter(item => item.id.includes(":row:")))
      expect(user.split(JSON.stringify(item.text)).length - 1, item.id).toBe(1);
    expect(user).not.toContain("tailoringEvidence");
    expect(user).not.toContain("confirmedResponsibilities");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[2]!.cache_control).toBeUndefined();
    expect(Object.keys(JSON.parse(blocks[0]!.text))).toEqual(["library"]);
    expect(JSON.parse(blocks[0]!.text).library).toMatchObject({ stylePreferences: "Plain British English.", preferredWording: "Kept wording." });
    expect(Object.keys(JSON.parse(blocks[1]!.text))).toEqual(["jobTitle", "company", "description", "maxPages", "tailoringPlan"]);
    expect(Object.keys(JSON.parse(blocks[2]!.text))).toEqual(["writingBudget", "improvements"]);
    // No marker on the system prompt: a five-minute one may not precede the hour-long library.
    expect(systemOf(calls[0]!)[0]!.cache_control).toBeUndefined();
  });

  it("sends the same library and role bytes on every call of a build, so a rewrite reads them from the cache", async () => {
    const { client, calls } = capture(plan);
    const engine = createAiEngine({ client, getModel: () => "claude-fable-5-1" });
    const base = { library, jobTitle: "Head of Operations", company: "Meridian", description: "Lead operations." };
    await engine.buildCv({ ...base, writingBudget: { summaryCharacters: 300, blocks: [] } as never });
    await engine.buildCv({ ...base, writingBudget: { summaryCharacters: 200, blocks: [] } as never,
      layoutFeedback: { pageCount: 3, maxPages: 2, previousPlan: plan as never } });
    const [first, second] = calls.map(blocksOf);
    expect(second![0]!.text).toBe(first![0]!.text);
    expect(second![1]!.text).toBe(first![1]!.text);
    expect(second![2]!.text).not.toBe(first![2]!.text);
  });
});

describe("the audit's cache layout", () => {
  const input = {
    rubric: { requirements: [{ id: "r1", label: "Operations", quote: "Lead operations", importance: "essential" as const, category: "experience" as const }], caveats: [] },
    cv: [{ id: "profile", text: "Operations leader" }],
    claims: [{ id: "section:e1:0", text: rows("Acme", 6)[0]!, requiredEvidenceId: "entry:e1" }],
    evidence: cvEvidenceItems(library),
  };
  const answer = (libraryId: string, claimId: string) => ({
    matches: [{ requirementId: "r1", status: "demonstrated", libraryStatus: "demonstrated", cvEvidence: [{ id: "profile", quote: "Operations leader" }],
      libraryEvidence: [{ id: libraryId, quote: rows("Acme", 6)[1] }], reason: "Supported", improvement: "" }],
    claims: [{ claimId: "section:e1:0", status: "supported", evidence: [{ id: claimId, quote: rows("Acme", 6)[0] }], reason: "Supported" }],
  });

  it("caches the evidence for an hour ahead of the five-minute CV, with no system marker", async () => {
    const { client, calls } = capture(answer("entry:e1", "entry:e1"));
    const engine = createAiEngine({ client, getModel: () => "claude-fable-5-1" });
    expect(await engine.assessCv(input)).toBeTruthy();
    const blocks = blocksOf(calls[0]!);
    expect(blocks.map(block => block.cache_control ?? null)).toEqual([{ type: "ephemeral", ttl: "1h" }, { type: "ephemeral" }, null]);
    expect(systemOf(calls[0]!)[0]!.cache_control).toBeUndefined();
  });

  it("reads the canonical evidence when given the library, and counts a row cited by its own id as its block's", async () => {
    const { client, calls } = capture(answer("entry:e1:row:1", "entry:e1:row:0"));
    const engine = createAiEngine({ client, getModel: () => "claude-fable-5-1" });
    const review = await engine.assessCv({ ...input, library });
    expect(JSON.parse(blocksOf(calls[0]!)[0]!.text).evidence).toEqual(canonicalEvidence(library));
    // One call: nothing to correct, so the citations stood.
    expect(calls).toHaveLength(1);
    expect(review!.claims[0]).toMatchObject({ status: "supported", evidence: [{ id: "entry:e1" }] });
    expect(review!.matches[0]!.libraryEvidence).toEqual([{ id: "entry:e1", quote: rows("Acme", 6)[1] }]);
  });
});

describe("hour-long cache writes", () => {
  it("records the hour-long part of a call's writes and prices it at twice input", async () => {
    const usage: AiUsageRecord[] = [];
    const { client } = capture({ requirements: [{ id: "r1", label: "Ops", quote: "Lead operations", importance: "essential", category: "experience" }], caveats: [] }, {
      input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10_000, cache_creation: { ephemeral_1h_input_tokens: 8_000, ephemeral_5m_input_tokens: 2_000 },
    });
    const engine = createAiEngine({ client, getModel: () => "claude-fable-5-1", onUsage: record => { usage.push(record); } });
    await engine.analyseCvJob("Lead operations");
    expect(usage[0]).toMatchObject({ cacheWriteTokens: 10_000, cacheWrite1hTokens: 8_000 });
    expect(usage[0]!.costUsd).toBeCloseTo(estimateCostUsd("claude-fable-5-1", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 10_000, cacheWrite1hTokens: 8_000 }), 6);
    expect(usage[0]!.costUsd).toBeGreaterThan(estimateCostUsd("claude-fable-5-1", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 10_000 }));
  });
});
