import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

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
  const emptyCompanyId = randomUUID();
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
    await pool.query(
      "insert into companies (id, name, domain, homepage_url) values ($1, 'Smoke empty company', $2, $3)",
      [emptyCompanyId, `smoke-empty-${emptyCompanyId}.invalid`, `https://smoke-empty-${emptyCompanyId}.invalid`],
    );

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${baseUrl}/applications`);

    const shots = "/tmp/col-opportunity-browser";
    await mkdir(shots, { recursive: true });
    assert.equal(await page.getByRole("group", { name: "Progress" }).getByRole("link", { name: /^Active / }).getAttribute("aria-current"), "page");
    assert.equal(await page.getByRole("link", { name: "Add a role", exact: true }).getAttribute("href"), "/applications/new");
    await page.locator("tr").filter({ hasText: "Smoke applied role" }).first().waitFor();
    await page.screenshot({ path: `${shots}/applications-populated-desktop.png`, fullPage: true });
    await page.goto(`${baseUrl}/applications?filter=all&stage=accepted&company=${emptyCompanyId}`);
    await page.getByRole("heading", { name: "No accepted roles" }).waitFor();
    assert.equal(await page.getByRole("group", { name: "Application stages" }).getByRole("link", { name: /^Accepted / }).getAttribute("aria-current"), "page");
    assert.equal(await page.getByRole("group", { name: "Progress" }).getByRole("link", { name: /^All / }).getAttribute("aria-current"), null);
    await page.screenshot({ path: `${shots}/applications-filtered-empty-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole("heading", { name: "No accepted roles" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      "filtered applications must not overflow a 320px viewport");
    await page.screenshot({ path: `${shots}/applications-filtered-empty-320.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("link", { name: "View applications" }).click();
    await page.waitForURL(url => !url.searchParams.has("stage") && url.searchParams.get("company") === emptyCompanyId);
    assert.equal(new URL(page.url()).searchParams.get("stage"), null, "clearing a stage retains the company scope");
    assert.equal(new URL(page.url()).searchParams.get("company"), emptyCompanyId);
    await page.getByRole("link", { name: "Show all companies" }).first().click();
    await page.waitForURL(url => !url.searchParams.has("company") && !url.searchParams.has("stage"));
    await page.locator("tr").filter({ hasText: "Smoke applied role" }).first().waitFor();

    const appliedRow = page.locator("tr").filter({ hasText: "Smoke applied role" }).first();
    await appliedRow.getByRole("button", { name: "Update", exact: true }).click();
    const appliedTask = page.getByRole("region", { name: "Application: Smoke applied role" });
    await appliedTask.getByRole("button", { name: "Back to applications" }).waitFor();
    const appliedForm = appliedTask.locator("form").filter({ has: page.getByRole("button", { name: "Save update" }) });
    await appliedForm.getByRole("textbox", { name: "Next step" }).fill("Email recruiter on Friday");
    await appliedForm.getByRole("button", { name: "Save update" }).click();
    const applied = await waitForRow(pool, appliedId, row => row.next_action === "Email recruiter on Friday");
    await appliedForm.getByRole("button", { name: "Save update" }).waitFor();
    assert.equal(applied.applied_on, appliedDay, "editing a reminder preserves the application date");
    assert.equal(applied.notes, "Keep this note", "hidden notes are retained");
    assert.equal(applied.next_action, "Email recruiter on Friday");
    assert.equal(applied.next_action_on, "2026-10-09", "the reminder date is retained");
    assert.equal(applied.history.length, 1, "editing a reminder does not invent a stage event");

    await appliedForm.getByRole("textbox", { name: "Next step" }).fill("Unsaved filter navigation");
    for (const target of [
      page.getByRole("group", { name: "Progress" }).getByRole("link", { name: /^Closed / }),
      page.getByRole("group", { name: "Next steps" }).getByRole("link", { name: /^Due this week / }),
    ]) {
      const declined = new Promise(resolve => page.once("dialog", dialog => {
        resolve(dialog.message());
        dialog.dismiss();
      }));
      await target.click();
      assert.match(await declined, /Leave this application with unsaved changes/i);
      assert.equal(new URL(page.url()).pathname, "/applications");
      assert.equal(await appliedForm.getByRole("textbox", { name: "Next step" }).inputValue(), "Unsaved filter navigation");
    }
    page.once("dialog", dialog => dialog.accept());
    await appliedTask.getByRole("button", { name: "Back to applications" }).click();
    const interviewRow = page.locator("tr").filter({ hasText: "Smoke interview role" }).first();
    await interviewRow.getByRole("button", { name: "Update", exact: true }).click();
    const interviewTask = page.getByRole("region", { name: "Application: Smoke interview role" });
    const interviewForm = interviewTask.locator("form");
    await interviewForm.locator('input[name="on"]').fill("2026-10-04");
    await interviewForm.getByRole("button", { name: "Save update" }).click();
    const interview = await waitForRow(pool, interviewId, row => row.history.at(-1)?.on === "2026-10-04");
    await interviewForm.getByRole("button", { name: "Save update" }).waitFor();
    assert.equal(interview.applied_on, null, "an interview does not invent an application date");
    assert.equal(interview.history.at(-1)?.on, "2026-10-04", "the interview date belongs to the history entry");

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.reload();
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
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
        `applications must not overflow a ${width}px viewport`);
      if (width === 320) {
        for (const title of ["Smoke applied role", "Smoke interview role"]) {
          const card = page.locator('[aria-label="Applications"] article').filter({ hasText: title }).first();
          const titleBox = await card.getByRole("button", { name: title, exact: true }).boundingBox();
          const companyBox = await card.getByText("Smoke Applications", { exact: true }).boundingBox();
          assert.ok(titleBox && titleBox.width >= 160, `${title} needs at least 160px of readable title width at 320px`);
          assert.ok(companyBox && companyBox.width >= 160, `${title} needs at least 160px of readable company width at 320px`);
        }
      }
      await page.screenshot({ path: `${shots}/applications-populated-${width}.png`, fullPage: true });
      const box = await update.boundingBox();
      assert.ok(box && box.height >= 44 && box.width >= 44, `Update needs a 44px target at ${width}px`);
      await update.click();
      const mobileTask = page.getByRole("region", { name: "Application: Smoke applied role" });
      await mobileTask.getByRole("textbox", { name: "Next step" }).fill(`Unsaved at ${width}px`);
      page.once("dialog", dialog => dialog.dismiss());
      await mobileTask.getByRole("button", { name: "Back to applications" }).click();
      assert.equal(await mobileTask.getByRole("textbox", { name: "Next step" }).inputValue(), `Unsaved at ${width}px`,
        "cancelling a task exit keeps the entered value");
      assert.equal(await mobileTask.getByRole("button", { name: "Save update" }).isVisible(), true);
      page.once("dialog", dialog => dialog.accept());
      await mobileTask.getByRole("button", { name: "Back to applications" }).click();
      await page.locator('[aria-label="Applications"] article').filter({ hasText: "Smoke interview role" }).first().waitFor();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${baseUrl}/companies`);
    const desktopManage = page.getByRole("link", { name: "Manage", exact: true }).first();
    await desktopManage.waitFor();
    assert.match(await desktopManage.getAttribute("href"), /^\/companies\/[0-9a-f-]{36}#manage$/i);
    await page.screenshot({ path: `${shots}/companies-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      "tracked companies must not overflow a 320px viewport");
    const mobileManage = page.getByRole("link", { name: "Manage", exact: true }).first();
    const manageBox = await mobileManage.boundingBox();
    assert.ok(manageBox && manageBox.height >= 44, "mobile Manage link needs a 44px target");
    await page.screenshot({ path: `${shots}/companies-320.png`, fullPage: true });
    await page.goto(`${baseUrl}/applications/new`);
    await page.getByRole("heading", { name: "New application" }).waitFor();
    await page.screenshot({ path: `${shots}/applications-new-320.png`, fullPage: true });
    const beforeAi = (await pool.query("select count(*)::int as n from ai_calls where user_id = $1", [userId])).rows[0].n;
    const beforeUsage = (await pool.query("select count(*)::int as n from cv_ai_usage where user_id = $1", [userId])).rows[0].n;
    await page.getByRole("textbox", { name: "Company", exact: true }).fill("Smoke New Company");
    await page.getByRole("textbox", { name: "Role", exact: true }).fill("Smoke new application role");
    const description = page.getByRole("textbox", { name: "Role description, if you have it" });
    await description.fill("A role supplied directly by the account owner.");
    await page.getByRole("button", { name: "Create application · free" }).click();
    await page.getByRole("alert").filter({ hasText: "Keep the role description between 80 and 60,000 characters." }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Company", exact: true }).inputValue(), "Smoke New Company");
    assert.equal(await page.getByRole("textbox", { name: "Role", exact: true }).inputValue(), "Smoke new application role");
    assert.equal(await description.inputValue(), "A role supplied directly by the account owner.");
    assert.equal((await pool.query("select count(*)::int as n from cv_application_contexts where user_id = $1 and job_title = $2", [userId, "Smoke new application role"])).rows[0].n, 0);
    await description.fill("The account owner supplied this original role brief. Lead delivery across teams, own plans and report progress to stakeholders.");
    await page.getByRole("button", { name: "Create application · free" }).click();
    try { await page.waitForURL(/\/cv\/context\/[0-9a-f-]{36}$/i, { timeout: 10_000 }); }
    catch {
      const message = await page.getByRole("alert").allTextContents();
      const contexts = (await pool.query("select id from cv_application_contexts where user_id = $1 and job_title = $2", [userId, "Smoke new application role"])).rows;
      throw new Error(`Free application did not open: url=${page.url()}, alerts=${JSON.stringify(message)}, contexts=${JSON.stringify(contexts)}`);
    }
    const contextId = new URL(page.url()).pathname.split("/").at(-1);
    const contexts = (await pool.query("select id, user_id, company_name, job_title from cv_application_contexts where user_id = $1 and job_title = $2", [userId, "Smoke new application role"])).rows;
    assert.equal(contexts.length, 1, "free creation writes exactly one application context");
    const [created] = contexts;
    assert.equal(created.id, contextId);
    assert.deepEqual([created?.user_id, created?.company_name, created?.job_title], [userId, "Smoke New Company", "Smoke new application role"]);
    assert.equal((await pool.query("select count(*)::int as n from ai_calls where user_id = $1", [userId])).rows[0].n, beforeAi);
    assert.equal((await pool.query("select count(*)::int as n from cv_ai_usage where user_id = $1", [userId])).rows[0].n, beforeUsage);
    assert.deepEqual(errors, [], "applications browser flow has no page errors");
    console.log("  applications populated/filtered-empty, free new-role route and mobile flow; companies desktop/320 passed");
  } finally {
    await browser?.close();
    await pool.query("delete from applications where id = any($1::uuid[])", [[appliedId, interviewId]]);
    await pool.query("delete from companies where id = $1", [emptyCompanyId]);
    await pool.end();
  }
}
