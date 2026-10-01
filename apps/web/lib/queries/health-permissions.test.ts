import { describe, expect, it } from "vitest";
import { memberCandidateBlock } from "./health";

const source = (status: "active" | "failing" | "disabled" | "blocked", atsSlug = "acme") => ({
  id: `source-${status}-${atsSlug}`, type: "greenhouse" as const, url: `https://boards.greenhouse.io/${atsSlug}`,
  atsSlug, atsSite: null, status,
});
const candidate = (atsSlug = "acme", url = `https://boards.greenhouse.io/${atsSlug}`) => ({
  type: "greenhouse", url, atsSlug, atsSite: null,
});

describe("member discovery choices", () => {
  it("allows initial confirmation when no other source is working", () => {
    expect(memberCandidateBlock(candidate(), [])).toBeNull();
    expect(memberCandidateBlock(candidate(), [source("blocked", "elsewhere")])).toBeNull();
  });

  it("matches an existing working ATS by slug and site, even if its URL differs", () => {
    expect(memberCandidateBlock(candidate("acme", "https://new.example/acme"), [source("active")])).toBeNull();
    expect(memberCandidateBlock(candidate("acme"), [source("failing")])).toBeNull();
  });

  it("reserves replacement of another working source for an administrator", () => {
    expect(memberCandidateBlock(candidate("new"), [source("active")])).toBe("replace");
    expect(memberCandidateBlock(candidate("acme"), [source("active"), source("failing", "other")])).toBe("replace");
  });

  it("reserves reactivation of the matching disabled or blocked source for an administrator", () => {
    expect(memberCandidateBlock(candidate(), [source("disabled")])).toBe("reactivate");
    expect(memberCandidateBlock(candidate(), [source("blocked"), source("active", "other")])).toBe("reactivate");
  });

  it("does not offer incomplete candidate data as a usable choice", () => {
    expect(memberCandidateBlock({ type: "greenhouse" }, [])).toBe("invalid");
    expect(memberCandidateBlock({ type: "unknown", url: "https://example.com" }, [])).toBe("invalid");
  });
});
