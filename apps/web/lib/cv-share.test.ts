/**
 * The rules a share link obeys before anything is written down: what a token looks like, how long
 * a link may live, and which blocks of a CV a note may be filed against.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { materialiseCv, type CvLibrary } from "@ava/core/cv";
import { CV_PROFILE_ID, cvSectionBlockId } from "./cv-content-links";
import {
  CV_SHARE_ANCHOR_MAX_CHARS,
  CV_SHARE_AUTHOR_NAME_MAX_CHARS,
  CV_SHARE_BODY_MAX_CHARS,
  CV_SHARE_DEFAULT_DAYS,
  CV_SHARE_MAX_DAYS,
  cvShareAnchorLabel,
  cvShareAnchors,
  cvShareCommentProblem,
  cvShareDays,
  cvShareExpiry,
  cvSharePath,
  cvShareState,
  hashCvShareToken,
  isCvShareAnchor,
  isCvShareToken,
  newCvShareToken,
  openCommentCounts,
  shareClientAddress,
} from "./cv-share";

const library: CvLibrary = {
  name: "Example Candidate",
  contact: "London",
  profile: "Operations leader",
  entries: [
    {
      id: "job",
      kind: "experience",
      heading: "Director · Acme",
      details: "Led a team",
      confirmedResponsibilities: ["Led a team"],
    },
  ],
};
const content = materialiseCv(library, {
  summary: "Operations leader",
  sections: [{ entryId: "job", bullets: ["Led a team"] }],
  gaps: [],
});

describe("share tokens", () => {
  it("draws 32 random bytes in the URL-safe alphabet, and never repeats one", () => {
    const tokens = Array.from({ length: 50 }, () => newCvShareToken());
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes in base64url, without padding.
      expect(token).toHaveLength(43);
      expect(isCvShareToken(token)).toBe(true);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("hashes with sha256 exactly as the single-use auth links do", () => {
    const token = newCvShareToken();
    expect(hashCvShareToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashCvShareToken(token)).toHaveLength(64);
    // The stored form gives nothing away: a different token is a different hash.
    expect(hashCvShareToken(token)).not.toBe(hashCvShareToken(newCvShareToken()));
  });

  it("refuses a path segment that could not be one of ours before it costs a query", () => {
    for (const value of ["", "short", "../../etc/passwd", "a".repeat(201), "has spaces", "plus+slash/"])
      expect(isCvShareToken(value)).toBe(false);
  });

  it("puts the token in the path, encoded", () => {
    expect(cvSharePath("abc-123_x")).toBe("/share/abc-123_x");
  });
});

describe("expiry", () => {
  it("defaults to a fortnight and never exceeds ninety days", () => {
    expect(cvShareDays(undefined)).toBe(CV_SHARE_DEFAULT_DAYS);
    expect(cvShareDays("")).toBe(CV_SHARE_DEFAULT_DAYS);
    expect(cvShareDays("not a number")).toBe(CV_SHARE_DEFAULT_DAYS);
    expect(cvShareDays("0")).toBe(CV_SHARE_DEFAULT_DAYS);
    expect(cvShareDays("-5")).toBe(CV_SHARE_DEFAULT_DAYS);
    expect(cvShareDays("7")).toBe(7);
    expect(cvShareDays("3650")).toBe(CV_SHARE_MAX_DAYS);
    expect(cvShareDays(30.9)).toBe(30);
  });

  it("measures the expiry from now, in whole days", () => {
    const now = new Date("2026-09-19T10:00:00.000Z");
    expect(cvShareExpiry("7", now).toISOString()).toBe("2026-09-26T10:00:00.000Z");
    expect(cvShareExpiry(undefined, now).toISOString()).toBe("2026-10-03T10:00:00.000Z");
    expect(cvShareExpiry("9999", now).toISOString()).toBe("2026-12-18T10:00:00.000Z");
  });

  it("calls a link live only while it is neither revoked nor past its date", () => {
    const now = new Date("2026-09-19T10:00:00.000Z");
    const future = new Date("2026-10-01T10:00:00.000Z");
    const past = new Date("2026-09-01T10:00:00.000Z");
    expect(cvShareState({ revokedAt: null, expiresAt: future }, now)).toBe("live");
    expect(cvShareState({ revokedAt: null, expiresAt: past }, now)).toBe("expired");
    expect(cvShareState({ revokedAt: past, expiresAt: future }, now)).toBe("revoked");
    // Revocation wins over an expiry that has not arrived, and over one that has.
    expect(cvShareState({ revokedAt: past, expiresAt: past }, now)).toBe("revoked");
    // The boundary belongs to the past: a link that expires now is expired.
    expect(cvShareState({ revokedAt: null, expiresAt: now }, now)).toBe("expired");
  });
});

describe("anchors", () => {
  const sectionId = cvSectionBlockId("job");

  it("offers the profile first, then the sections in display order", () => {
    expect(cvShareAnchors(content)).toEqual([
      { id: CV_PROFILE_ID, label: "Profile" },
      { id: sectionId, label: content.sections[0]!.heading },
    ]);
    expect(cvShareAnchors(null)).toEqual([]);
  });

  it("accepts only ids this revision actually has", () => {
    expect(isCvShareAnchor(CV_PROFILE_ID, content)).toBe(true);
    expect(isCvShareAnchor(sectionId, content)).toBe(true);
    // Well formed, and not a block of this CV.
    expect(isCvShareAnchor(cvSectionBlockId("someone-elses-job"), content)).toBe(false);
    expect(isCvShareAnchor("", content)).toBe(false);
    expect(isCvShareAnchor("cv-content-section-", content)).toBe(false);
    expect(isCvShareAnchor(CV_PROFILE_ID, null)).toBe(false);
  });

  it("refuses an oversized anchor before comparing it", () => {
    expect(isCvShareAnchor("a".repeat(CV_SHARE_ANCHOR_MAX_CHARS + 1), content)).toBe(false);
    expect(CV_SHARE_ANCHOR_MAX_CHARS).toBe(120);
  });

  it("names a block for a sentence, and says so when it cannot", () => {
    expect(cvShareAnchorLabel(CV_PROFILE_ID, content)).toBe("Profile");
    expect(cvShareAnchorLabel(sectionId, content)).toBe(content.sections[0]!.heading);
    expect(cvShareAnchorLabel("cv-content-section-gone", content)).toBe("This CV");
  });
});

describe("what a reader may write", () => {
  it("insists on a name and a note, within the caps the columns enforce", () => {
    expect(cvShareCommentProblem("Sam", "The profile buries the operations work.")).toBeNull();
    expect(cvShareCommentProblem("  ", "Something")).toMatch(/name/i);
    expect(cvShareCommentProblem("Sam", "   ")).toMatch(/note/i);
    expect(cvShareCommentProblem("a".repeat(CV_SHARE_AUTHOR_NAME_MAX_CHARS + 1), "Note")).toMatch(/80/);
    expect(cvShareCommentProblem("Sam", "a".repeat(CV_SHARE_BODY_MAX_CHARS + 1))).toMatch(/2,000/);
    // Exactly at the cap is allowed; the trim happens before the measurement.
    expect(cvShareCommentProblem("a".repeat(CV_SHARE_AUTHOR_NAME_MAX_CHARS), "a".repeat(CV_SHARE_BODY_MAX_CHARS))).toBeNull();
    expect(cvShareCommentProblem(" Sam ", ` ${"a".repeat(CV_SHARE_BODY_MAX_CHARS)} `)).toBeNull();
  });
});

describe("who is asking", () => {
  it("takes the first hop of x-forwarded-for, then x-real-ip, then a constant", () => {
    expect(shareClientAddress(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(shareClientAddress(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(shareClientAddress(new Headers())).toBe("unknown");
    expect(shareClientAddress(new Headers({ "x-forwarded-for": "  " , "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(shareClientAddress(new Headers({ "x-forwarded-for": "a".repeat(400) })).length).toBe(100);
  });
});

describe("open note counts", () => {
  it("counts only the notes still open, per block", () => {
    const at = new Date("2026-09-19T10:00:00.000Z");
    expect(
      openCommentCounts([
        { anchor: CV_PROFILE_ID, resolvedAt: null },
        { anchor: CV_PROFILE_ID, resolvedAt: null },
        { anchor: CV_PROFILE_ID, resolvedAt: at },
        { anchor: cvSectionBlockId("job"), resolvedAt: null },
      ]),
    ).toEqual({ [CV_PROFILE_ID]: 2, [cvSectionBlockId("job")]: 1 });
    expect(openCommentCounts([])).toEqual({});
  });
});
