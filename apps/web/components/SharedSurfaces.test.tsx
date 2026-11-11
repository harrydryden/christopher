// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Button, buttonLinkClass } from "./Button";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { PageHeader } from "./PageHeader";

function documentFor(markup: string) {
  return new DOMParser().parseFromString(markup, "text/html");
}

it("preserves native button type, disabled and busy semantics with wrapping labels", () => {
  const longLabel = "ContinueWithAnExceptionallyLongUnbrokenActionNameAtNarrowWidths";
  const doc = documentFor(renderToStaticMarkup(<>
    <Button id="ordinary">{longLabel}</Button>
    <Button type="submit" variant="primary" size="sm" disabled aria-busy="true" name="save" value="yes">
      Saving…
    </Button>
  </>));
  const ordinary = doc.querySelector<HTMLButtonElement>("#ordinary")!;
  const saving = doc.querySelector<HTMLButtonElement>('button[name="save"]')!;
  expect(ordinary.type).toBe("button");
  expect(ordinary.textContent).toBe(longLabel);
  expect(ordinary.className).toContain("min-w-0");
  expect(ordinary.className).toContain("max-w-full");
  expect(ordinary.className).toContain("break-words");
  expect(saving.type).toBe("submit");
  expect(saving.disabled).toBe(true);
  expect(saving.getAttribute("aria-busy")).toBe("true");
  expect(saving.value).toBe("yes");
  expect(buttonLinkClass("secondary")).toContain("no-underline");
  expect(buttonLinkClass("secondary")).toContain("max-w-full");
});

it("keeps long card and page titles alongside wrapped actions at phone width", () => {
  const title = "AnExceptionallyLongRoleTitleWithoutSpacesThatMustStayInsideThePage";
  const doc = documentFor(renderToStaticMarkup(<main style={{ width: 320 }}>
    <PageHeader title={title} description="A long explanation for the page" actions={<Button>Open this very long named task</Button>} />
    <Card title={title} actions={<a href="/roles/add" className={buttonLinkClass()}>Add another very long role</a>}>
      <p>Card content</p>
    </Card>
  </main>));
  const pageTitle = doc.querySelector("h1")!;
  const cardTitle = doc.querySelector("h2")!;
  expect(pageTitle.textContent).toBe(title);
  expect(pageTitle.className).toContain("text-20");
  expect(pageTitle.className).toContain("break-words");
  expect(cardTitle.textContent).toBe(title);
  expect(cardTitle.className).toContain("min-w-0");
  expect(cardTitle.className).toContain("break-words");
  expect(doc.querySelector("section")?.className).toContain("min-w-0");
  expect(doc.querySelector("section header")?.className).toContain("flex-wrap");
  expect(doc.querySelector("section header a")?.parentElement?.className).toContain("w-full");
  expect(doc.querySelector("section header a")?.className).toContain("max-w-full");
});

it("renders empty-state guidance as a readable heading with contained actions", () => {
  const doc = documentFor(renderToStaticMarkup(<EmptyState
    title="NoMatchingRolesFoundForThisUnusuallyLongSearchPhrase"
    description="Try a different keyword or location."
    action={<a className={buttonLinkClass("primary")} href="/roles/add">Add a role manually</a>} />));
  const heading = doc.querySelector("h2")!;
  expect(heading.textContent).toContain("NoMatchingRoles");
  expect(heading.className).toContain("text-16");
  expect(heading.className).toContain("break-words");
  expect(heading.className).not.toContain("ds-pixel");
  expect(doc.querySelector("p")?.textContent).toBe("Try a different keyword or location.");
  expect(doc.querySelector("a")?.getAttribute("href")).toBe("/roles/add");
  expect(doc.querySelector("a")?.parentElement?.className).toContain("flex-wrap");
});
