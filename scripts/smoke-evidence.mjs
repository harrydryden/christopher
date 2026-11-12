import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const { Pool } = createRequire(new URL("../apps/web/package.json", import.meta.url))("pg");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");

/** A person's own career fact is usable after one save, with history and no model call. */
export async function verifyEvidenceConversation(baseUrl, cookie, databaseUrl, userId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let browser;
  try {
    const before = await pool.query(`select
      (select count(*)::integer from ai_calls where user_id = $1) as calls,
      (select count(*)::integer from credit_ledger where user_id = $1) as credits,
      (select count(*)::integer from tasks where payload->>'userId' = $1::text) as tasks,
      (select coalesce(max(version), 0)::integer from cv_libraries where user_id = $1) as version`, [userId]);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${baseUrl}/library`);
    const career = page.getByRole("region", { name: "Career record" });
    await career.getByRole("textbox", { name: "Name or title", exact: true }).fill("Evidence Smoke Service Lead");
    await career.getByRole("button", { name: "Add to Experience", exact: true }).click();
    await career.getByRole("heading", { name: "Evidence Smoke Service Lead", exact: true }).waitFor();
    const recordId = new URL(page.url()).searchParams.get("record");
    assert.ok(recordId, "new work has a stable record identity");
    const story = career.getByRole("textbox", { name: "Your original story", exact: true });
    await story.fill("I coordinated the handover team during a service launch.");
    await story.blur();
    await career.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    const answer = "I brought the handover team together and reduced missed requests.";
    await career.getByRole("textbox", { name: "Add a detail", exact: true }).fill(answer);
    const save = career.getByRole("button", { name: "Save detail · free", exact: true });
    const screenshotDir = process.env.SMOKE_SCREENSHOT_DIR ? resolve(process.env.SMOKE_SCREENSHOT_DIR) : null;
    const measureOverflow = () => page.evaluate(() => ({ viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth, fonts: document.fonts.status,
      offenders: [...document.querySelectorAll("*")].flatMap(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.right > innerWidth + 1 ? [{ tag: element.tagName,
          className: typeof element.className === "string" ? element.className.slice(0, 120) : "",
          text: element.textContent?.trim().slice(0, 80), left: Math.round(rect.left),
          right: Math.round(rect.right), width: Math.round(rect.width),
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }] : [];
      }).sort((a, b) => b.right - a.right).slice(0, 12),
    }));
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await measureOverflow();
      if (overflow.documentWidth > overflow.viewport) {
        await page.evaluate(() => document.fonts.ready);
        const afterFonts = await measureOverflow();
        console.error(`Career capture overflow at ${width}px:`, JSON.stringify({ beforeFonts: overflow, afterFonts }));
      }
      assert.equal(overflow.documentWidth > overflow.viewport, false,
        `career fact capture must fit a ${width}px phone viewport`);
      const titleWidth = await career.getByRole("textbox", { name: "Name or title", exact: true })
        .evaluate(element => element.getBoundingClientRect().width);
      assert.ok(titleWidth >= 160, `Name or title needs a usable field width at ${width}px (got ${titleWidth}px)`);
      const box = await save.boundingBox();
      assert.ok(box && box.height >= 44 && box.width >= 44, `Save detail needs a 44px target at ${width}px`);
      if (screenshotDir) { await mkdir(screenshotDir, { recursive: true });
        await page.screenshot({ path: join(screenshotDir, `evidence-direct-${width}.png`), fullPage: true }); }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await save.click();
    await career.getByRole("textbox", { name: "Saved detail", exact: true }).waitFor();
    const saved = await pool.query(`select text, status, provenance->>'kind' as provenance_kind
      from career_assertions where user_id = $1 and subject_id = $2 and text = $3`, [userId, recordId, answer]);
    assert.deepEqual(saved.rows, [{ text: answer, status: "usable", provenance_kind: "direct_user" }]);
    assert.equal(await career.getByRole("button", { name: "Confirm all", exact: true }).count(), 0);
    await page.reload();
    assert.equal(await career.getByRole("textbox", { name: "Saved detail", exact: true }).inputValue(), answer);
    const final = await pool.query(`select
      (select count(*)::integer from ai_calls where user_id = $1) as calls,
      (select count(*)::integer from credit_ledger where user_id = $1) as credits,
      (select count(*)::integer from tasks where payload->>'userId' = $1::text) as tasks,
      (select coalesce(max(version), 0)::integer from cv_libraries where user_id = $1) as version`, [userId]);
    assert.equal(final.rows[0].calls, before.rows[0].calls, "direct capture makes no provider call");
    assert.equal(final.rows[0].credits, before.rows[0].credits, "direct capture spends no credits");
    assert.equal(final.rows[0].tasks, before.rows[0].tasks, "direct capture queues no model task");
    assert.ok(final.rows[0].version > before.rows[0].version, "career facts publish a new Library compatibility version");

    // Account keeps the plan readout first; links jump to the visible purchase and plan tasks.
    // The controls are inspected only; this smoke never starts a checkout.
    await page.goto(`${baseUrl}/account`);
    await page.getByRole("heading", { name: "Plan and credits" }).waitFor();
    await page.getByRole("link", { name: "Top up role credits", exact: true }).click();
    const topUps = page.locator("section#top-ups");
    assert.equal(new URL(page.url()).hash, "#top-ups");
    assert.equal(await topUps.getByRole("heading", { name: "Top up role credits" }).isVisible(), true);
    assert.equal(await topUps.getByRole("button", { name: "Buy 5" }).isVisible(), true);
    await page.getByRole("link", { name: "Compare plans", exact: true }).click();
    const plans = page.locator("section#plans");
    assert.equal(await plans.getByRole("heading", { name: "Compare plans" }).isVisible(), true);
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
      assert.equal(await page.getByRole("textbox", { name: "Location" }).isVisible(), true,
        `role location stays visible at ${width}px`);
      assert.equal(await page.getByRole("spinbutton", { name: "Min fit" }).isVisible(), true,
        `minimum fit stays visible at ${width}px`);
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
    }
    assert.deepEqual(errors, [], "browser console page errors");
    console.log("  career evidence: direct fact saved without confirmation or model work; account and phone controls checked");
  } finally {
    await browser?.close();
    await pool.end();
  }
}
