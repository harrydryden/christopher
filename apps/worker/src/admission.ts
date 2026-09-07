import { ats, evaluateGate, type FetchContext, type GateSettings, type RawPosting, type SourceSpec } from "@christopher/core";
import { extractMainText } from "./handlers/description";

/** Read missing detail text before admission; rejected postings never become job records. */
export async function prepareForAdmission(postings: RawPosting[], source: SourceSpec, ctx: FetchContext, gate: GateSettings) {
  const unresolved = new Set<string>();
  if (!gate.matchFields.includes("description") || !gate.includeKeywords.length) return unresolved;
  const candidates = postings.filter(p => !p.descriptionText && evaluateGate(p, { ...gate, includeKeywords: [], matchFields: ["title", "department"] }).inTable);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      const posting = candidates[next++]!;
      try {
        let text = await ats.fetchDescriptionFor(source, posting, ctx);
        if (!text) {
          const response = await ctx.fetchText(posting.url);
          if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
          text = ats.extractJsonLdPostings(response.body, posting.url).find(p => p.descriptionText)?.descriptionText ?? extractMainText(response.body);
        }
        if (!text) throw new Error("No usable description");
        posting.descriptionText = text;
      } catch {
        unresolved.add(posting.url);
      }
    }
  }));
  return unresolved;
}
