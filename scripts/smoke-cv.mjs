import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
require("tsx/cjs");
const { createCvAssessment } = require("../packages/core/src/cv-review.ts");
const {
  cvTextItems,
  cvClaimItems,
  cvEvidenceItems,
} = require("../packages/core/src/cv-assessment.ts");
const {
  rubricFixture,
  reviewFixture,
} = require("../packages/core/test/cv-review-fixture.ts");

const { Pool } = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
)("pg");
const { chromium } = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
)("playwright");

/** Browser → form action → saved revision, plus progress polling. Uses synthetic evidence only. */
export async function verifyCvWorkspace(baseUrl, cookie, databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const readyId = randomUUID(),
    busyId = randomUUID();
  let browser;
  const content = {
    name: "Example Candidate",
    contact: "London",
    summary: "Operations leader",
    sections: [
      {
        entryId: "job",
        kind: "experience",
        heading: "Director · Example",
        bullets: ["Led a team"],
      },
    ],
    gaps: [],
  };
  const library = {
    name: content.name,
    contact: content.contact,
    profile: content.summary,
    entries: [
      {
        id: "job",
        kind: "experience",
        heading: "Director · Example",
        details: "Led a team",
        confirmedResponsibilities: ["Led a team"],
      },
    ],
  };
  const description = "Lead a team and improve operations.";
  const rubric = rubricFixture(description);
  const review = reviewFixture({
    rubric,
    cv: cvTextItems(content),
    claims: cvClaimItems(content),
    evidence: cvEvidenceItems(library),
  });
  Object.assign(review.claims[1], {
    status: "uncertain",
    reason: "Confirm the team size and your responsibilities.",
  });
  const assessment = createCvAssessment({
    content,
    description,
    library,
    rubric,
    review,
    model: "test",
    pageCount: 2,
  });
  try {
    for (const [id, status, stage, value] of [
      [readyId, "ready", null, content],
      [busyId, "generating", "writing", null],
    ]) {
      await pool.query(
        `insert into cv_drafts (id, job_title, company_name, job_description, library_version, library_snapshot, model, status, build_stage, content)
        values ($1, 'Operations Director', 'Example', 'Lead a team and improve operations.', 1, $2, 'test', $3, $4, $5)`,
        [
          id,
          JSON.stringify(library),
          status,
          stage,
          value ? JSON.stringify(value) : null,
        ],
      );
    }
    await pool.query("update cv_drafts set assessment = $2 where id = $1", [
      readyId,
      JSON.stringify(assessment),
    ]);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/cv/${readyId}`);
    await page
      .locator("textarea[name=summary]")
      .waitFor({ timeout: 10000 })
      .catch(async (error) => {
        throw new Error(
          `${error.message}\n${await page.locator("body").innerText()}`,
        );
      });
    await page
      .getByRole("textbox", { name: "Profile", exact: true })
      .fill("Edited profile retained through panel changes.");
    const main = page.locator("[data-cv-main]");
    const openWidth = (await main.boundingBox()).width;
    await page
      .getByRole("tab", { name: "Appearance and settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Gold", exact: true }).click();
    await page
      .getByRole("checkbox", {
        name: "Remember wording corrections for future CVs.",
      })
      .uncheck();
    await page.getByRole("tab", { name: "Evaluation", exact: true }).click();
    await page.getByRole("table").waitFor();
    assert.deepEqual(await page.getByRole("columnheader").allTextContents(), [
      "Issue #",
      "Requirement",
      "Current text",
      "Change",
      "Elaborate on change",
      "Evidence",
      "Experience",
    ]);
    assert.equal(await page.locator("table tbody tr").count(), 2);
    assert.equal(
      await page
        .getByRole("region", { name: "CV evaluation table", exact: true })
        .evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
      "All evaluation columns should fit beside the description at desktop width",
    );
    assert.equal(
      await page.locator("table em").first().textContent(),
      content.summary,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Finalise this CV", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Uncertain 1", exact: true })
      .click();
    assert.equal(await page.locator("table tbody tr").count(), 1);
    assert.equal(
      await page.locator("table tbody tr td").first().textContent(),
      "2",
    );
    await page
      .getByRole("button", { name: "Show evidence for issue 2", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Hide evidence for issue 2", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    await page.getByRole("button", { name: "All 2", exact: true }).click();
    await page
      .getByRole("button", { name: "Hide evaluation table", exact: true })
      .click();
    assert.equal(await page.getByRole("table").isVisible(), false);
    await page
      .getByRole("button", { name: "Show evaluation table", exact: true })
      .click();
    assert.equal(await page.locator("details, blockquote").count(), 0);
    for (const tab of ["Content", "Evaluation", "Appearance and settings"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      assert.equal(await page.getByRole("tabpanel").count(), 1);
      assert.equal(await page.locator("#cv-job-description").isVisible(), true);
      await page
        .getByRole("button", { name: "Hide job description", exact: true })
        .click();
      assert.equal(
        await page.locator("#cv-job-description").isVisible(),
        false,
      );
      assert.ok(
        (await main.boundingBox()).width > openWidth + 200,
        `${tab} must reclaim the sidebar width`,
      );
      await page
        .getByRole("button", { name: "Show job description", exact: true })
        .click();
    }
    await page.getByRole("tab", { name: "Content", exact: true }).click();
    await page
      .getByRole("tab", { name: "Content", exact: true })
      .press("ArrowRight");
    assert.equal(
      await page
        .getByRole("tab", { name: "Evaluation", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    await page
      .getByRole("tab", { name: "Evaluation", exact: true })
      .press("End");
    assert.equal(
      await page
        .getByRole("tab", { name: "Appearance and settings", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    await page
      .getByRole("tab", { name: "Appearance and settings", exact: true })
      .press("Home");
    assert.equal(
      await page
        .getByRole("textbox", { name: "Profile", exact: true })
        .inputValue(),
      "Edited profile retained through panel changes.",
    );
    assert.equal(await page.locator("form form").count(), 0);
    const submitted = await page
      .locator("form[id^=cv-edit]")
      .evaluate((form) => Object.fromEntries(new FormData(form)));
    assert.equal(
      submitted.summary,
      "Edited profile retained through panel changes.",
    );
    assert.equal(JSON.parse(submitted.theme).primary, "#ffcc00");
    assert.equal(submitted.rememberWording, undefined);
    await mkdir("tmp/cv-review-tabs", { recursive: true });
    await page.getByRole("tab", { name: "Evaluation", exact: true }).click();
    await page.screenshot({
      path: "tmp/cv-review-tabs/evaluation-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Hide job description", exact: true })
      .click();
    await page.screenshot({
      path: "tmp/cv-review-tabs/evaluation-wide.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["Content", "Evaluation", "Appearance and settings"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${tab} must not overflow the viewport`,
      );
    }
    await page.getByRole("tab", { name: "Evaluation", exact: true }).click();
    await page.screenshot({
      path: "tmp/cv-review-tabs/evaluation-mobile.png",
      fullPage: true,
    });
    await page
      .getByRole("button", {
        name: "Save, fit and assess new revision",
        exact: true,
      })
      .click();
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith("/cv/") && !url.pathname.endsWith(readyId),
    );
    const childId = new URL(page.url()).pathname.split("/").pop();
    const {
      rows: [child],
    } = await pool.query(
      "select content, status, parent_id from cv_drafts where id = $1",
      [childId],
    );
    assert.equal(child.parent_id, readyId);
    assert.equal(child.status, "queued");
    assert.equal(child.content.summary, submitted.summary);
    assert.equal(
      child.content.theme.primary,
      JSON.parse(submitted.theme).primary,
    );
    await page
      .getByRole("heading", { name: "Your CV is queued", exact: true })
      .waitFor();
    await page.goto(`${baseUrl}/cv/${busyId}`);
    await page
      .getByRole("heading", { name: "Write your CV", exact: true })
      .waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const progress = page.getByRole("region", {
      name: "CV build progress",
      exact: true,
    });
    assert.equal(
      await progress.locator(".brand-motion-fallback").isVisible(),
      true,
    );
    assert.equal(
      await progress
        .locator(".christopher-wheel")
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      "none",
    );
    await pool.query(
      "update cv_drafts set build_stage = 'assessing' where id = $1",
      [busyId],
    );
    await page
      .getByRole("heading", { name: "Check and score", exact: true })
      .waitFor({ timeout: 25_000 });
    await pool.query(
      "update cv_drafts set status = 'ready', build_stage = null, content = $2 where id = $1",
      [busyId, JSON.stringify(content)],
    );
    await page
      .getByRole("textbox", { name: "Profile", exact: true })
      .waitFor({ timeout: 25_000 });
    assert.deepEqual(errors, []);
    console.log(
      "  CV browser flow passed: tabs, unified evaluation, keyboard navigation, full sidebar collapse, saved edits, mobile layout and real progress updates",
    );
  } finally {
    await browser?.close();
    await pool.query(
      "delete from tasks where payload->>'draftId' in (select id::text from cv_drafts where id in ($1, $2) or parent_id = $1)",
      [readyId, busyId],
    );
    await pool.query(
      "delete from cv_drafts where id in ($1, $2) or parent_id = $1",
      [readyId, busyId],
    );
    await pool.end();
  }
}
