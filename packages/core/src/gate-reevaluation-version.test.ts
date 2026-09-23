/**
 * The boot re-evaluation runs only when `GATE_REEVALUATION_VERSION` changes, so the version is
 * only as good as the discipline of bumping it. This pins what the gate decides for a fixed corpus
 * to the version: a change to the gate that alters any decision fails here until the version is
 * bumped and the new digest recorded beside it, which is what makes every table catch up.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateGate, type GateInput, type GateSettings } from "./gate";
import { GATE_REEVALUATION_VERSION } from "./tasks";

/** The digest of the corpus's decisions under each version. Add a line when the version moves. */
const DIGESTS: Record<number, string> = {
  1: "eafb1b78baaddcb9c0c0cfdf07b807077e172fd7cfd3fc62041b2fb173ba5930",
};

const postings: GateInput[] = [
  { title: "Head of Operations", location: "London, UK" },
  { title: "Operations Manager", department: "Business Operations", location: "Manchester" },
  { title: "Senior Operations Analyst", location: "Remote", remote: true },
  { title: "Director of Strategy & Operations", location: "New York, NY" },
  { title: "Chief of Staff", location: "London" },
  { title: "Chief of Staff to the CEO", location: "Remote - US", remote: true },
  { title: "DevOps Engineer", department: "Engineering", location: "Berlin" },
  { title: "RevOps Lead", location: "London or Remote", remote: true },
  { title: "Software Engineer", description: "You will support our operations team.", location: "London" },
  { title: "Operational Excellence Lead", location: "Dublin, Ireland" },
  { title: "Operator in Residence", location: "San Francisco" },
  { title: "Junior Operations Associate", location: "London" },
  { title: "VP Operations", location: "UK", locations: ["London", "Edinburgh"] },
  { title: "Operations Intern", location: "London" },
  { title: "Business Operations Partner", department: "Finance", location: "Remote (UK)", remote: true },
  { title: "Head of People", department: "Operations", location: "London" },
  { title: "Strategy Lead", description: "Own strategic planning and operations cadence.", location: "Paris" },
  { title: "Program Manager, Ops", location: "Singapore" },
  { title: "Head of Operations (Contract)", location: "London", remote: false },
  { title: "Operations Lead", location: "", locations: [] },
  { title: "Operations Lead", location: null, remote: true },
  { title: "Customer Support Specialist", department: "Customer Operations", location: "Lisbon" },
  { title: "Senior Director, Operations Strategy", location: "Toronto, Canada" },
  { title: "Operations Manager - EMEA", location: "Amsterdam", remote: true },
  { title: "Head of Operations", location: "Remote, Europe", remote: true },
  { title: "Principal Strategist", location: "London", description: "Chief of staff style role." },
  { title: "Sales Development Representative", location: "London" },
  { title: "Operations Coordinator", location: "Bristol, England" },
  { title: "Engineering Operations Manager", department: "Engineering", location: "Remote - Americas", remote: true },
  { title: "Director, Revenue Operations", location: "London, United Kingdom" },
];

const gates: GateSettings[] = [
  { includeKeywords: ["operations"], excludeKeywords: [], matchFields: ["title"], locationTerms: [], includeRemote: true },
  { includeKeywords: ["operat*", "*ops"], excludeKeywords: ["intern", "junior"], matchFields: ["title", "department"], locationTerms: ["London", "UK"], includeRemote: true },
  { includeKeywords: ["\"chief of staff\"", "strateg* lead"], excludeKeywords: [], matchFields: ["title", "description"], locationTerms: ["London"], includeRemote: false },
  { includeKeywords: ["operations"], excludeKeywords: ["engineer"], seniorityKeywords: ["head", "director", "vp"], matchFields: ["title"], locationTerms: ["Europe"], includeRemote: true },
  { includeKeywords: [], excludeKeywords: ["sales"], matchFields: ["title"], locationTerms: ["United Kingdom"], includeRemote: false },
];

function digest(): string {
  const decisions = gates.map(gate => postings.map(posting => evaluateGate(posting, gate)));
  return createHash("sha256").update(JSON.stringify(decisions)).digest("hex");
}

describe("gate re-evaluation version", () => {
  it("changes whenever what the gate decides changes", () => {
    const current = digest();
    const recorded = DIGESTS[GATE_REEVALUATION_VERSION];
    expect(recorded, `record the digest for GATE_REEVALUATION_VERSION ${GATE_REEVALUATION_VERSION}: ${current}`).toBeDefined();
    expect(current, `gate output changed: bump GATE_REEVALUATION_VERSION in tasks.ts and record ${current} beside it`).toBe(recorded);
  });

  it("never reuses a digest across versions", () => {
    expect(new Set(Object.values(DIGESTS)).size).toBe(Object.keys(DIGESTS).length);
  });
});
