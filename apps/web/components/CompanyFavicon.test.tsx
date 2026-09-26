/**
 * A roles page renders fifty company icons; only the ones in view should be fetched at load, and
 * none should hold up the main thread decoding.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CompanyFavicon } from "./CompanyFavicon";

it("loads lazily and decodes asynchronously, at a fixed size", () => {
  const html = renderToStaticMarkup(createElement(CompanyFavicon, { src: "/api/companies/c1/logo?v=1", domain: "example.com", size: 14 }));
  expect(html).toContain('loading="lazy"');
  expect(html).toContain('decoding="async"');
  expect(html).toContain('width="14"');
  expect(html).toContain('height="14"');
  expect(html).toContain('src="/api/companies/c1/logo?v=1"');
});

it("leaves the placeholder square when there is nothing to try", () => {
  expect(renderToStaticMarkup(createElement(CompanyFavicon, { src: null, domain: null }))).not.toContain("<img");
});
