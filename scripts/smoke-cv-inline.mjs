/** Real browser/server/database exercise. Proposal publication is a synthetic worker fixture;
 * provider behaviour is covered by cv-inline-ai.integration.test.ts. No external AI is called. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { register } from "tsx/esm/api";
import { mkdir, writeFile } from "node:fs/promises";
import { insertSession, startWeb } from "./lib/web.mjs";
const require = createRequire(import.meta.url);
require("tsx/cjs");
register();
const { createDb, createUser, grantCvCredits, reserveCvAiUsage, settleCvAiUsage } = require("../packages/db/src/index.ts");
const { runMigrations } = require("../packages/db/src/migrate.ts");
const { cvEditingTargetsFor } = require("../packages/core/src/cv-editing-modes.ts");
const { CvContentSchema, CvLibrarySchema } = require("../packages/core/src/cv.ts");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");
const databaseUrl = process.env.CV_MODES_DATABASE_URL;
const url = new URL(databaseUrl ?? "http://invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/col_cv_modes_browser_\d+$/.test(url.pathname))
  throw new Error("Use a dedicated local col_cv_modes_browser_<date> database.");
const { db, pool } = createDb(databaseUrl, { max: 3 });
const out = "/tmp/cv-inline-browser", port = 3119, baseUrl = `http://127.0.0.1:${port}`;
const secret = `synthetic-inline-${randomUUID()}-${randomUUID()}`;
let web, browser, page;
const errors = [];
try {
  await mkdir(out, { recursive: true });
  await runMigrations(db);
  const user = (await createUser(db, { email: `inline-${randomUUID()}@example.invalid`, name: "Synthetic Writer", role: "member", emailVerified: true })).user;
  await grantCvCredits(db, { userId: user.id, source: "admin", units: 1, externalRef: `browser-${user.id}` });
  const session = await insertSession(pool, user.id, { secret, ttlSeconds: 3600, userAgent: "synthetic-inline-browser" });
  const contextId = randomUUID(), descriptionId = randomUUID(), draftId = randomUUID();
  const library = CvLibrarySchema.parse({ name: "Synthetic Writer", contact: "London", profile: "Operations leader", entries: [] });
  const content = CvContentSchema.parse({ name: library.name, contact: "London", summary: "I lead teams and ship work.", sections: [{ entryId: "role", kind: "experience", heading: "Example Works · Operations Lead", bullets: ["Improved service delivery."] }], gaps: [] });
  const targets = cvEditingTargetsFor(content, randomUUID);
  await pool.query("insert into cv_libraries(user_id,version,content) values($1,1,$2)", [user.id, JSON.stringify(library)]);
  await pool.query("insert into cv_application_contexts(id,user_id,request_key,job_title,company_name) values($1,$2,$3,'Operations Lead','Example Works')", [contextId,user.id,`paste:${randomUUID()}`]);
  await pool.query("insert into cv_context_descriptions(id,context_id,user_id,version,text) values($1,$2,$3,1,$4)", [descriptionId,contextId,user.id,"Lead teams and deliver effective service improvements across the business."]);
  await pool.query("insert into cv_drafts(id,user_id,context_id,description_version_id,editing_mode,status,revision,content,editing_targets,library_version,library_snapshot,job_title,company_name,job_description,model) values($1,$2,$3,$4,'manual','ready',1,$5,$6,1,$7,'Operations Lead','Example Works','Lead teams and deliver effective service improvements across the business.','fixture')", [draftId,user.id,contextId,descriptionId,JSON.stringify(content),JSON.stringify(targets),JSON.stringify(library)]);
  await pool.query("update cv_application_contexts set current_description_version_id=$1,selected_kind='draft',selected_id=$2 where id=$3", [descriptionId,draftId,contextId]);
  web = await startWeb({ port, host: "127.0.0.1", env: { DATABASE_URL: databaseUrl, SESSION_SECRET: secret, COL_DISABLE_BROWSER: "1", APP_URL: baseUrl } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const split = session.cookie.indexOf("=");
  await context.addCookies([{ name: session.cookie.slice(0, split), value: session.cookie.slice(split + 1), url: baseUrl }]);
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseUrl}/cv/context/${contextId}`);
  const manual = page.locator("#cv-mode-panel-manual");
  const summary = manual.getByRole("textbox", { name: "Summary", exact: true });
  await summary.waitFor();
  assert.equal(await page.locator("details").count(), 0, "The core workspace has no disclosures");
  const star = manual.getByRole("button", { name: "Help me write: Summary", exact: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await star.focus();
    await star.getByRole("tooltip").waitFor({ state: "visible" });
    assert.equal(await star.getByRole("tooltip").innerText(), "Help me write");
    await page.keyboard.press("Enter");
    const menu = manual.getByRole("menu");
    assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
      "Fix spelling & grammar1 role credit for the first successful AI result", "Refine wording1 role credit for the first successful AI result", "Tailor to this role1 role credit for the first successful AI result",
    ]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Open menu fits ${width}px`);
    await page.screenshot({ path: `${out}/menu-${width}.png`, fullPage: true });
    await page.keyboard.press("Escape");
  }
  await summary.focus();
  await summary.evaluate(el => el.setSelectionRange(2, 12));
  await star.click();
  await manual.getByRole("menuitem", { name: "Refine wording", exact: true }).click();
  const latestRun = async () => (await pool.query("select * from cv_inline_edit_runs where user_id=$1 order by created_at desc limit 1", [user.id])).rows[0];
  await manual.getByText("Writing suggestion in progress…", { exact: true }).waitFor();
  const first = await latestRun();
  assert.equal(first.input.selection.selected, "lead teams", "Only the selected words are sent");
  async function publish(run, proposal) {
    await db.transaction(async tx => {
      const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm");
      await tx.execute(sql`update cv_inline_edit_runs set status='ready',proposed_text=${proposal},updated_at=now() where id=${run.id}::uuid and status='queued'`);
      await settleCvAiUsage(tx, { usageId: run.usage_id, source: { kind: "inline_run", id: run.id }, outcome: "ready" });
    });
  }
  await publish(first, "guide teams");
  const proposal = manual.getByRole("region", { name: "Writing suggestion for Summary", exact: true });
  await proposal.getByText("guide teams", { exact: true }).waitFor();
  assert.equal(await summary.inputValue(), content.summary, "A ready proposal does not replace wording");
  await proposal.getByRole("button", { name: "Use change and save Manual CV", exact: true }).click();
  await manual.getByRole("status").filter({ hasText: /Change saved in this Manual CV|Manual wording saved/ }).waitFor();
  const selected = async () => (await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1", [contextId])).rows[0];
  let saved = await selected();
  assert.equal(saved.content.summary, "I guide teams and ship work.");
  assert.equal(saved.editing_mode, "manual");
  assert.equal((await pool.query("select count(*)::int n from cv_refinement_events where context_id=$1", [contextId])).rows[0].n, 0);
  await star.click();
  await manual.getByRole("menuitem", { name: "Fix spelling & grammar", exact: true }).click();
  await manual.getByText("Writing suggestion in progress…", { exact: true }).waitFor();
  const second = await latestRun();
  await summary.fill("My newer wording must survive.");
  await publish(second, "I guide teams and deliver work.");
  await proposal.getByText(/This text changed while/).waitFor();
  assert.equal(await proposal.getByRole("button", { name: "Use change and save Manual CV", exact: true }).isDisabled(), true);
  await proposal.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(await summary.inputValue(), "My newer wording must survive.");
  const opportunity = (await pool.query("select opportunity_id from cv_ai_usage where id=$1", [second.usage_id])).rows[0].opportunity_id;
  // Exhaust the remaining free-tier session through settled synthetic operations.
  for (let i = 0; i < 7; i++) await db.transaction(async tx => {
    const id = randomUUID();
    await reserveCvAiUsage(tx, { userId: user.id, opportunityId: opportunity, operationId: id, requestKey: id,
      inputHash: createHash("sha256").update(id).digest("hex"), action: "inline_correction", source: { kind: "draft", id: saved.id } });
    await settleCvAiUsage(tx, { usageId: id, source: { kind: "draft", id: saved.id }, outcome: "ready" });
  });
  await star.click();
  await manual.getByRole("menuitem", { name: "Refine wording", exact: true }).click();
  await manual.getByRole("alert").filter({ hasText: /allowance/ }).waitFor();
  assert.equal((await pool.query("select count(*)::int n from cv_inline_edit_runs where user_id=$1", [user.id])).rows[0].n, 2, "Refused work creates no run");
  await manual.getByRole("button", { name: "Save Manual CV · free", exact: true }).click();
  await manual.getByRole("status").filter({ hasText: /Change saved in this Manual CV|Manual wording saved/ }).waitFor();
  saved = await selected();
  assert.equal(saved.content.summary, "My newer wording must survive.");
  await page.screenshot({ path: `${out}/exhausted-free-save.png`, fullPage: true });
  assert.equal((await pool.query("select count(*)::int n from cv_ai_usage where user_id=$1 and charge_kind='role_credit' and status='consumed'", [user.id])).rows[0].n, 1);
  assert.equal((await pool.query("select count(*)::int n from cv_libraries where user_id=$1", [user.id])).rows[0].n, 1, "Inline Manual wording never enters Experience");
  assert.deepEqual(errors, []);
  await writeFile(`${out}/result.json`, JSON.stringify({ contextId, draftId: saved.id, errors, selectedText: first.input.selection.selected, mobileWidths: [390, 320] }, null, 2));
  console.log("Inline writing browser smoke passed: selection, proposal, stale guard, one-role credit, quota exhaustion and free save.");
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
    await writeFile(`${out}/failure.txt`, await page.locator("body").innerText());
  }
  if (web) await writeFile(`${out}/server.log`, web.log());
  console.error(error); process.exitCode = 1;
} finally { await browser?.close(); await web?.stop(); await pool.end(); }
