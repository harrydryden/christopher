import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import "tsx/esm";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { createDb, getCareerWorkspace, saveCareerChange, listCareerReviewIssues } = require("../packages/db/src/index.ts");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");

/** An owned conflicting pair remains advisory while its saved review choices survive reload. */
export async function verifyCareerReview(baseUrl, cookie, databaseUrl, userId) {
  const { db, pool } = createDb(databaseUrl);
  let browser;
  let page;
  const screenshotDir = process.env.SMOKE_SCREENSHOT_DIR ? resolve(process.env.SMOKE_SCREENSHOT_DIR) : null;
  try {
    const beforeWork = (await pool.query(`select
      (select count(*)::int from ai_calls where user_id=$1) calls,
      (select count(*)::int from credit_reservations where user_id=$1) credits`, [userId])).rows[0];
    const recordId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const current = await getCareerWorkspace(db, userId);
    const created = await saveCareerChange(db, userId, { expectedRevision: current.revision, requestKey: randomUUID(), operations: [
      { type: "create_record", id: recordId, kind: "role", fields: { title: "Review smoke work", originalNarrative: "Led a service team.",
        dates: { start: "2023", end: null, current: true }, arrangement: "employment", publicLabel: null, confidential: false, industries: [] } },
      { type: "add_assertion", id: firstId, subjectId: recordId, text: "Led 12 people", publicText: null,
        facets: ["metric"], context: { attribute: "team size", scope: "London", period: "2024", value: "12" } },
      { type: "add_assertion", id: secondId, subjectId: recordId, text: "Led 18 people", publicText: null,
        facets: ["metric"], context: { attribute: "team size", scope: "London", period: "2024", value: "18" } },
    ] });
    assert.equal(created.ok, true, "factual source pair saves without a review gate");
    const listed = await listCareerReviewIssues(db, userId, { status: "active" });
    const issue = listed.items.find(item => item.subjectId === recordId);
    assert.ok(issue, "the structured difference appears in the account review list");

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: "col_session", value: cookie.slice("col_session=".length), url: baseUrl }]);
    page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/library/review?conflict=${issue.id}`);
    await page.getByRole("heading", { name: "Review Experience details" }).waitFor();
    const nav = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Experience", exact: true });
    assert.match(await nav.innerText(), /Experience\s+\d+/, "active issue count appears quietly in Experience navigation");
    assert.equal(await page.getByText("Led 12 people", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Led 18 people", { exact: true }).count(), 1);
    const openChoices = async () => { const button = page.getByRole("button", { name: "Decide how to use these statements" });
      if (await button.count()) await button.click(); };

    // A correction drafted against an old group must fail safely, leaving the typed value intact.
    await openChoices();
    await page.getByRole("button", { name: "Correct the details" }).click();
    await page.getByLabel("Correct wording").fill("Led 14 people");
    const latest = await getCareerWorkspace(db, userId, { recordId, assertionId: secondId });
    const second = latest.selected.assertions.find(row => row.id === secondId);
    assert.ok(second);
    const changed = await saveCareerChange(db, userId, { expectedRevision: latest.revision, requestKey: randomUUID(), operations: [
      { type: "edit_assertion", id: secondId, expectedRevision: second.revision, text: "Led 19 people", publicText: null,
        facets: ["metric"], context: { attribute: "team size", scope: "London", period: "2024", value: "19" } },
    ] });
    assert.equal(changed.ok, true);
    await page.getByRole("button", { name: "Save correction" }).click();
    await page.getByRole("alert").filter({ hasText: "These statements changed" }).waitFor();
    assert.equal(await page.getByLabel("Correct wording").inputValue(), "Led 14 people");
    await page.getByRole("button", { name: "Refresh saved review" }).click();
    await page.getByText("Your draft is still here", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("Correct wording").inputValue(), "Led 14 people");
    await page.getByRole("button", { name: "Discard draft and open the updated review" }).click();

    await page.getByRole("button", { name: "Review later" }).click();
    await page.getByRole("link", { name: /^Later · / }).waitFor();
    await page.getByRole("link", { name: /^Later · / }).click();
    await page.waitForURL(/status=deferred/);
    await page.reload();
    await page.getByRole("link", { name: "Review smoke work", exact: false }).waitFor();
    await openChoices();
    await page.getByRole("button", { name: "Restore to review" }).click();
    await page.getByRole("link", { name: /^To review · / }).waitFor();
    await page.getByRole("link", { name: /^To review · / }).click();
    await page.waitForURL(/status=active/);
    await openChoices();
    await page.getByRole("button", { name: "Use this statement for future CVs" }).first().click();
    await page.getByText("No details need a decision", { exact: false }).waitFor();
    await page.getByRole("link", { name: "Decision history" }).click();
    await page.waitForURL(/status=decided/);
    await page.getByRole("link", { name: "Review smoke work", exact: false }).waitFor();
    await openChoices();
    await page.getByRole("button", { name: "Not a conflict" }).click();
    await page.getByText("Saved decision: Not a conflict.").waitFor();
    await page.reload();
    await page.getByText("Saved decision: Not a conflict.").waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "review fits a 390px screen");
    if (screenshotDir) { await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, "career-review-390.png"), fullPage: true }); }
    await page.goto(`${baseUrl}/applications`);
    await page.getByRole("heading", { name: "Applications" }).waitFor();
    const afterWork = (await pool.query(`select
      (select count(*)::int from ai_calls where user_id=$1) calls,
      (select count(*)::int from credit_reservations where user_id=$1) credits`, [userId])).rows[0];
    assert.deepEqual(afterWork, beforeWork, "reviewing Experience does not call a model or reserve a credit");
    assert.deepEqual(pageErrors, [], "review journey has no browser errors");
    console.log("  Experience review: counted issue, durable Later/restore/choices, stale correction recovery and phone layout verified");
  } catch (error) {
    if (screenshotDir && page) { await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, "career-review-failure.png"), fullPage: true }).catch(() => {}); }
    throw error;
  } finally {
    await browser?.close();
    await pool.end();
  }
}
