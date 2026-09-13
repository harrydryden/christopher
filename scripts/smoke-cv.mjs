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
  const tableIds = [randomUUID(), randomUUID()];
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
    // Reserve scrollbar space even on macOS, whose overlay scrollbars can hide width regressions.
    await page.addStyleTag({
      content:
        'html { scrollbar-gutter: stable; } [aria-label="CV evaluation table"] { scrollbar-gutter: stable; }',
    });
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
      "Item",
      "Requirement",
      "Current text",
      "Change",
      "Guidance",
      "Evidence",
      "Experience",
    ]);
    assert.equal(await page.locator("table tbody tr").count(), 2);
    assert.equal(
      await page.getByText("Your input needed", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .locator("table tbody tr")
        .first()
        .locator("td")
        .last()
        .textContent(),
      "Strong",
    );
    assert.equal(
      await page
        .locator("table tbody tr")
        .last()
        .locator("td")
        .last()
        .textContent(),
      "Weak",
    );
    const tableDimensions = await page
      .getByRole("region", { name: "CV evaluation table", exact: true })
      .evaluate((element) => ({
        scroll: element.scrollWidth,
        client: element.clientWidth,
        table: element.querySelector("table").getBoundingClientRect().width,
        main: element.closest("[data-cv-main]").getBoundingClientRect().width,
        grid: getComputedStyle(element.closest("[data-cv-main]").parentElement)
          .gridTemplateColumns,
        viewport: innerWidth,
        cells: [...element.querySelectorAll("thead th")].map((cell) => ({
          label: cell.textContent,
          width: cell.getBoundingClientRect().width,
          scroll: cell.scrollWidth,
          client: cell.clientWidth,
        })),
      }));
    assert.equal(
      tableDimensions.scroll > tableDimensions.client,
      false,
      `All evaluation columns should fit beside the description at desktop width: ${JSON.stringify(tableDimensions)}`,
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
      .getByRole("button", { name: "Show evidence for item 2", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Hide evidence for item 2", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    await page
      .getByRole("link", { name: "Edit Director · Example", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("tab", { name: "Content", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
    assert.equal(
      await page.locator("textarea:focus").getAttribute("id"),
      "cv-content-section-job",
    );
    assert.ok(page.url().endsWith("#cv-content-section-job"));
    assert.equal(
      await page
        .getByRole("textbox", { name: "Profile", exact: true })
        .inputValue(),
      "Edited profile retained through panel changes.",
    );
    await page.getByRole("tab", { name: "Evaluation", exact: true }).click();
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
    await page.goto(`${baseUrl}/cv/${readyId}#cv-content-section-job`);
    await page.locator("textarea#cv-content-section-job:focus").waitFor();
    assert.equal(
      await page
        .getByRole("tab", { name: "Content", exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
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
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Exercise the production server actions through the CV table using disposable rows.
    for (const [index, id] of tableIds.entries()) {
      await pool.query(
        `insert into cv_drafts (id, job_title, company_name, job_description, library_version, library_snapshot, model, status, revision)
        values ($1, $2, 'CV Table Check', 'Synthetic table test', 1, $3, 'test', 'ready', 1)`,
        [id, `Table role ${index + 1}`, JSON.stringify(library)],
      );
    }
    await page.goto(`${baseUrl}/cv`);
    const savedTable = page.getByRole("table", {
      name: "Saved CVs",
      exact: true,
    });
    await savedTable.waitFor();
    assert.deepEqual(
      await savedTable.getByRole("columnheader").allTextContents(),
      ["Company", "Job role", "Date / version", "Actions"],
    );
    await savedTable
      .getByRole("checkbox", { name: "Select all saved CVs on this page" })
      .check();
    assert.equal(
      await savedTable.locator("tbody input:checked").count(),
      await savedTable.locator("tbody tr").count(),
    );
    await savedTable
      .getByRole("checkbox", { name: "Select all saved CVs on this page" })
      .uncheck();
    for (let n = 1; n <= 2; n++)
      await savedTable
        .getByRole("checkbox", {
          name: `Select CV Table Check · Table role ${n} · version 1`,
        })
        .check();
    await page
      .getByRole("button", { name: "Archive selected", exact: true })
      .click();
    const archivedTable = page.getByRole("table", {
      name: "Archived CVs",
      exact: true,
    });
    await archivedTable
      .getByRole("link", { name: "Table role 2", exact: true })
      .waitFor();
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from cv_drafts where id = any($1::uuid[]) and archived_at is not null",
          [tableIds],
        )
      ).rows[0].n,
      2,
    );
    await archivedTable
      .getByRole("checkbox", { name: "Select all archived CVs on this page" })
      .check();
    await page
      .getByRole("button", { name: "Restore selected", exact: true })
      .click();
    await savedTable
      .getByRole("link", { name: "Table role 2", exact: true })
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          `${error.message}\nTable state: ${await page.locator("main").innerText()}\nRows: ${JSON.stringify((await pool.query("select id,status,archived_at from cv_drafts where id = any($1::uuid[])", [tableIds])).rows)}`,
        );
      });
    for (let n = 1; n <= 2; n++)
      await savedTable
        .getByRole("checkbox", {
          name: `Select CV Table Check · Table role ${n} · version 1`,
        })
        .check();
    await page.screenshot({
      path: "tmp/cv-review-tabs/saved-cvs-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: "tmp/cv-review-tabs/saved-cvs-mobile.png",
      fullPage: true,
    });
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "Delete selected", exact: true })
      .first()
      .click();
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from cv_drafts where id = any($1::uuid[])",
          [tableIds],
        )
      ).rows[0].n,
      2,
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Delete selected", exact: true })
      .first()
      .click();
    await savedTable
      .getByRole("link", { name: "Table role 2", exact: true })
      .waitFor({ state: "detached" });
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from cv_drafts where id = any($1::uuid[])",
          [tableIds],
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      "  CV browser flow passed: tabs, unified evaluation, keyboard navigation, full sidebar collapse, saved edits, mobile layout, real progress updates and bulk CV archive/restore/delete",
    );
  } finally {
    await browser?.close();
    await pool.query("delete from cv_drafts where id = any($1::uuid[])", [
      tableIds,
    ]);
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
