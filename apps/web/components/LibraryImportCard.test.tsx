import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LibraryImportCard } from "@/components/LibraryImportCard";

it("offers LinkedIn PDF separately from a CV and keeps paste as an export fallback", () => {
  const html = renderToStaticMarkup(createElement(LibraryImportCard));
  expect(html).toContain('id="library-import-linkedin"');
  expect(html).toContain('name="kind" value="linkedin"');
  expect(html).toContain('id="library-linkedin-pdf"');
  expect(html).toContain('accept="application/pdf,.pdf"');
  expect(html).toContain('name="kind" value="cv"');
  expect(html).toContain('name="kind" value="paste"');
  expect(html).toContain("A LinkedIn link alone does not read your profile.");
  expect(html).toContain("https://www.linkedin.com/help/linkedin/answer/a541960");
});
