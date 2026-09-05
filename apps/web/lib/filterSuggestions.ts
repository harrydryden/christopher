import type { FilterSuggestion } from "@christopher/db/schema";

/**
 * The exact shape of `filter_suggestions.value` is produced by `@christopher/ai`'s filter-suggestion
 * call site, which is still being built alongside this UI (packages/ai/src is empty as of writing).
 * Reading several plausible key names keeps this page working once that shape lands, rather than
 * guessing one name and breaking silently.
 */
export type ExtractedSuggestionValue =
  | { kind: "term"; term: string }
  | { kind: "threshold"; threshold: number }
  | { kind: "company"; companyId: string }
  | { kind: "unknown" };

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = value[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function extractSuggestionValue(s: Pick<FilterSuggestion, "type" | "value">): ExtractedSuggestionValue {
  const v = (s.value ?? {}) as Record<string, unknown>;
  switch (s.type) {
    case "keyword_include":
    case "keyword_exclude":
    case "location": {
      const term = firstString(v, ["term", "keyword", "location", "value"]);
      return term ? { kind: "term", term } : { kind: "unknown" };
    }
    case "hide_threshold": {
      const raw = v.threshold ?? v.value ?? v.hideThreshold;
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? { kind: "threshold", threshold: n } : { kind: "unknown" };
    }
    case "pause_company": {
      const id = firstString(v, ["companyId", "company_id", "id"]);
      return id ? { kind: "company", companyId: id } : { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}

export function describeEvidenceItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const title = firstString(o, ["title", "jobTitle"]);
    const company = firstString(o, ["company", "companyName"]);
    const reason = firstString(o, ["reason", "note"]);
    const parts = [title, company].filter(Boolean).join(" @ ");
    if (parts && reason) return `${parts} — ${reason}`;
    if (parts) return parts;
    if (reason) return reason;
  }
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

export function describeFilterSuggestion(s: Pick<FilterSuggestion, "type" | "value">, companyName?: string): string {
  const extracted = extractSuggestionValue(s);
  switch (s.type) {
    case "keyword_include":
      return extracted.kind === "term" ? `Add "${extracted.term}" to include keywords` : "Add an include keyword";
    case "keyword_exclude":
      return extracted.kind === "term" ? `Add "${extracted.term}" to exclude keywords` : "Add an exclude keyword";
    case "location":
      return extracted.kind === "term" ? `Add "${extracted.term}" to the location filter` : "Add a location filter term";
    case "hide_threshold":
      return extracted.kind === "threshold" ? `Set the hide threshold to ${extracted.threshold}` : "Enable the hide threshold";
    case "pause_company":
      return `Pause ${companyName ?? "a company"}`;
    default:
      return "Suggestion";
  }
}
