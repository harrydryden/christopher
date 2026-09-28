import { describe, expect, it } from "vitest";
import { MODEL_IDS, isKnownModel } from "./models";
import { DEFAULT_SETTINGS } from "./settings";

describe("model choices", () => {
  it("offers the current model of each family, keeping one superseded choice beside its successor for now", () => {
    expect(MODEL_IDS).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
    expect(new Set(MODEL_IDS).size).toBe(MODEL_IDS.length);
  });

  it("accepts supported IDs and rejects everything else", () => {
    for (const id of MODEL_IDS) expect(isKnownModel(id)).toBe(true);
    expect(isKnownModel("")).toBe(false);
    expect(isKnownModel("gpt-4")).toBe(false);
    // A superseded model is priced but no longer offered.
    expect(isKnownModel("claude-opus-4-8")).toBe(false);
  });

  it("rejects a dotted version, which the old regex allowed and which fails at call time", () => {
    expect(isKnownModel("claude-fable-5.1")).toBe(false);
    expect(isKnownModel("claude-fable-5-1")).toBe(true);
  });

  it("keeps the shipped defaults inside the supported list", () => {
    expect(isKnownModel(DEFAULT_SETTINGS.defaultModel)).toBe(true);
    expect(isKnownModel(DEFAULT_SETTINGS.cvModel)).toBe(true);
  });
});
