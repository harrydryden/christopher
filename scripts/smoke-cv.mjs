import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
const { modelForCallSite, resolveSystemSettings } = require("../packages/core/src/settings.ts");

const { Pool } = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
)("pg");
const { chromium } = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
)("playwright");

/** Browser → form action → saved revision, plus progress polling. Uses synthetic evidence only. */
/** Fill a controlled input and re-fill until its value is exactly `text` (see the call site). */
async function fillUntilStable(locator, text, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await locator.fill(text);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if ((await locator.inputValue()) === text) return;
  }
  throw new Error(`Could not settle the field on "${text}"; it kept re-rendering under the fill.`);
}

export async function verifyCvWorkspace(baseUrl, cookie, databaseUrl, userId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const readyId = randomUUID(),
    busyId = randomUUID(),
    failedId = randomUUID();
  const tableIds = [randomUUID()];
  // The role the applications table is exercised against: its own company, so it goes at the end.
  const TABLE_DOMAIN = "cvtable.invalid";
  const tableCompanyId = randomUUID(), tableSourceId = randomUUID(), tableJobId = randomUUID();
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
  const setting = async (key) => (await pool.query("select value from user_settings where user_id = $1 and key = $2", [userId, key])).rows[0];
  const originalWriting = await setting("cvWritingPreferences");
  const originalCvTheme = await setting("cvTheme");
  const originalCvModel = await setting("cvModel");
  try {
    for (const [id, status, stage, value] of [
      [readyId, "ready", null, content],
      [busyId, "generating", "writing", null],
    ]) {
      await pool.query(
        `insert into cv_drafts (id, user_id, job_title, company_name, job_description, library_version, library_snapshot, model, status, build_stage, content)
        values ($1, $6, 'Operations Director', 'Example', 'Lead a team and improve operations.', 1, $2, 'test', $3, $4, $5)`,
        [
          id,
          JSON.stringify(library),
          status,
          stage,
          value ? JSON.stringify(value) : null,
          userId,
        ],
      );
    }
    await pool.query("update cv_drafts set assessment = $2 where id = $1", [
      readyId,
      JSON.stringify(assessment),
    ]);
    // A generating draft with no task behind it is a stopped build, and the page now says so.
    // Give the busy one a worker holding it, and a recent progress mark, so it reads as running.
    await pool.query(
      `insert into tasks (type, payload, dedupe_key, status, attempts, started_at, locked_at, locked_by)
       values ('generate_cv', $1, $2, 'running', 1, now(), now(), 'smoke-worker')`,
      [JSON.stringify({ draftId: busyId }), `generate_cv:${busyId}`],
    );
    await pool.query("update cv_drafts set progress_at = now() where id = $1", [busyId]);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // The CV list has gone; the link every older page carries lands on the applications table.
    await page.goto(`${baseUrl}/cv`);
    assert.equal(new URL(page.url()).pathname, "/applications");
    assert.equal(await page.getByRole("heading", { name: "CV model", exact: true }).count(), 0);
    assert.equal(await page.getByText(/Uses library version/).count(), 0);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Library", exact: true }).click();
    await page.getByRole("heading", { name: "Library", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/library");
    assert.equal(await page.getByRole("group", { name: "Appearance", exact: true }).count(), 0);
    assert.equal(await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Library", exact: true }).getAttribute("aria-current"), "page");
    // Applications owns the CV pages now; on Library it must not be the current entry.
    assert.equal(await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Applications", exact: true }).getAttribute("aria-current"), null);
    const experienceTab = page.getByRole("tab", { name: "Experience", exact: true });
    const educationTab = page.getByRole("tab", { name: "Education, skills and interests", exact: true });
    const introTab = page.getByRole("tab", { name: "Intro", exact: true });
    assert.equal(await introTab.getAttribute("aria-selected"), "true");
    // Writing preferences live on the Library, beside the wording they shape (SPEC: version history and writing preferences on the Library page).
    assert.equal(await page.getByRole("textbox", { name: "Writing style", exact: true }).count(), 1);
    // The save bar says what is at stake before anything has been typed, and the moment it has.
    assert.equal(await page.getByText("Not saved yet", { exact: true }).count(), 1);
    await page.getByRole("textbox", { name: "Website", exact: true }).fill("https://example.com/portfolio");
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    await experienceTab.click();
    await educationTab.click();
    assert.equal(await page.getByRole("heading", { name: "Employment history", exact: true }).isVisible(), false);
    await page.getByRole("button", { name: "Add education, skill or interest", exact: true }).click();
    const skills = page.getByRole("textbox", { name: "Individual skills:", exact: true });
    await skills.fill("SQL\nPython");
    await experienceTab.click();
    assert.equal(await skills.isVisible(), false);
    await experienceTab.press("ArrowRight");
    assert.equal(await educationTab.getAttribute("aria-selected"), "true");
    assert.equal(await skills.inputValue(), "SQL\nPython");
    await introTab.click();
    assert.equal(await page.getByRole("textbox", { name: "Website", exact: true }).inputValue(), "https://example.com/portfolio");
    await experienceTab.click();

    // What a CV can be built from, said on the Library by the rule generation itself applies: a
    // job, one responsibility and its confirmation, each answered in turn. A job in employment
    // history is active by being there; there is no status to set.
    const readyLine = page.getByText(/^Ready to build:/);
    assert.match(await readyLine.innerText(), /^Ready to build: no — add a job/);
    await page.getByRole("button", { name: "Add job", exact: true }).click();
    // The employment grid is a table here and stacked cards on a phone, so both copies of each
    // field exist in the DOM and only the one for this viewport is visible.
    await page.locator('input[aria-label="Job 1 company"]:visible').fill("Smoke Co");
    await page.locator('input[aria-label="Job 1 title"]:visible').fill("Operations Lead");
    const smokeJob = page.locator("fieldset").filter({ hasText: "Operations Lead · Smoke Co" });
    await smokeJob.getByRole("button", { name: "Add new responsibility or outcome", exact: true }).click();
    // The row that was just added takes the caret, so it can be typed into straight away.
    assert.match(await page.evaluate(() => document.activeElement?.id ?? ""), /^responsibility-/);
    await page
      .getByRole("textbox", { name: "Smoke Co Operations Lead evidence 1", exact: true })
      .fill("Ran the smoke estate end to end every morning.");
    assert.match(await smokeJob.innerText(), /0 of 1 row confirmed/);
    assert.equal(await readyLine.innerText(), "Ready to build: no — confirm Smoke Co’s rows");
    // The row's Type is one dropdown that takes several types at once.
    assert.equal(await smokeJob.getByRole("group", { name: "Type of row 1", exact: true }).count(), 1);
    assert.equal(await smokeJob.getByRole("combobox", { name: /^Status:/ }).count(), 0);
    // Removing a job archives its rows and says so, and the way back is at the foot of the tab.
    page.once("dialog", (dialog) => { assert.match(dialog.message(), /You can restore it from Archived jobs below\./); return dialog.accept(); });
    await page.locator('button[aria-label="Remove job 1"]:visible').click();
    const archived = page.locator("details").filter({ hasText: "Archived jobs (1)" });
    await archived.locator("summary").click();
    assert.match(await archived.innerText(), /Operations Lead · Smoke Co.*· 1 row/s);
    await archived.getByRole("button", { name: /^Restore / }).click();
    assert.equal(await page.locator('input[aria-label="Job 1 company"]:visible').inputValue(), "Smoke Co");
    await smokeJob.getByRole("button", { name: "Confirm all", exact: true }).click();
    assert.match(await smokeJob.innerText(), /1 of 1 row confirmed/);
    assert.equal(await readyLine.innerText(), "Ready to build: yes");

    // An incomplete field in the other tab must be revealed when saving.
    await page.getByRole("button", { name: "Save library", exact: true }).click();
    assert.equal(await educationTab.getAttribute("aria-selected"), "true");

    // Nothing typed here leaves by accident: an in-app link asks first, and declining stays put.
    const declined = new Promise((resolve) =>
      page.once("dialog", (dialog) => { dialog.dismiss().then(() => resolve(dialog.message())); }),
    );
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Settings", exact: true }).click();
    assert.match(await declined, /unsaved Library changes/i);
    assert.equal(new URL(page.url()).pathname, "/library");
    // Leaving on purpose: the same prompt, accepted. The edits above are never saved.
    const leaving = (dialog) => dialog.accept();
    page.on("dialog", leaving);
    await page.goto(`${baseUrl}/cv/library`);
    await page.getByRole("heading", { name: "Library", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/library");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Settings", exact: true }).click();
    page.off("dialog", leaving);
    const appearance = page.getByRole("group", { name: "Appearance", exact: true });
    await appearance.getByRole("button", { name: "Gold", exact: true }).click();
    await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/settings"),
      page.locator("form").filter({ has: appearance }).getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    assert.equal((await setting("cvTheme")).value.primary, "#ffcc00");
    await page.reload();
    await appearance.waitFor();
    assert.equal(await appearance.getByRole("button", { name: "Gold", exact: true }).getAttribute("aria-pressed"), "true");
    // Writing preferences are written on the Library, beside the wording they shape; Settings only points there.
    assert.equal(await page.getByRole("textbox", { name: "Writing style", exact: true }).count(), 0);
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Library", exact: true }).click();
    await page.getByRole("heading", { name: "Library", exact: true }).waitFor();
    const writingStyle = page.getByRole("textbox", { name: "Writing style", exact: true });
    await writingStyle.fill("Use concise UK English.");
    await page.getByRole("textbox", { name: "Saved phrasing", exact: true }).fill("Led the team");
    await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/library"),
      page.locator("form").filter({ has: writingStyle }).getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    await page.reload();
    await writingStyle.waitFor();
    assert.equal(await writingStyle.inputValue(), "Use concise UK English.");
    assert.equal((await setting("cvWritingPreferences")).value.preferredWording, "Led the team");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    const cvModel = page.getByRole("combobox", { name: "CV model", exact: true });
    await cvModel.waitFor();
    const currentModel = await cvModel.inputValue();
    // The shared extraction model is set in Admin, so read it the way the app does rather than from this page.
    const extractionModel = modelForCallSite(resolveSystemSettings((await pool.query("select key, value from settings where key not like 'internal:%'")).rows), "A3");
    const choices = await cvModel.locator("option").evaluateAll(options => options.map(option => option.value));
    const selectedModel = choices.find(value => value !== currentModel && value !== extractionModel);
    assert.ok(selectedModel);
    await cvModel.selectOption(selectedModel);
    await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/settings"),
      page.locator("form").filter({ has: cvModel }).getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    assert.equal((await setting("cvModel")).value, selectedModel);
    await page.reload();
    await cvModel.waitFor();
    assert.equal(await cvModel.inputValue(), selectedModel);
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
    // The page is server-rendered with the stored summary and refreshes itself every ten seconds.
    // A fill that lands while React is hydrating or re-rendering the controlled textarea loses
    // its select-all and prepends instead of replacing, so the value is checked and the fill
    // repeated until it sticks: the smoke is about the editor, not about winning that race.
    await fillUntilStable(
      page.getByRole("textbox", { name: "Profile", exact: true }),
      "Edited profile retained through panel changes.",
    );
    const main = page.locator("[data-cv-main]");
    const openWidth = (await main.boundingBox()).width;

    // The two saves differ by more than their labels: what each keeps, what each re-runs, and
    // what each is expected to cost, stated under the buttons that choose between them.
    const actions = await page.locator("dl").filter({ hasText: "Rebuild from Library" }).innerText();
    const priced = (line) => Number(/about .{0,3}\$(\d+\.\d\d)/.exec(line)[1]);
    const [direct, rebuild] = actions.split("\n");
    assert.match(direct, /^Save Direct Edits · keeps your wording, re-checks it · about .{0,3}\$\d+\.\d\d$/);
    assert.match(rebuild, /^Rebuild from Library · plans and rewrites from the latest Library; includes one improvement pass if useful · about .{0,3}\$\d+\.\d\d$/);
    assert.ok(
      priced(direct) < priced(rebuild),
      `keeping the wording must cost less than writing it again: ${actions}`,
    );

    // The wording option sits with the words it remembers, on the Content tab, and is still
    // called by its own four words rather than its hint.
    await page
      .getByRole("checkbox", {
        name: "Remember wording corrections",
        exact: true,
      })
      .uncheck();
    await page
      .getByRole("tab", { name: "Appearance and settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Gold", exact: true }).click();
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
    // Why it is not offered, in the words `assertCvFinalisable` would have thrown.
    assert.match(
      await page.getByText(/^Finalise is not available yet:/).innerText(),
      /Finalise is not available yet: Resolve the flagged factual claims, then reassess before finalising\./,
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
    // What the save sends and what comes back, kept for the failure message: a server action is a
    // POST to the page's own URL, and a save that never left the page has none.
    const saveTraffic = [];
    const startedAt = Date.now();
    const stamp = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    const interesting = (request) => request.method() === "POST" || request.url().includes("/cv/") || request.headers()["rsc"] === "1";
    const onRequest = (request) => {
      if (interesting(request)) saveTraffic.push(`${stamp()} → ${request.method()} ${request.url()} rsc=${request.headers()["rsc"] ?? "-"} next-action=${request.headers()["next-action"] ?? "-"}`);
    };
    const onResponse = (response) => {
      if (interesting(response.request())) saveTraffic.push(`${stamp()} ← ${response.status()} ${response.url()} x-action-redirect=${response.headers()["x-action-redirect"] ?? "-"} type=${response.headers()["content-type"] ?? "-"}`);
    };
    const onFinished = (request) => {
      if (interesting(request)) saveTraffic.push(`${stamp()} ✓ finished ${request.url()}`);
    };
    const onFailed = (request) => {
      if (interesting(request)) saveTraffic.push(`${stamp()} ✗ ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
    };
    const consoleErrors = [];
    const onConsole = (message) => { if (message.type() === "error") consoleErrors.push(message.text()); };
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfinished", onFinished);
    page.on("requestfailed", onFailed);
    page.on("console", onConsole);
    const saveButton = page.getByRole("button", { name: "Save Direct Edits", exact: true });
    await saveButton.click();
    try {
      // Longer than the database's thirty-second statement timeout, so a render held up by a lock
      // fails as one, and the failure below names it, rather than this wait giving up first.
      await page.waitForURL(
        (url) =>
          url.pathname.startsWith("/cv/") && !url.pathname.endsWith(readyId),
        { timeout: 45_000 },
      );
    } catch (error) {
      // The failure names what the page said instead of navigating: the action's refusal, if any,
      // the state of the button, the action requests seen, and anything the console complained of.
      const said = await page
        .locator('[role="alert"], [role="status"]')
        .allInnerTexts()
        .catch(() => []);
      const buttons = await page
        .getByRole("button", { name: /Save Direct Edits|Saving…/ })
        .evaluateAll((nodes) => nodes.map((node) => `${node.textContent?.trim()} disabled=${node.disabled} form=${node.getAttribute("form")} type=${node.getAttribute("type")}`))
        .catch(() => []);
      throw new Error(
        `${error.message}\nstill at ${page.url()}; the page says: ${JSON.stringify(said)}\nsave buttons: ${JSON.stringify(buttons)}\nsave traffic: ${JSON.stringify(saveTraffic)}\nconsole errors: ${JSON.stringify(consoleErrors)}`,
        { cause: error },
      );
    } finally {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
      page.off("console", onConsole);
    }
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
    let statusAttempts = 0;
    await page.route(`**/api/work-status?cv=${busyId}`, (route) => {
      if (statusAttempts++ === 0)
        return route.fulfill({ status: 503, body: "Temporary status failure" });
      return route.continue();
    });
    // Lose the first stage refresh response as well as the first status request.
    // The next poll must retry an unchanged-but-not-yet-rendered stage version.
    let droppedStageRefresh = false;
    await page.route(`**/cv/${busyId}?*`, (route) => {
      if (!droppedStageRefresh && route.request().headers()["rsc"] === "1") {
        droppedStageRefresh = true;
        return route.abort("failed");
      }
      return route.continue();
    });
    // The build's own account of itself: three motions done, one still open. The page reads these
    // back as the narrative under the milestone strip, so the figures below are what it must say.
    const motion = (draftId, seq, stage, motionName, title, status, startedSecondsAgo, ms, detail, failure = null) =>
      pool.query(
        `insert into cv_build_steps (draft_id, user_id, attempt, seq, stage, motion, title, status, started_at, finished_at, ms, detail, error, failure)
         values ($1, $2, 1, $3, $4, $5, $6, $7, now() - make_interval(secs => $8), $9, $10, $11, $12, $13)`,
        [
          draftId, userId, seq, stage, motionName, title, status, startedSecondsAgo,
          ms === null ? null : new Date(Date.now() - (startedSecondsAgo * 1000 - ms)),
          ms, JSON.stringify(detail),
          failure ? failure.message : null,
          failure ? JSON.stringify(failure) : null,
        ],
      );
    await motion(busyId, 1, "preparing", "load_inputs", "Reading your Library and the role", "done", 120, 900, {
      libraryVersion: 1, roles: 2, qualifications: 1, skillBlocks: 1, descriptionCharacters: 42,
    });
    await motion(busyId, 2, "preparing", "admit_budget", "Reserving this build's share of your AI budget", "done", 119, 300, {
      expectedUsd: 3.06, leftUsd: 18.4, heldUsd: 0,
    });
    await motion(busyId, 3, "analysing", "rubric", "Extracting the role's requirements", "done", 118, 52_000, {
      requirements: 12, essential: 5, desirable: 4, responsibilities: 3, usd: 0.28, tokens: 23_120,
    });
    // Open, and started twenty seconds ago: its line must be counting, not frozen.
    await motion(busyId, 4, "writing", "write", "Writing the CV", "running", 20, null, { attempt: 1, maxPages: 2 });
    await page.goto(`${baseUrl}/cv/${busyId}`);
    await page
      .getByRole("heading", { name: "Write your CV", exact: true })
      .waitFor();
    const narrative = page.getByRole("list", { name: "Build narrative", exact: true });
    await narrative
      .getByText("Extracted 12 requirements (5 essential, 4 desirable, 3 responsibilities)")
      .waitFor();
    const narrated = await narrative.innerText();
    assert.match(narrated, /Read your Library \(version 1: 2 roles, 1 qualification, 1 skill block\) and the role \(42 characters\)/);
    assert.match(narrated, /Reserved .{0,3}\$3\.06 of your AI budget \(.{0,3}\$18\.40 left this month\)/);
    assert.match(narrated, /52 s/);
    // The open motion counts from its own start, not from the build's.
    const elapsed = /Writing the CV · running (\d+) s/.exec(narrated);
    assert.ok(elapsed, `the open motion did not render an elapsed figure:\n${narrated}`);
    assert.ok(Number(elapsed[1]) >= 20, `elapsed figure ${elapsed[1]}s is younger than the step`);
    // The viewport is a phone here: a narrative line wraps rather than widening the page.
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "the build narrative must not overflow a phone viewport",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    const progress = page.getByRole("region", {
      name: "CV build progress",
      exact: true,
    });
    // One mark in both states now: reduced motion stops its letters turning
    // rather than swapping in a separate still image. The turn is on each
    // letter's path, not on the svg.
    const mark = progress.locator("svg").first();
    assert.equal(await mark.isVisible(), true);
    assert.equal(
      await mark.locator(".ds-mark-letter").first().evaluate((el) => getComputedStyle(el).animationName),
      "none",
    );
    await pool.query(
      "update cv_drafts set build_stage = 'assessing' where id = $1",
      [busyId],
    );
    await page
      .getByRole("heading", { name: "Check and score", exact: true })
      .waitFor({ timeout: 25_000 });
    assert.equal(droppedStageRefresh, true);
    await pool.query(
      "update cv_drafts set status = 'ready', build_stage = null, content = $2 where id = $1",
      [busyId, JSON.stringify(content)],
    );
    // A finished build closes its open motion and records the save, as the worker does.
    await pool.query(
      "update cv_build_steps set status = 'done', finished_at = now(), ms = 30000 where draft_id = $1 and status = 'running'",
      [busyId],
    );
    await motion(busyId, 5, "publishing", "publish", "Saving the CV", "done", 1, 400, { revision: 1, archivedPrevious: false });
    // The page notices the finished build on its ten-second refresh loop, and the test has just
    // made it drop one status poll and one refresh on purpose, so allow four cycles, not two.
    await page
      .getByRole("textbox", { name: "Profile", exact: true })
      .waitFor({ timeout: 45_000 });
    // The narrative outlives the build: collapsed on the Content tab, with what it cost.
    await page.getByRole("button", { name: "Show build log", exact: true }).click();
    const log = await page.getByRole("list", { name: "Build narrative", exact: true }).innerText();
    assert.match(log, /Saved as version \d{2}-[A-Z][a-z]{2}-V\d+/);
    assert.match(log, /Extracted 12 requirements/);
    assert.match(
      await page.getByText(/5 motions in /).last().innerText(),
      /5 motions in .+costing .{0,3}\$0\.28\./,
    );
    // What the build cost is beside the revision's name, not only inside the collapsed log.
    assert.match(
      await page.locator("p").filter({ hasText: /^Version \d{2}-[A-Z][a-z]{2}-V\d+ · / }).first().innerText(),
      /^Version \d{2}-[A-Z][a-z]{2}-V\d+ · 5 motions in .+costing .{0,3}\$0\.28\.$/,
    );

    // A build that stopped on something only the person can fix: what it was, and the way forward.
    const budgetFailure = {
      kind: "budget_exhausted",
      resolvedBy: "user",
      retryable: false,
      action: "raise_budget",
      message: "This build needs $3.06 and $1.20 is left of your $50.00 AI budget this month.",
      motion: "admit_budget",
      attempt: 1,
      maxAttempts: 3,
    };
    await pool.query(
      `insert into cv_drafts (id, user_id, job_title, company_name, job_description, library_version, library_snapshot, model, status, error, failure)
       values ($1, $2, 'Operations Director', 'Example', 'Lead a team and improve operations.', 1, $3, 'test', 'failed', $4, $5)`,
      [failedId, userId, JSON.stringify(library), budgetFailure.message, JSON.stringify(budgetFailure)],
    );
    await motion(failedId, 1, "preparing", "load_inputs", "Reading your Library and the role", "done", 60, 900, {
      libraryVersion: 1, roles: 2, qualifications: 1, skillBlocks: 1, descriptionCharacters: 42,
    });
    await motion(failedId, 2, "preparing", "admit_budget", "Reserving this build's share of your AI budget", "failed", 59, 200, {}, budgetFailure);
    await page.goto(`${baseUrl}/cv/${failedId}`);
    await page.getByRole("heading", { name: "Not enough AI budget", exact: true }).waitFor();
    const failureNotice = page.getByRole("alert").filter({ hasText: "Not enough AI budget" });
    const noticeText = await failureNotice.innerText();
    assert.match(noticeText, /\$1\.20 is left of your \$50\.00 AI budget this month/);
    assert.match(noticeText, /When you have done that, retry generation\./);
    assert.equal(
      await failureNotice.getByRole("link", { name: "Raise the AI budget", exact: true }).getAttribute("href"),
      "/settings",
    );
    // The retry is offered because this draft is failed and unfinalised, which is what the action needs.
    assert.equal(await failureNotice.getByRole("button", { name: "Retry generation", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Show build log", exact: true }).click();
    assert.match(
      await page.getByRole("list", { name: "Build narrative", exact: true }).innerText(),
      /Could not reserve this build's share of your AI budget/,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "the failed build's way forward must not overflow a phone viewport",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Exercise the production server actions through the applications table. The row is a
    // throwaway company this account follows and has shortlisted, with one ready CV for it, so
    // archiving that CV leaves the role on the table with a predecessor to restore.
    await pool.query(
      `insert into companies (id, name, homepage_url, domain) values ($1, 'CV Table Check', 'https://cvtable.invalid', $2)`,
      [tableCompanyId, TABLE_DOMAIN],
    );
    await pool.query(
      `insert into career_sources (id, company_id, type, url) values ($1, $2, 'html', 'https://cvtable.invalid/jobs')`,
      [tableSourceId, tableCompanyId],
    );
    await pool.query(
      `insert into jobs (id, company_id, source_id, external_key, title, normalized_title, url)
       values ($1, $2, $3, 'table-role', 'Table role 1', 'table role 1', 'https://cvtable.invalid/jobs/1')`,
      [tableJobId, tableCompanyId, tableSourceId],
    );
    await pool.query(
      "insert into company_subscriptions (user_id, company_id) values ($1, $2) on conflict do nothing",
      [userId, tableCompanyId],
    );
    await pool.query(
      "insert into user_jobs (user_id, job_id, in_table, keyword_matched) values ($1, $2, true, true)",
      [userId, tableJobId],
    );
    await pool.query(
      `insert into decisions (user_id, job_id, decision, reason, job_title, company_name)
       values ($1, $2, 'apply', '', 'Table role 1', 'CV Table Check')`,
      [userId, tableJobId],
    );
    await pool.query(
      `insert into cv_drafts (id, user_id, job_id, job_title, company_name, job_description, library_version, library_snapshot, model, status, revision)
       values ($1, $2, $3, 'Table role 1', 'CV Table Check', 'Synthetic table test', 1, $4, 'test', 'ready', 1)`,
      [tableIds[0], userId, tableJobId, JSON.stringify(library)],
    );

    await page.goto(`${baseUrl}/applications`);
    await page.getByRole("heading", { name: "Applications", exact: true }).waitFor();
    // One sidebar entry for applications and CVs, and no section tabs underneath it any more.
    const mainNav = page.getByRole("navigation", { name: "Main navigation" });
    assert.equal(await mainNav.getByRole("link", { name: "Applications", exact: true }).count(), 1);
    assert.equal(await mainNav.getByRole("link", { name: "Applications", exact: true }).getAttribute("aria-current"), "page");
    assert.equal(await mainNav.getByRole("link", { name: "CVs", exact: true }).count(), 0);
    assert.equal(await page.getByRole("navigation", { name: "Workspace sections" }).count(), 0);
    const segments = page.getByRole("navigation", { name: "Application progress", exact: true });
    for (const segment of ["Active", "Closed", "All"]) assert.equal(await segments.getByRole("link", { name: new RegExp(`^${segment} `) }).count(), 1);

    const tableRow = () => page.getByRole("row").filter({ hasText: "Table role 1" });
    await tableRow().waitFor();
    // A shortlisted role with a live CV is Applying, and the CV cell says which revision.
    assert.match(await tableRow().innerText(), /Applying/i);
    assert.match(await tableRow().innerText(), /Ready · V1/);
    await tableRow().getByRole("button", { name: "Table role 1", exact: true }).click();
    const expansion = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Archive CV", exact: true }) });
    await expansion.waitFor();
    assert.equal(await expansion.getByRole("combobox", { name: "Where it stands", exact: true }).count(), 1);
    await page.screenshot({
      path: "tmp/cv-review-tabs/applications-desktop.png",
      fullPage: true,
    });

    // Archive, restore and delete, one row at a time, through the same action the CV list used.
    await expansion.getByRole("button", { name: "Archive CV", exact: true }).click();
    await page.getByRole("button", { name: "Restore previous CV", exact: true }).waitFor();
    assert.match(await tableRow().innerText(), /previous archived/);
    assert.equal(
      (await pool.query("select count(*)::int n from cv_drafts where id = any($1::uuid[]) and archived_at is not null", [tableIds])).rows[0].n,
      1,
    );
    await page.getByRole("button", { name: "Restore previous CV", exact: true }).click();
    await page.getByRole("link", { name: "Ready · V1", exact: true }).waitFor().catch(async (error) => {
      throw new Error(
        `${error.message}\nTable state: ${await page.locator("main").innerText()}\nRows: ${JSON.stringify((await pool.query("select id,status,archived_at from cv_drafts where id = any($1::uuid[])", [tableIds])).rows)}`,
      );
    });
    assert.equal(
      (await pool.query("select count(*)::int n from cv_drafts where id = any($1::uuid[]) and archived_at is null", [tableIds])).rows[0].n,
      1,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      "the applications table must not overflow a phone viewport",
    );
    await page.screenshot({
      path: "tmp/cv-review-tabs/applications-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Deleting asks first, and a dismissed confirm leaves the CV exactly where it was.
    const cancelledDeletion = new Promise((resolve, reject) =>
      page.once("dialog", (dialog) => { dialog.dismiss().then(resolve, reject); }),
    );
    await page.getByRole("button", { name: "Delete CV", exact: true }).click();
    await cancelledDeletion;
    assert.equal(
      (await pool.query("select count(*)::int n from cv_drafts where id = any($1::uuid[])", [tableIds])).rows[0].n,
      1,
    );
    const confirmedDeletion = new Promise((resolve, reject) =>
      page.once("dialog", (dialog) => { dialog.accept().then(resolve, reject); }),
    );
    await page.getByRole("button", { name: "Delete CV", exact: true }).click();
    await confirmedDeletion;
    // With no CV the role falls back to Shortlisted and offers to build one.
    await tableRow().getByRole("button", { name: "Build CV", exact: true }).waitFor({ timeout: 60_000 }).catch(async (error) => {
      throw new Error(
        `${error.message}\nDelete UI: ${await page.locator("main").innerText()}\nErrors: ${JSON.stringify(errors)}\nRows: ${JSON.stringify((await pool.query("select id,status,archived_at from cv_drafts where id = any($1::uuid[])", [tableIds])).rows)}`,
      );
    });
    assert.match(await tableRow().innerText(), /Shortlisted/i);
    assert.equal(
      (await pool.query("select count(*)::int n from cv_drafts where id = any($1::uuid[])", [tableIds])).rows[0].n,
      0,
    );

    // 4.7: the one page that renders without a session. The link is one revision, read-only,
    // and a note left on it reaches the owner; a token nobody issued gets the same sentence as an
    // expired one. cv_shares cascades from cv_drafts, so the cleanup below takes the row with it.
    const shareToken = randomBytes(32).toString("base64url");
    await pool.query(
      `insert into cv_shares (user_id, draft_id, token_hash, allow_comments, expires_at)
       values ($1, $2, $3, true, now() + interval '14 days')`,
      [userId, readyId, createHash("sha256").update(shareToken).digest("hex")],
    );
    const shared = await fetch(`${baseUrl}/share/${shareToken}`, { redirect: "manual" });
    assert.equal(shared.status, 200, "the share page must render without a session");
    assert.match(shared.headers.get("cache-control") ?? "", /no-store/);
    const sharedHtml = await shared.text();
    for (const needle of ["Shared CV", "Example Candidate", "Comment on this", "This page shows one saved revision"])
      assert.ok(sharedHtml.includes(needle), `the share page does not say "${needle}"`);
    const posted = await fetch(`${baseUrl}/share/${shareToken}/comments`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ anchor: "cv-content-profile", authorName: "Smoke Reader", body: "A note from the smoke." }),
    });
    assert.equal(posted.status, 303, "a note must be accepted and answered with a redirect");
    assert.match(posted.headers.get("location") ?? "", /thanks=1/);
    const gone = await fetch(`${baseUrl}/share/${randomBytes(32).toString("base64url")}`, { redirect: "manual" });
    assert.equal(gone.status, 200);
    assert.ok((await gone.text()).includes("This link has expired or was withdrawn."));

    assert.deepEqual(errors, []);
    console.log(
      "  CV browser flow passed: tabs, unified evaluation, keyboard navigation, full sidebar collapse, saved edits, mobile layout, real progress updates, the build narrative and its log, what the two saves cost, why finalising is unavailable, a failed build's way forward, the Library's ready-to-build line, Confirm all, its unsaved-changes bar and guard, and the applications table's stage, CV cell and archive/restore/delete, and a share link read without a session with a note left on it",
    );
  } finally {
    await browser?.close();
    await pool.query("delete from cv_drafts where id = any($1::uuid[])", [
      tableIds,
    ]);
    // The throwaway role goes with its company: sources, jobs and views cascade from it.
    await pool.query("delete from applications where user_id = $1 and job_id = $2", [userId, tableJobId]);
    await pool.query("delete from decisions where user_id = $1 and job_id = $2", [userId, tableJobId]);
    await pool.query("delete from companies where domain = $1", [TABLE_DOMAIN]);
    await pool.query(
      "delete from tasks where payload->>'draftId' in (select id::text from cv_drafts where id in ($1, $2, $3) or parent_id = $1)",
      [readyId, busyId, failedId],
    );
    // cv_build_steps rows go with their draft.
    await pool.query(
      "delete from cv_drafts where id in ($1, $2, $3) or parent_id = $1",
      [readyId, busyId, failedId],
    );
    for (const [key, original] of [["cvModel", originalCvModel], ["cvWritingPreferences", originalWriting], ["cvTheme", originalCvTheme]]) {
      if (original) await pool.query("insert into user_settings (user_id, key, value) values ($1, $2, $3) on conflict (user_id, key) do update set value = excluded.value", [userId, key, JSON.stringify(original.value)]);
      else await pool.query("delete from user_settings where user_id = $1 and key = $2", [userId, key]);
    }
    await pool.end();
  }
}
