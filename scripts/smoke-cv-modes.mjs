/** Production-browser proof of free editing/approval, with a deterministic published Auto fixture.
 * The provider pipeline is covered separately by the real-worker record/replay suite. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { insertSession, startWeb } from "./lib/web.mjs";
const require = createRequire(import.meta.url);
require("tsx/cjs");
const { createDb, createUser, grantCvCredits, publishCvAutoBaseline } = require("../packages/db/src/index.ts");
const { runMigrations } = require("../packages/db/src/migrate.ts");
const { cvEditingTargetsFor } = require("../packages/core/src/cv-editing-modes.ts");
const { CvContentSchema, CvLibrarySchema } = require("../packages/core/src/cv.ts");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");

export async function verifyCvEditingModes({ databaseUrl, outDir = "/tmp/cv-modes-browser", port = 3118 }) {
  const url = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/^\/col_cv_modes_browser_\d+$/.test(url.pathname))
    throw new Error("Use a dedicated local col_cv_modes_browser_<date> database.");
  const { db, pool } = createDb(databaseUrl, { max: 3 });
  const secret = `synthetic-browser-only-${randomUUID()}-${randomUUID()}`;
  let browser, web, page;
  const errors = [], timings = {};
  try {
    await runMigrations(db);
    const user = (await createUser(db, { email: `modes-${randomUUID()}@example.invalid`, name: "Synthetic Mode Candidate", role: "member", emailVerified: true })).user;
    await grantCvCredits(db, { userId: user.id, source: "admin", units: 3, externalRef: `browser-${user.id}` });
    const session = await insertSession(pool, user.id, { secret, ttlSeconds: 3600, userAgent: "synthetic-mode-browser" });
    const contextId = randomUUID(), descriptionId = randomUUID();
    const library = CvLibrarySchema.parse({ name: "Synthetic Mode Candidate", contact: "London", profile: "Operations leader",
      entries: [{ id: "role", kind: "experience", heading: "Operations Manager · Example Works",
        details: "Reduced backlog by 20%", confirmedResponsibilities: ["Reduced backlog by 20%"] },
      { id: "skills", kind: "skill", heading: "Operations", details: "Planning and delivery", skillItems: ["Planning", "Delivery"] }] });
    const content = CvContentSchema.parse({ name: library.name, contact: library.contact, summary: library.profile,
      sections: [{ entryId: "role", kind: "experience", heading: "Operations Manager · Example Works",
        bullets: ["Reduced backlog by 20%"], bulletSources: [["entry:role:row:0"]] },
      { entryId: "skills", kind: "skill", heading: "Operations", bullets: ["Planning", "Delivery"], skillItems: ["Planning", "Delivery"] }], gaps: [] });
    await pool.query("insert into cv_libraries(user_id,version,content) values($1,1,$2)",[user.id,JSON.stringify(library)]);
    await pool.query("insert into cv_application_contexts(id,user_id,request_key,job_title,company_name) values($1,$2,$3,'Operations Lead','Example Works')",[contextId,user.id,`paste:${randomUUID()}`]);
    await pool.query("insert into cv_context_descriptions(id,context_id,user_id,version,text) values($1,$2,$3,1,$4)",[descriptionId,contextId,user.id,"Lead operations, plan delivery and improve service performance across the organisation."]);
    await pool.query("update cv_application_contexts set current_description_version_id=$1 where id=$2",[descriptionId,contextId]);
    web = await startWeb({ port, host: "127.0.0.1", env: { DATABASE_URL: databaseUrl, SESSION_SECRET: secret,
      COL_DISABLE_BROWSER: "1", APP_URL: `http://127.0.0.1:${port}` } });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const baseUrl = `http://127.0.0.1:${port}`;
    const split = session.cookie.indexOf("=");
    await context.addCookies([{ name: session.cookie.slice(0,split), value: session.cookie.slice(split+1), url: baseUrl }]);
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    await mkdir(outDir,{ recursive:true });
    const route = `${baseUrl}/cv/context/${contextId}`;
    let started=performance.now(); await page.goto(route); await page.getByRole("button",{name:"Create Auto CV",exact:true}).waitFor();
    timings.workspaceLoadMs=Math.round(performance.now()-started);
    await page.getByRole("button",{name:"Create Auto CV",exact:true}).click();
    await page.waitForFunction(() => document.body.textContent.includes("building") || document.body.textContent.includes("queued"));
    const claim=(await pool.query("select * from cv_auto_baselines where context_id=$1",[contextId])).rows[0];
    assert.ok(claim?.source_draft_id,"Auto action created a claimed draft");
    const targets=cvEditingTargetsFor(content,randomUUID);
    await db.transaction(tx => publishCvAutoBaseline(tx,{userId:user.id,baselineId:claim.id,
      sourceDraftId:claim.source_draft_id,content,librarySnapshot:library,editingTargets:targets}));
    await pool.query("update cv_drafts set status='ready',content=$1,editing_targets=$2 where id=$3",[JSON.stringify(content),JSON.stringify(targets),claim.source_draft_id]);
    await pool.query("update tasks set status='done' where payload->>'draftId'=$1",[claim.source_draft_id]);
    const workCounts=async()=> (await pool.query("select (select count(*)::int from tasks where payload->>'userId'=$1::text) tasks,(select count(*)::int from credit_reservations where user_id=$1::uuid) credits",[user.id])).rows[0];
    const initialWork=await workCounts();
    await page.reload();
    started=performance.now(); await page.getByRole("button",{name:/Update Auto/}).click();
    await page.getByRole("status").filter({hasText:/ready|saved|credit/i}).first().waitFor();
    timings.autoReuseMs=Math.round(performance.now()-started);
    assert.deepEqual(await workCounts(),initialWork,"Auto cache hit creates no work or credit reservation");
    await page.reload();
    await page.getByRole("button",{name:"Refine Remembered for this role",exact:true}).click();
    const refine=page.locator("#cv-mode-panel-refine");
    await refine.getByLabel("Exact wording",{exact:true}).fill("Operations leader focused on reliable delivery");
    await refine.getByRole("button",{name:"Save refinement · free",exact:true}).click();
    await refine.getByText("Refinement saved for this application.",{exact:true}).waitFor();
    await refine.getByRole("button",{name:"Apply saved refinements · free",exact:true}).click();
    await refine.getByRole("status").filter({hasText:"Refined CV ready"}).waitFor();
    let refined=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    assert.equal(refined?.content.summary,"Operations leader focused on reliable delivery");
    assert.deepEqual(await workCounts(),initialWork,"Exact Refine is free");
    await refine.getByRole("button",{name:"Section and skill order",exact:true}).click();
    await refine.getByRole("button",{name:"Move Delivery up",exact:true}).click();
    await refine.getByRole("button",{name:"Remember order · free",exact:true}).click();
    await refine.getByText("This choice is remembered for this application.",{exact:true}).waitFor();
    await refine.getByRole("button",{name:"Apply saved refinements · free",exact:true}).click();
    await refine.getByRole("status").filter({hasText:"Refined CV ready"}).waitFor();
    refined=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    assert.deepEqual(refined.content.sections.find(row=>row.kind==="skill").skillItems,["Delivery","Planning"]);
    assert.equal(refined.content.summary,"Operations leader focused on reliable delivery");
    assert.deepEqual(await workCounts(),initialWork,"Chained structured Refine is free");
    await page.getByRole("button",{name:"Manual This version only",exact:true}).click();
    const manual=page.locator("#cv-mode-panel-manual");
    await manual.getByRole("button",{name:"Copy selected CV into Manual · free",exact:true}).click();
    await manual.getByRole("textbox",{name:"Summary",exact:true}).waitFor({timeout:5000});
    await manual.getByRole("textbox",{name:"Summary",exact:true}).fill("My final wording for this application");
    await page.getByRole("button",{name:"Auto From Experience and this role",exact:true}).click();
    await page.getByRole("button",{name:"Manual This version only",exact:true}).click();
    assert.equal(await manual.getByRole("textbox",{name:"Summary",exact:true}).inputValue(),"My final wording for this application");
    started=performance.now(); await manual.getByRole("button",{name:"Save Manual CV · free",exact:true}).click();
    await manual.getByRole("status").waitFor(); timings.manualSaveMs=Math.round(performance.now()-started);
    const saved=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    assert.equal(saved.content.summary,"My final wording for this application");
    assert.deepEqual(await workCounts(),initialWork,"Manual save has no AI/task/credit work");
    assert.equal((await pool.query("select count(*)::int n from cv_libraries where user_id=$1",[user.id])).rows[0].n,1,"Manual does not learn evidence");
    const approval=page.getByRole("region",{name:"Finalise saved CV"});
    await approval.getByRole("button",{name:"Review final PDF and warnings",exact:true}).click();
    await approval.getByText("Warnings to acknowledge",{exact:true}).waitFor();
    await approval.getByRole("checkbox").check();
    started=performance.now(); await approval.getByRole("button",{name:"Finalise this CV",exact:true}).click();
    await page.waitForFunction(()=>/finalised|download/i.test(document.body.textContent));
    timings.finaliseMs=Math.round(performance.now()-started);
    const pdf=(await pool.query("select * from cv_pdfs where draft_id=$1",[saved.id])).rows[0];
    assert.equal(pdf.approval_mode,"unchecked"); assert.ok(pdf.bytes.length>100);
    const downloaded=await context.request.get(`${baseUrl}/api/cv/${saved.id}/pdf`);
    assert.equal(downloaded.status(),200); assert.deepEqual(await downloaded.body(),pdf.bytes,"Download serves exact approved bytes");
    assert.deepEqual(await workCounts(),initialWork,"Unchecked approval adds no model/task/credit work");
    await page.getByRole("button",{name:"Refine Remembered for this role",exact:true}).click();
    await refine.getByRole("button",{name:`Select Refine edition V${refined.revision}`,exact:true}).click();
    await refine.getByRole("button",{name:"Reset all",exact:true}).click();
    await refine.getByRole("status").filter({hasText:/reset/i}).waitFor();
    const reset=(await pool.query("select selected_kind,selected_id from cv_application_contexts where id=$1",[contextId])).rows[0];
    assert.equal(reset.selected_kind,"baseline"); assert.equal(reset.selected_id,claim.id);
    assert.equal((await pool.query("select count(*)::int n from cv_pdfs where draft_id=$1",[saved.id])).rows[0].n,1,"Reset retains final Manual PDF");
    assert.deepEqual(await workCounts(),initialWork,"Reset is free");
    await page.screenshot({path:`${outDir}/desktop.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.getByRole("button",{name:"Auto From Experience and this role",exact:true}).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#cv-mode-auto").getAttribute("aria-pressed"),"true");
    await page.getByRole("button",{name:"Refine Remembered for this role",exact:true}).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,"No mobile overflow");
    await page.screenshot({path:`${outDir}/mobile.png`,fullPage:true});
    await page.goto(`${baseUrl}/cv/${saved.id}`);
    await page.getByLabel("Application date",{exact:true}).fill("2026-11-02");
    await page.getByRole("button",{name:"Record application",exact:true}).click();
    await page.getByRole("link",{name:/Application recorded/}).waitFor();
    const application=(await pool.query("select context_id,cv_id from applications where cv_id=$1 and user_id=$2",[saved.id,user.id])).rows[0];
    assert.equal(application.context_id,contextId);
    assert.equal(application.cv_id,saved.id);
    assert.deepEqual(errors,[],"No browser runtime errors");
    await writeFile(`${outDir}/result.json`,JSON.stringify({contextId,userId:user.id,selectedDraftId:saved.id,timings,initialWork,errors},null,2));
    return { contextId,userId:user.id,selectedDraftId:saved.id,timings,initialWork,errors };
  } catch (error) {
    if (page) {
      await mkdir(outDir,{recursive:true});
      await page.screenshot({path:`${outDir}/failure.png`,fullPage:true}).catch(()=>{});
      await writeFile(`${outDir}/failure.txt`,await page.locator("body").innerText());
      await writeFile(`${outDir}/failure.html`,await page.content());
    }
    if (web) await writeFile(`${outDir}/server.log`,web.log());
    throw error;
  } finally { await browser?.close(); await web?.stop(); await pool.end(); }
}
