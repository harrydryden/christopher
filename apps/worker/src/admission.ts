import { ats, evaluateGate, type FetchContext, type GateSettings, type RawPosting, type SourceSpec } from "@christopher/core";
import { admissionKey } from "./admission-cache";
import { extractMainText } from "./handlers/description";

/** Read missing detail text before admission; rejected postings never become job records. */
export async function prepareForAdmission(postings: RawPosting[], source: SourceSpec, ctx: FetchContext, gate: GateSettings, cache?: { has(key: string): boolean; remember(key: string): unknown }) {
  const unresolved = new Set<string>();
  if (!gate.matchFields.includes("description") || !gate.includeKeywords.length) return unresolved;
  const candidates = postings.filter(p => !p.descriptionText && evaluateGate(p, { ...gate, includeKeywords: [], matchFields: ["title", "department"] }).inTable);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      const posting = candidates[next++]!;
      const key = admissionKey(posting, gate);
      if (cache?.has(key)) continue;
      try {
        let text = await ats.fetchDescriptionFor(source, posting, ctx);
        if (!text) {
          const response = await ctx.fetchText(posting.url);
          if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
          text = ats.extractJsonLdPostings(response.body, posting.url).find(p => p.descriptionText)?.descriptionText ?? extractMainText(response.body);
        }
        if (!text) throw new Error("No usable description");
        posting.descriptionText = text;
        if (!evaluateGate({ ...posting, description: text }, gate).inTable) cache?.remember(key);
      } catch {
        unresolved.add(posting.url);
      }
    }
  }));
  return unresolved;
}
