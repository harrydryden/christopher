import { describe, expect, it } from "vitest";
import { elementBlocks, normalisePostingUrl, stripHtml } from "./normalize";

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

describe("stripHtml", () => {
  it("keeps readable text and drops code, tags and stray spacing", () => {
    const html = `<html><head><style>.x { color: red }</style><SCRIPT type="module">let a = "<p>";</script></head>
      <body><h1>Careers</h1>   <p>Join   us &amp; build.\t </p><br/>Two<br>lines<div>A <b>bold</b> move</div>< script>x</ script >
      5 &lt; 6 and 7 &gt; 3 <></body></html>`;
    expect(stripHtml(html)).toBe("Careers\n Join us & build.\n\nTwo\nlines A bold move\n\n 5 < 6 and 7 > 3 <>");
  });

  // Each of these made one whole-page regex rescan the rest of the page from every character or
  // tag: seconds at 100 KB, hours at the fetcher's body cap.
  const hostile = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  it.each([
    ["adjacent tags", "<b>"],
    ["tags that never close", "<a "],
    ["spaces with no newline", " "],
    ["script tags that never close", "<script>"],
    ["spaces before newlines", "  \t\n"],
  ])("reads a 5 MB page of %s in linear time", (_label, unit) => {
    stripHtml(hostile(unit, 50_000)); // compile and warm the code paths; the page is what is timed
    const page = hostile(unit, 5_000_000);
    // CPU time, not wall time, so a busy machine does not fail it.
    const started = process.cpuUsage();
    stripHtml(page);
    const { user, system } = process.cpuUsage(started);
    expect((user + system) / 1000).toBeLessThan(200);
  });
});

describe("elementBlocks", () => {
  it("finds each closed block once and skips an opening tag that is never closed", () => {
    const html = "<script>a</script><style>b</ style ><script>never closed<style>c</style>";
    const blocks = elementBlocks(html, ["script", "style"]);
    expect(blocks.map((block) => [block.name, html.slice(block.openEnd, block.closeStart)])).toEqual([
      ["script", "a"], ["style", "b"], ["style", "c"],
    ]);
  });

  it("respects a word boundary and a limit", () => {
    const html = "<itemize>x</itemize><item>one</item><item>two</item>";
    expect(elementBlocks(html, ["item"], { boundary: true }).map((block) => html.slice(block.openEnd, block.closeStart))).toEqual(["one", "two"]);
    expect(elementBlocks(html, ["item"], { boundary: true, limit: 1 })).toHaveLength(1);
  });
});
