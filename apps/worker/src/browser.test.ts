/**
 * Headless Chromium: renders a page whose roles arrive from JavaScript, and captures the API call
 * the page makes so the applicant tracking system can be identified from it.
 * Skipped when CHRISTOPHER_DISABLE_BROWSER=1 (CI without a browser).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserRenderer } from "./browser";
import { startTestServer, type TestServer } from "./test-server";
import { ats, discovery } from "@christopher/core";

const skip = process.env.CHRISTOPHER_DISABLE_BROWSER === "1";
const GH_API = "https://boards-api.greenhouse.io/v1/boards/acmeindustries/jobs?content=true";

const SHELL_PAGE = `<!doctype html><html><head><title>Open Roles | Acme Industries</title></head><body>
  <div id="root">Loading…</div>
  <script>
    fetch(${JSON.stringify(GH_API)})
      .then(function (r) { return r.json(); })
      .then(function (data) {
        document.getElementById("root").innerHTML = data.jobs
          .map(function (j) {
            return '<li><a href="' + j.absolute_url + '">' + j.title + '</a><span class="loc">' + j.location.name + '</span></li>';
          })
          .join("");
      })
      .catch(function () { document.getElementById("root").innerHTML = "failed"; });
  </script></body></html>`;

const JOBS = {
  jobs: [
    { id: 5001, title: "Operations Manager", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5001", location: { name: "Costa Mesa, CA" } },
    { id: 5002, title: "Mission Operations Lead", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5002", location: { name: "London, UK" } },
    { id: 5003, title: "Supply Chain Operations", absolute_url: "https://job-boards.greenhouse.io/acmeindustries/jobs/5003", location: { name: "Costa Mesa, CA" } },
  ],
};

let server: TestServer;
let renderer: BrowserRenderer;

beforeAll(async () => {
  if (skip) return;
  server = await startTestServer(
    {
      "www.acmeind.example": { "/open-roles": { body: SHELL_PAGE },
        "/paginated": { body: `<html><body><ul id="jobs"><li><a href="/jobs/one">Operations Director</a></li></ul><button id="next" onclick="document.getElementById('jobs').innerHTML='<li><a href=/jobs/two>Finance Director</a></li>';this.disabled=true">Next</button></body></html>` },
        "/stuck": { body: `<html><body><ul><li><a href="/jobs/one">Operations Director</a></li></ul><button>Next</button></body></html>` } },
      "boards-api.greenhouse.io": { "/v1/boards/acmeindustries/jobs": { body: JOBS } },
    },
    ["www.acmeind.example", "boards-api.greenhouse.io"],
  );
  renderer = new BrowserRenderer({
    userAgent: "ChristopherJobMonitor/0.1 (test)",
    hostMap: server.hostMap,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
  });
}, 120_000);

afterAll(async () => {
  await renderer?.close();
  await server?.close();
});

describe.skipIf(skip)("headless rendering", () => {
  it("preserves roles from every JavaScript page and stops at a disabled next button", async () => {
    const page = await renderer.render("https://www.acmeind.example/paginated", { scrollAndExpand: true });
    const postings = page.listingPages!.flatMap(p => ats.extractPostingsFromHtml(p.html, p.url));
    expect(postings.map(p => p.title)).toEqual(["Operations Director", "Finance Director"]);
    expect(page.incomplete).toBe(false);
  }, 120000);
  it("marks an unresponsive next button incomplete", async () => {
    const page = await renderer.render("https://www.acmeind.example/stuck", { scrollAndExpand: true });
    expect(page.incomplete).toBe(true);
  }, 120000);
  it("renders roles that only exist after JavaScript runs", async () => {
    const page = await renderer.render("https://www.acmeind.example/open-roles", { scrollAndExpand: true });
    expect(page.html).toContain("Mission Operations Lead");

    const postings = ats.extractPostingsFromHtml(page.html, page.finalUrl);
    expect(postings).toHaveLength(3);
    expect(postings.find((p) => p.title === "Mission Operations Lead")?.location).toBe("London, UK");
  }, 120_000);

  it("captures the API call the page makes, so the board can be identified from it", async () => {
    const page = await renderer.render("https://www.acmeind.example/open-roles");
    const specs = page.requests.map((url) => ats.specFromAnyUrl(url)).filter((s) => s !== null);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.type).toBe("greenhouse");
    expect(specs[0]!.atsSlug).toBe("acmeindustries");
    // This is the evidence discovery scores as `ats_network`, its highest-confidence method.
    expect(discovery.confidenceFor({ method: "ats_network" })).toBeGreaterThanOrEqual(discovery.AUTO_ACCEPT_CONFIDENCE);
  }, 120_000);

  it("blocks images, fonts and media so pages load quickly", async () => {
    const page = await renderer.render("https://www.acmeind.example/open-roles");
    expect(page.status).toBe(200);
    expect(page.requests.every((r) => !/\.(png|jpg|jpeg|gif|woff2?)$/i.test(r))).toBe(true);
  }, 120_000);
});
