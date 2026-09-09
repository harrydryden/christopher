import { describe, expect, it } from "vitest";
import { MODEL_CHOICES, MODEL_IDS, isKnownModel, modelLabel } from "./models";
import { DEFAULT_SETTINGS } from "./settings";

describe("model choices", () => {
  it("offers one current model per family", () => {
    expect(MODEL_IDS).toEqual(["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
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

  it("labels a supported model and falls back to the raw ID", () => {
    expect(modelLabel("claude-sonnet-5")).toBe(MODEL_CHOICES[2]!.label);
    expect(modelLabel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
});
