import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const { Pool } = createRequire(new URL("../apps/web/package.json", import.meta.url))("pg");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");

async function waitForRow(pool, id, check) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = (await pool.query("select applied_on, notes, next_action, next_action_on, history from applications where id = $1", [id])).rows[0];
    if (row && check(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  throw new Error(`Application ${id} did not save within five seconds`);
}

/** Browser → status action → persisted application, using disposable records without a CV. */
export async function verifyApplicationsWorkspace(baseUrl, cookie, databaseUrl, userId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const appliedId = randomUUID();
  const interviewId = randomUUID();
  const appliedDay = "2026-09-21";
  let browser;
  try {
    await pool.query(
      `insert into applications (id, user_id, job_title, company_name, applied_on, status, notes, next_action, next_action_on, history)
       values ($1, $3, 'Smoke applied role', 'Smoke Applications', $4, 'applied', 'Keep this note', 'Call recruiter', '2026-10-09', $5::jsonb),
              ($2, $3, 'Smoke interview role', 'Smoke Applications', null, 'interview', '', null, null, $6::jsonb)`,
      [appliedId, interviewId, userId, appliedDay,
        JSON.stringify([{ status: "applied", at: "2026-09-21T09:00:00.000Z", notes: "Keep this note", on: appliedDay }]),
        JSON.stringify([{ status: "interview", at: "2026-09-22T09:00:00.000Z", notes: "" }])],
    );

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${baseUrl}/applications`);

    const appliedRow = page.locator("tr").filter({ hasText: "Smoke applied role" }).first();
    await appliedRow.getByRole("button", { name: "Update", exact: true }).click();
    const appliedDetailsId = await appliedRow.getByRole("button", { name: "Update", exact: true }).getAttribute("aria-controls");
    assert.ok(appliedDetailsId);
    const appliedDetails = page.locator(`[id="${appliedDetailsId}"]`);
    const appliedForm = appliedDetails.locator("form").filter({ has: page.getByRole("button", { name: "Save update" }) });
    await appliedForm.getByRole("button", { name: "Edit next step" }).click();
    await appliedForm.getByRole("textbox", { name: "Next step" }).fill("Email recruiter on Friday");
    await appliedForm.getByRole("button", { name: "Save update" }).click();
    const applied = await waitForRow(pool, appliedId, row => row.next_action === "Email recruiter on Friday");
    await appliedForm.getByRole("button", { name: "Save update" }).waitFor();
    assert.equal(applied.applied_on, appliedDay, "editing a reminder preserves the application date");
    assert.equal(applied.notes, "Keep this note", "hidden notes are retained");
    assert.equal(applied.next_action, "Email recruiter on Friday");
    assert.equal(applied.next_action_on, "2026-10-09", "the reminder date is retained");
    assert.equal(applied.history.length, 1, "editing a reminder does not invent a stage event");

    const interviewRow = page.locator("tr").filter({ hasText: "Smoke interview role" }).first();
    await interviewRow.getByRole("button", { name: "Update", exact: true }).click();
    const interviewDetailsId = await interviewRow.getByRole("button", { name: "Update", exact: true }).getAttribute("aria-controls");
    assert.ok(interviewDetailsId);
    const interviewForm = page.locator(`[id="${interviewDetailsId}"] form`);
    await interviewForm.locator('input[name="on"]').fill("2026-10-04");
    await interviewForm.getByRole("button", { name: "Save update" }).click();
    const interview = await waitForRow(pool, interviewId, row => row.history.at(-1)?.on === "2026-10-04");
    await interviewForm.getByRole("button", { name: "Save update" }).waitFor();
    assert.equal(interview.applied_on, null, "an interview does not invent an application date");
    assert.equal(interview.history.at(-1)?.on, "2026-10-04", "the interview date belongs to the history entry");

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.reload();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
        `applications must not overflow a ${width}px viewport`);
      const appliedCard = page.locator('[aria-label="Applications"] article').filter({ hasText: "Smoke applied role" }).first();
      const update = appliedCard.locator("button").filter({ hasText: /^Update$/ });
      try { await update.waitFor({ state: "visible", timeout: 5000 }); }
      catch {
        const state = await appliedCard.evaluate(element => ({
          display: getComputedStyle(element).display,
          parentDisplay: getComputedStyle(element.parentElement).display,
          buttons: [...element.querySelectorAll("button")].map(button => ({ text: button.textContent, display: getComputedStyle(button).display,
            visibility: getComputedStyle(button).visibility, rect: button.getBoundingClientRect().toJSON(), html: button.outerHTML.slice(0, 220) })),
        }));
        throw new Error(`Update must be visible at ${width}px; viewport ${await page.evaluate(() => innerWidth)}, cards ${await page.locator('[aria-label="Applications"] article').count()}, state ${JSON.stringify(state)}`);
      }
      const box = await update.boundingBox();
      assert.ok(box && box.height >= 44 && box.width >= 44, `Update needs a 44px target at ${width}px`);
      await update.click();
      await appliedCard.getByRole("button", { name: "Edit next step" }).click();
      await appliedCard.getByRole("textbox", { name: "Next step" }).fill(`Unsaved at ${width}px`);
      page.once("dialog", dialog => dialog.dismiss());
      await page.locator('[aria-label="Applications"] article').filter({ hasText: "Smoke interview role" }).first()
        .locator("button").filter({ hasText: /^Update$/ }).click();
      assert.equal(await appliedCard.getByRole("textbox", { name: "Next step" }).inputValue(), `Unsaved at ${width}px`,
        "cancelling a row switch keeps the entered value");
      assert.equal(await appliedCard.getByRole("button", { name: "Save update" }).isVisible(), true);
    }
    assert.deepEqual(errors, [], "applications browser flow has no page errors");
    console.log("  applications status and mobile flow passed");
  } finally {
    await browser?.close();
    await pool.query("delete from applications where id = any($1::uuid[])", [[appliedId, interviewId]]);
    await pool.end();
  }
}
