import { expect, it } from "vitest";
import { cvInlineSelection, validateCvInlineProposal, type CvInlineInput } from "./cv-inline-ai";

it("uses the selected Unicode span, rejects broken offsets and never truncates a long selection", () => {
  expect(cvInlineSelection("I built 🚀 tools", 2, 10)).toEqual({ start: 2, end: 10, selected: "built 🚀" });
  expect(() => cvInlineSelection("🚀 tools", 1, 4)).toThrow("complete characters");
  expect(() => cvInlineSelection("abc", 3, 2)).toThrow("Select the words");
  expect(() => cvInlineSelection("x".repeat(4001))).toThrow("4,000");
  expect(cvInlineSelection("Whole field", 3, 3).selected).toBe("Whole field");
});

it("checks replacement size against the whole field and rejects new numbers before semantic verification", () => {
  const input = { request: { text: "Before. Cut costs 20%. Afterwards.", target: { type: "bullet", field: "text" } },
    selection: { start: 8, end: 21, selected: "Cut costs 20%" }, maxFieldLength: 50 } as CvInlineInput;
  expect(validateCvInlineProposal(input, { text: "Reduced costs 20%" })).toBe("Reduced costs 20%");
  expect(validateCvInlineProposal(input, { text: "Reduced costs 30%" })).toBeNull();
  expect(validateCvInlineProposal(input, { text: "x".repeat(40) })).toBeNull();
  expect(validateCvInlineProposal(input, { text: "\u0000" })).toBeNull();
  expect(validateCvInlineProposal(input, { text: "OK", unrelated: "changed section" })).toBeNull();
});
