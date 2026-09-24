import { describe, expect, it } from "vitest";
import { describeFilterSuggestion, extractSuggestionValue } from "./filterSuggestions";

describe("reading a filter suggestion's value", () => {
  const id = "4f3c2b1a-9d8e-4c7b-a6f5-0e1d2c3b4a59";

  it("reads a pause by the company id the worker resolved it to", () => {
    expect(extractSuggestionValue({ type: "pause_company", value: { companyId: id, companyName: "Acme" } })).toEqual({ kind: "company", companyId: id });
  });

  it("reads anything that is not a company id as unknown, so no lookup is made with it", () => {
    // What the model used to be asked for, and what it might invent: neither may reach a uuid column.
    expect(extractSuggestionValue({ type: "pause_company", value: { companyName: "Acme" } })).toEqual({ kind: "unknown" });
    expect(extractSuggestionValue({ type: "pause_company", value: { id: "acme" } })).toEqual({ kind: "unknown" });
    expect(describeFilterSuggestion({ type: "pause_company", value: { id: "acme" } })).toBe("Pause a company");
  });

  it("reads a term the scans filed beside its source", () => {
    expect(extractSuggestionValue({ type: "keyword_include", value: { term: "strateg*", source: "scans" } })).toEqual({ kind: "term", term: "strateg*" });
  });
});
