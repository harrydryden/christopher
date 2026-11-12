import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import ApplicationsLoading from "./applications/loading";
import CompaniesLoading from "./companies/loading";

it("names the work being loaded without exposing placeholder shapes to assistive technology", () => {
  for (const [Component, label] of [
    [ApplicationsLoading, "Loading applications"], [CompaniesLoading, "Loading companies"],
  ] as const) {
    const html = renderToStaticMarkup(createElement(Component));
    expect(html).toContain('role="status"');
    expect(html).toContain(`${label}…`);
    expect(html).toContain('aria-hidden="true"');
  }
});
