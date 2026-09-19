import { expect, it } from "vitest";
import { normalisePostingUrl } from "./normalize";

it("canonicalises a pasted posting URL without losing its identity", () => {
  expect(normalisePostingUrl("  HTTPS://Boards.Example.com/Acme/Jobs/42/?utm_source=news&gh_jid=42#apply  "))
    .toBe("https://boards.example.com/Acme/Jobs/42?gh_jid=42");
  // Referral markers go; everything else stays, in the order the board wrote it.
  expect(normalisePostingUrl("https://jobs.example.com/x?b=2&utm_campaign=q3&a=1&ref=li&gh_src=abc&fbclid=z&gclid=y&source=x&src=x&lever-source=x"))
    .toBe("https://jobs.example.com/x?b=2&a=1");
  // The root path keeps its slash; a deeper path loses a trailing one.
  expect(normalisePostingUrl("https://example.com/")).toBe("https://example.com/");
  expect(normalisePostingUrl("https://example.com/jobs/")).toBe("https://example.com/jobs");
  // A port, a case-sensitive path segment and an unknown parameter are all identity here.
  expect(normalisePostingUrl("https://example.com:8443/Jobs/Senior-Engineer?id=A1b2")).toBe("https://example.com:8443/Jobs/Senior-Engineer?id=A1b2");
  // Two pastes of the same role, from a newsletter and from the board itself.
  expect(normalisePostingUrl("https://example.com/jobs/7?utm_medium=email"))
    .toBe(normalisePostingUrl("https://example.com/jobs/7#top"));
  // Nothing parseable: hand back what was typed, for the caller to reject.
  expect(normalisePostingUrl("  not a url  ")).toBe("not a url");
});
