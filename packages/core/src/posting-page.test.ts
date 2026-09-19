import { expect, it } from "vitest";
import { extractMainText, extractPostingFromPage } from "./posting-page";

const JSONLD = `<!doctype html><html><head><title>Operations Manager | Acme</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting",
"title":"Operations   Manager","url":"https://acme.example/jobs/42","datePosted":"2026-09-01",
"employmentType":"FULL_TIME","occupationalCategory":"Operations","jobLocationType":"TELECOMMUTE",
"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"London","addressCountry":"GB"}},
"description":"<p>You will run the site and own the rota.</p>",
"baseSalary":{"@type":"MonetaryAmount","currency":"GBP","value":{"@type":"QuantitativeValue","minValue":"60000","maxValue":"70000","unitText":"YEAR"}}}
</script></head><body><main>Ignored, the structured data is better.</main></body></html>`;

it("prefers the page's own structured data and maps every field it offers", () => {
  const posting = extractPostingFromPage(JSONLD, "https://acme.example/jobs/42");
  expect(posting).toMatchObject({
    title: "Operations Manager",
    location: "London, GB",
    department: "Operations",
    employmentType: "FULL_TIME",
    remote: true,
    salaryText: "GBP 60000 - 70000 per year",
    descriptionText: "You will run the site and own the rota.",
    method: "jsonld",
  });
  expect(posting?.postedAt?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
});

const HTML = `<!doctype html><html><head><meta property="og:title" content="Warehouse   Lead">
<meta name="geo.placename" content="Manchester"></head>
<body><h1>Not this one</h1><div class="posting-location">Location: Ignored, the meta tag wins</div>
<main>${"You will lead the night shift and report to the site manager. ".repeat(6)}</main></body></html>`;

it("reads a plain page from its metadata", () => {
  const posting = extractPostingFromPage(HTML, "https://acme.example/careers/warehouse-lead");
  expect(posting?.title).toBe("Warehouse Lead");
  expect(posting?.location).toBe("Manchester");
  expect(posting?.method).toBe("html");
  expect(posting?.descriptionText).toContain("night shift");
});

it("takes the location from a labelled element when the page declares no metadata", () => {
  const html = `<html><head></head><body><h1>Warehouse Lead</h1>
    <span class="job-location">Location: Manchester, UK</span></body></html>`;
  expect(extractPostingFromPage(html, "https://acme.example/careers/1")).toMatchObject({
    title: "Warehouse Lead", location: "Manchester, UK", method: "html",
  });
  const itemprop = `<html><body><h1>Warehouse Lead</h1><span itemprop="jobLocation">Leeds</span></body></html>`;
  expect(extractPostingFromPage(itemprop, "https://acme.example/careers/1")?.location).toBe("Leeds");
});

it("drops the site's name from a document title, and only when it is the site's name", () => {
  const titled = (title: string, extra = "") =>
    `<html><head>${extra}<title>${title}</title></head><body></body></html>`;
  expect(extractPostingFromPage(titled("Senior Engineer | Acme"), "https://acme.example/jobs/9")?.title).toBe("Senior Engineer");
  expect(extractPostingFromPage(titled("Senior Engineer at Acme"), "https://acme.example/jobs/9")?.title).toBe("Senior Engineer");
  expect(extractPostingFromPage(titled("Senior Engineer - Acme Foods", '<meta property="og:site_name" content="Acme Foods">'), "https://boards.example.com/9")?.title)
    .toBe("Senior Engineer");
  // Not a site name: the tail is part of the role.
  expect(extractPostingFromPage(titled("Senior Engineer - Remote"), "https://acme.example/jobs/9")?.title).toBe("Senior Engineer - Remote");
});

it("returns nothing when the page carries no title worth storing", () => {
  expect(extractPostingFromPage("<html><head><title>  </title></head><body><p>hello</p></body></html>", "https://acme.example/x")).toBeNull();
  expect(extractPostingFromPage("<html><head><title>Hi</title></head><body></body></html>", "https://acme.example/x")).toBeNull();
});

it("picks the densest block as the description", () => {
  const body = "The role covers the whole site and every shift on it. ".repeat(5);
  expect(extractMainText(`<html><body><nav>Home</nav><main>${body}</main></body></html>`)).toContain("every shift");
  expect(extractMainText("<html><body><p>Too short</p></body></html>")).toBeUndefined();
});
