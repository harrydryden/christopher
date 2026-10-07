import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const { Pool } = createRequire(new URL("../apps/web/package.json", import.meta.url))("pg");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");

/** A browser answer must remain a review until the person confirms its exact saved wording. */
export async function verifyEvidenceConversation(baseUrl, cookie, databaseUrl, userId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const jobId = randomUUID();
  const job = { id: jobId, company: "Evidence Smoke", jobTitle: "Service Lead", startDate: "2022-01", endDate: "", current: true };
  const library = { name: "Evidence Smoke Candidate", contact: "London", profile: "", structuredExperience: true,
    employment: [job], entries: [] };
  let browser;
  try {
    const latest = await pool.query("select coalesce(max(version), 0)::integer as version from cv_libraries where user_id = $1", [userId]);
    const baseVersion = latest.rows[0].version + 1;
    await pool.query("insert into cv_libraries (user_id, version, content) values ($1, $2, $3)",
      [userId, baseVersion, JSON.stringify(library)]);
    const before = await pool.query(`select
      (select count(*)::integer from ai_calls where user_id = $1) as calls,
      (select count(*)::integer from credit_ledger where user_id = $1) as credits,
      (select count(*)::integer from tasks where type = 'draft_evidence' and payload->>'userId' = $1::text) as draft_tasks`, [userId]);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${baseUrl}/library?job=${jobId}`);
    const jobCard = page.locator(`section[data-job-id="${jobId}"]`);
    const question = jobCard.getByRole("region", { name: "Evidence question" });
    await question.getByText("What result did your work produce in this job, and what did you do to help achieve it?").waitFor();

    // A rough answer survives an explicit skip and a full browser reload.
    const rough = "I need to check the figures before describing the result.";
    await question.getByRole("textbox", { name: "Your answer" }).fill(rough);
    await question.getByRole("button", { name: "Nothing further" }).click();
    await question.getByText("Nothing further for this question.").waitFor();
    await page.reload();
    await question.getByText("Nothing further for this question.").waitFor();
    await question.getByRole("button", { name: "Return to this question" }).click();
    assert.equal(await question.getByRole("textbox", { name: "Your answer" }).inputValue(), rough);

    // The manual route opens a separate wording review. Editing it is a deliberate choice; the
    // saved row must contain exactly that edit, rather than the rough answer or model output.
    const answer = "I brought the handover team together and reduced missed requests.";
    const exact = "Reduced missed requests by bringing the handover team together.";
    await question.getByRole("textbox", { name: "Your answer" }).fill(answer);
    await question.getByRole("button", { name: "Use my answer as written" }).click();
    const wording = question.getByRole("textbox", { name: "Wording to save" });
    assert.equal(await wording.inputValue(), answer);
    await wording.fill(exact);
    const screenshotDir = process.env.SMOKE_SCREENSHOT_DIR ? resolve(process.env.SMOKE_SCREENSHOT_DIR) : null;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, "evidence-review-desktop.png"), fullPage: true });
    }
    const confirm = question.getByRole("button", { name: "Confirm and save to Service Lead at Evidence Smoke" });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
        `evidence review must fit a ${width}px phone viewport`);
      assert.equal(await confirm.isVisible(), true, `the confirmation must be visible at ${width}px`);
      const box = await confirm.boundingBox();
      assert.ok(box && box.height >= 44 && box.width >= 44, `the confirmation needs a 44px target at ${width}px`);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `evidence-review-${width}.png`), fullPage: true });
    }
    // The adjacent evidence guide uses a native disclosure and stays keyboard operable.
    const guide = jobCard.locator("details").filter({ has: page.locator("summary", { hasText: "Evidence guide and scores" }) }).first();
    const guideSummary = guide.locator("summary");
    await guideSummary.focus();
    await guideSummary.press("Enter");
    assert.equal(await guide.getAttribute("open"), "", "Enter opens the evidence guide");
    await guideSummary.press("Enter");
    assert.equal(await guide.getAttribute("open"), null, "Enter closes the evidence guide");
    await page.setViewportSize({ width: 1280, height: 900 });
    const beforeConfirm = await pool.query("select max(version)::integer as version from cv_libraries where user_id = $1", [userId]);
    assert.equal(beforeConfirm.rows[0].version, baseVersion, "review must not save a row");
    await confirm.click();
    await page.getByText(exact, { exact: true }).waitFor();
    await question.getByText("What challenge did you face in this job, and how did you work through it?").waitFor();

    const saved = await pool.query("select version, content from cv_libraries where user_id = $1 order by version desc limit 1", [userId]);
    assert.equal(saved.rows[0].version, baseVersion + 1);
    const entry = saved.rows[0].content.entries.find(item => item.employmentId === jobId);
    assert.ok(entry, "confirmed answer creates an Experience entry");
    assert.equal(entry.details, exact);
    assert.deepEqual(entry.confirmedResponsibilities, [exact]);
    assert.deepEqual(entry.rowFacets?.[exact], ["outcome"]);
    assert.equal(JSON.stringify(saved.rows[0].content).includes(answer), false, "the unconfirmed answer is not saved");
    const accepted = await pool.query("select status, accepted_wording, accepted_version from evidence_drafts where user_id = $1 and input->>'questionId' = $2 order by updated_at desc limit 1",
      [userId, `job:${jobId}:outcome`]);
    assert.deepEqual(accepted.rows[0], { status: "accepted", accepted_wording: exact, accepted_version: baseVersion + 1 });

    // The next default question advances from result to way of working, and its dismissal survives
    // another reload. Returning leaves the question available without writing a new version.
    await question.getByRole("button", { name: "Nothing further" }).click();
    await question.getByText("Nothing further for this question.").waitFor();
    await page.reload();
    await question.getByText("Nothing further for this question.").waitFor();
    await question.getByRole("button", { name: "Return to this question" }).click();
    await question.getByRole("textbox", { name: "Your answer" }).waitFor();
    const final = await pool.query(`select
      (select count(*)::integer from ai_calls where user_id = $1) as calls,
      (select count(*)::integer from credit_ledger where user_id = $1) as credits,
      (select count(*)::integer from tasks where type = 'draft_evidence' and payload->>'userId' = $1::text) as draft_tasks,
      (select max(version)::integer from cv_libraries where user_id = $1) as version`, [userId]);
    assert.equal(final.rows[0].calls, before.rows[0].calls, "manual confirmation must make no provider call");
    assert.equal(final.rows[0].credits, before.rows[0].credits, "manual confirmation must spend no credits");
    assert.equal(final.rows[0].draft_tasks, before.rows[0].draft_tasks, "manual confirmation must not queue model drafting");
    assert.equal(final.rows[0].version, baseVersion + 1, "skipping and returning must not write Experience");

    // Account keeps the plan readout first and its links reveal the matching native disclosures.
    // The controls are inspected only; this smoke never starts a checkout.
    await page.goto(`${baseUrl}/account`);
    await page.getByRole("heading", { name: "Plan and credits" }).waitFor();
    await page.getByRole("link", { name: "Top up CV credits", exact: true }).click();
    const topUps = page.locator("details#top-ups");
    assert.equal(new URL(page.url()).hash, "#top-ups");
    await page.waitForFunction(() => document.querySelector("details#top-ups")?.open === true);
    assert.equal(await topUps.getAttribute("open"), "", "the top-up link opens its disclosure");
    await page.getByRole("link", { name: "Compare plans", exact: true }).click();
    const plans = page.locator("details#plans");
    await page.waitForFunction(() => document.querySelector("details#plans")?.open === true);
    assert.equal(await plans.getAttribute("open"), "", "the compare link opens its disclosure");
    assert.match(await plans.locator("div.grid > div").first().innerText(), /Free[\s\S]*Current/, "the current plan appears first");
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "account-plan-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      "account billing details must fit a phone viewport");
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "account-plan-390.png"), fullPage: true });

    // The Availability choices stay on screen on phones; the workspace menu closes on Escape and
    // restores focus to its trigger. Advanced filters can be reached without a wide table.
    await page.goto(baseUrl);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const availability = page.getByRole("group", { name: "Availability" });
      await availability.getByRole("checkbox", { name: "Newly opened" }).waitFor();
      assert.equal(await availability.isVisible(), true, `Availability stays visible at ${width}px`);
      const filters = page.getByRole("button", { name: "Filters", exact: true });
      await filters.click();
      assert.equal(await page.getByRole("textbox", { name: "Location" }).isVisible(), true,
        `advanced role filters open at ${width}px`);
      const sortWidth = await page.getByRole("combobox", { name: "Sort by" }).evaluate(element => element.getBoundingClientRect().width);
      assert.ok(sortWidth >= 160, `the Sort by value and chevron need 160px at ${width}px`);
      for (const name of ["Sort by", "Direction"]) {
        const padding = await page.getByRole("combobox", { name }).evaluate(element => parseFloat(getComputedStyle(element).paddingRight));
        assert.ok(padding >= 32, `${name} must reserve 32px for its chevron at ${width}px`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
        `Roles must fit a ${width}px phone viewport`);
      const menu = page.locator('button[aria-controls="workspace-menu"]');
      await menu.click();
      assert.equal(await menu.getAttribute("aria-expanded"), "true");
      await menu.press("Escape");
      assert.equal(await menu.getAttribute("aria-expanded"), "false", "Escape closes the phone menu");
      assert.equal(await menu.evaluate(element => element === document.activeElement), true,
        "Escape returns focus to the menu button");
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `roles-filters-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "Hide filters", exact: true }).click();
    }
    assert.deepEqual(errors, [], "browser console page errors");
    console.log(`  evidence conversation: exact wording saved as version ${baseVersion + 1}; question advanced and skip resumed; account and phone controls checked`);
  } finally {
    await browser?.close();
    await pool.end();
  }
}
