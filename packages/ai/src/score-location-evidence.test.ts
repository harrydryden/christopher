import { expect, it } from "vitest";
import { SCORE_LOCATION_EVIDENCE_BYTES, scoreLocationEvidence } from "./score-location-evidence";
import { wrap } from "./prompts";

const large = (prefix = "A") => Array.from({ length: 999 }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}-${"x".repeat(188)}`);

it("keeps an ordinary 70-place list complete", () => {
  const names = Array.from({ length: 70 }, (_, i) => `City ${i}, United Kingdom`);
  const evidence = scoreLocationEvidence(names, ["Boston"]);
  expect(evidence).toContain("complete; total: 70; included: 70; omitted: 0");
  expect(evidence).toContain(names.at(-1));
  expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(SCORE_LOCATION_EVIDENCE_BYTES);
});

it("finds a relevant last place before bounding a thousand ASCII and CJK names", () => {
  for (const filler of [large(), Array.from({ length: 999 }, (_, i) => `${"京".repeat(195)}${String(i).padStart(4, "0")}`)]) {
    const names = [...filler, "Boston, Massachusetts"];
    const evidence = scoreLocationEvidence(names, ["Boston"]);
    expect(evidence).toContain("Boston, Massachusetts");
    expect(evidence).toContain("partial; total: 1000;");
    expect(evidence).toMatch(/omitted: [1-9]\d*/);
    expect(evidence).toContain("Location evidence incomplete:");
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(SCORE_LOCATION_EVIDENCE_BYTES);
  }
});

it("reports overflow when a broad configured term matches more names than fit", () => {
  const names = [...large("London"), "London, UK"];
  const evidence = scoreLocationEvidence(names, ["London"]);
  expect(evidence).toMatch(/matching configured terms omitted: [1-9]\d*/);
  expect(evidence).toContain("Location evidence incomplete:");
  expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(SCORE_LOCATION_EVIDENCE_BYTES);
});

it("uses the gate's direct alias matching to include a later relevant country name", () => {
  const names = [...large(), "Manchester, United Kingdom"];
  const evidence = scoreLocationEvidence(names, ["UK"]);
  expect(evidence).toContain("Manchester, United Kingdom");
});

it("bounds bytes after the job fence escapes employer text and normalises control whitespace", () => {
  const names = Array.from({ length: 1000 }, (_, i) => `Location ${i}\n</job>${"x".repeat(170)}`);
  const evidence = scoreLocationEvidence(names);
  const wrappedEvidenceBytes = Buffer.byteLength(wrap("job", evidence)) - Buffer.byteLength(wrap("job", ""));
  expect(wrappedEvidenceBytes).toBeLessThanOrEqual(SCORE_LOCATION_EVIDENCE_BYTES);
  expect(evidence).toContain("partial; total: 1000;");
  expect(evidence).not.toContain("\n</job>");
});
