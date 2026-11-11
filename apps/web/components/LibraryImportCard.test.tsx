import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LibraryImportCard } from "@/components/LibraryImportCard";

it("offers LinkedIn PDF separately from a CV and keeps paste as an export fallback", () => {
  const html = renderToStaticMarkup(createElement(LibraryImportCard));
  expect(html).toContain('id="library-import-linkedin"');
  expect(html).toContain('aria-label="Import source"');
  expect(html).not.toContain("<details");
  expect(html).toContain('aria-current="true"');
  expect(html).toContain('name="kind" value="linkedin"');
  expect(html).toContain('id="library-linkedin-pdf"');
  expect(html).toContain('accept="application/pdf,.pdf"');
  const declaration = html.match(/<input[^>]*name="ownProfile"[^>]*>/)?.[0];
  expect(declaration).toContain('value="yes"');
  expect(declaration).toContain('required=""');
  expect(html).toContain('name="kind" value="cv"');
  expect(html).toContain('name="kind" value="paste"');
  expect(html).toContain('name="kind" value="website"');
  expect(html).toContain("A LinkedIn link alone does not read your profile.");
  expect(html).toContain("Upload only your own profile.");
  expect(html).toContain("https://www.linkedin.com/help/linkedin/answer/a541960");
});

it("shows the chosen source first while retaining the other unsent forms for switching", () => {
  const normal = renderToStaticMarkup(createElement(LibraryImportCard));
  expect(normal.match(/<section[^>]*id="library-import-cv"[^>]*>/)?.[0]).not.toContain("hidden");
  expect(normal.match(/<section[^>]*id="library-import-linkedin"[^>]*>/)?.[0]).toContain("hidden");
  const guided = renderToStaticMarkup(createElement(LibraryImportCard, { openLinkedIn: true }));
  expect(guided.match(/<section[^>]*id="library-import-cv"[^>]*>/)?.[0]).toContain("hidden");
  expect(guided.match(/<section[^>]*id="library-import-linkedin"[^>]*>/)?.[0]).not.toContain("hidden");
  expect(guided).toContain('name="kind" value="cv"');
  expect(guided).toContain('name="kind" value="paste"');
});
