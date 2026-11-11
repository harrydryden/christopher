/** Production-browser proof of free editing/approval, with a deterministic published Auto fixture.
 * The provider pipeline is covered separately by the real-worker record/replay suite. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { register } from "tsx/esm/api";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { insertSession, startWeb } from "./lib/web.mjs";
const require = createRequire(import.meta.url);
require("tsx/cjs");
register();
const { createDb, createUser, grantCvCredits, publishCvAutoBaseline, consumeCvCredit } = require("../packages/db/src/index.ts");
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
  const errors = [], timings = {}, resources = {};
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
    const workCounts=async()=> (await pool.query("select (select count(*)::int from tasks where payload->>'userId'=$1::text) tasks,(select count(*)::int from cv_ai_usage where user_id=$1::uuid and charge_kind='role_credit') credits,(select count(*)::int from cv_ai_usage where user_id=$1::uuid and charge_kind='allowance') edits",[user.id])).rows[0];
    await consumeCvCredit(db,claim.source_draft_id);
    const initialWork=await workCounts();
    await page.reload();
    started=performance.now(); await page.getByRole("button",{name:/Update Auto/}).click();
    await page.getByRole("status").filter({hasText:"Your saved Auto CV is ready. No new AI usage was charged."}).waitFor();
    timings.autoReuseMs=Math.round(performance.now()-started);
    assert.deepEqual(await workCounts(),initialWork,"Auto cache hit creates no work or credit reservation");
    await page.reload();
    const jsResources = () => page.evaluate(() => {
      const rows = performance.getEntriesByType("resource").filter(entry => entry.name.includes("/_next/static/") && entry.name.endsWith(".js"));
      return { requests: rows.length, transferBytes: rows.reduce((sum, entry) => sum + entry.transferSize, 0),
        encodedBytes: rows.reduce((sum, entry) => sum + entry.encodedBodySize, 0) };
    });
    resources.beforeModes = await jsResources();
    await page.getByRole("region",{name:"Current CV",exact:true}).waitFor();
    assert.equal(await page.getByRole("region",{name:"Current CV",exact:true}).count(),1,"There is one authoritative current CV surface");
    await page.getByRole("button",{name:"Refine Remembered for this role",exact:true}).click();
    const refine=page.locator("#cv-mode-panel-refine");
    await refine.getByLabel("Summary",{exact:true}).waitFor();
    assert.equal(await refine.getByLabel("Summary",{exact:true}).inputValue(),content.summary,"Exact editing starts with the current wording");
    assert.equal(await refine.locator('[data-cv-mode-dirty="true"]').count(),0,"Opening prefilled wording is not an unsaved edit");
    await page.screenshot({path:`${outDir}/refine-desktop.png`,fullPage:true});
    resources.afterRefine = await jsResources();
    await refine.getByLabel("Summary",{exact:true}).fill("Operations leader focused on reliable delivery");
    started=performance.now();
    await refine.getByRole("button",{name:"Save Summary and update CV · free",exact:true}).click();
    await refine.getByRole("status").filter({hasText:/CV updated|saved and updated/i}).waitFor();
    timings.exactRefineSaveMs=Math.round(performance.now()-started);
    let refined=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    assert.equal(refined?.content.summary,"Operations leader focused on reliable delivery");
    assert.deepEqual(await workCounts(),initialWork,"Exact Refine is free");
    const firstExactEdition=refined.id;
    await refine.getByLabel("Summary",{exact:true}).fill("Operations leader focused on reliable delivery and service quality");
    await refine.getByRole("button",{name:"Save Summary and update CV · free",exact:true}).click();
    await refine.getByRole("status").filter({hasText:/CV updated|saved and updated/i}).waitFor();
    refined=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    assert.notEqual(refined.id,firstExactEdition,"Re-editing creates a separate saved edition");
    assert.equal(refined.content.summary,"Operations leader focused on reliable delivery and service quality");
    assert.equal((await pool.query("select count(distinct stable_id)::int n from cv_refinement_events where context_id=$1 and refinement->>'kind'='exact_wording'",[contextId])).rows[0].n,1,"Editing the same item updates its remembered rule, not a duplicate lock");
    assert.deepEqual(await workCounts(),initialWork,"Re-editing exact wording is free");
    await page.getByRole("region",{name:"Current CV",exact:true}).getByText(`refine · version ${refined.revision}`,{exact:true}).waitFor();
    assert.equal(await refine.getByRole("button",{name:"Apply saved refinements · free",exact:true}).count(),0,"An applied exact edit has no redundant Apply step");
    await refine.getByLabel("Summary",{exact:true}).fill("Unsaved wording retained during source recovery");
    await page.getByRole("button",{name:"History",exact:true}).click();
    const recoveryHistory=page.locator("#cv-history");
    await recoveryHistory.getByRole("button").first().click();
    await page.getByRole("button",{name:"Edit current CV",exact:true}).click();
    await refine.getByRole("button",{name:"Restore original saved edition",exact:true}).click();
    await refine.getByRole("status").filter({hasText:"Your original saved edition is selected again"}).waitFor();
    assert.equal(await refine.getByLabel("Summary",{exact:true}).inputValue(),"Unsaved wording retained during source recovery");
    await page.waitForFunction(()=>!document.body.textContent.includes("The selected edition changed while this refinement buffer was open"));
    assert.equal((await pool.query("select selected_id from cv_application_contexts where id=$1",[contextId])).rows[0].selected_id,refined.id);
    await refine.getByLabel("Summary",{exact:true}).fill(refined.content.summary);
    await refine.getByRole("button",{name:"Order",exact:true}).click();
    await refine.getByRole("button",{name:"Move Delivery up",exact:true}).click();
    await refine.getByRole("button",{name:"Remember order · free",exact:true}).click();
    await refine.getByText("This choice is remembered for this application.",{exact:true}).waitFor();
    await refine.getByRole("button",{name:"Apply saved refinements · free",exact:true}).click();
    await refine.getByRole("status").filter({hasText:/Refined CV ready/}).waitFor();
    refined=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    assert.deepEqual(refined.content.sections.find(row=>row.kind==="skill").skillItems,["Delivery","Planning"]);
    assert.equal(refined.content.summary,"Operations leader focused on reliable delivery and service quality");
    assert.deepEqual(await workCounts(),initialWork,"Chained structured Refine is free");
    const layout=page.locator("#cv-context-layout");
    await layout.getByLabel("Maximum pages",{exact:true}).selectOption("2");
    await layout.getByRole("button",{name:"Remember this layout for this role · free",exact:true}).click();
    await refine.getByText("This choice is remembered for this application.",{exact:true}).waitFor();
    await refine.getByRole("button",{name:"Apply saved refinements · free",exact:true}).click();
    await refine.getByRole("status").filter({hasText:/Refined CV ready/}).waitFor();
    refined=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    assert.equal(refined.content.theme.maxPages,2,"Shared Layout persists as a role refinement");
    // A prose bullet's short title and body are one free, stable-target edit. Clearing the title
    // must remove it from the saved CV without changing the body or starting model work.
    await refine.getByRole("button",{name:"Edit document",exact:true}).click();
    const proseBullet=refine.locator('section[data-cv-source-entry="role"]').filter({hasText:"bullet 1"});
    const bulletBody=proseBullet.getByRole("textbox").last();
    const bulletTitle=proseBullet.getByRole("textbox").first();
    assert.equal(await bulletTitle.inputValue(),"");
    await bulletBody.fill("Reduced the backlog by 20% through clearer service planning");
    await bulletTitle.fill("Service delivery");
    await proseBullet.getByRole("button",{name:/^Save .* and update CV/}).click();
    await page.waitForFunction(() => {
      const input=document.querySelector('#cv-mode-panel-refine input[id^="cv-refine-title-"]');
      return input && !input.disabled && input.value==="Service delivery";
    });
    refined=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    let savedBullet=refined.content.sections.find(row=>row.entryId==="role");
    assert.equal(savedBullet.bullets[0],"Reduced the backlog by 20% through clearer service planning");
    assert.equal(savedBullet.bulletSignposts?.[0],"Service delivery");
    assert.deepEqual(await workCounts(),initialWork,"Adding a bullet title and body is free");
    const signpostDir="/tmp/cv-signpost-browser";
    await mkdir(signpostDir,{recursive:true});
    const titledPreview=await context.request.get(`${baseUrl}/api/cv/${refined.id}/pdf?preview=1`);
    assert.equal(titledPreview.status(),200,"The titled saved edition renders a PDF preview");
    await writeFile(`${signpostDir}/titled-preview.pdf`,await titledPreview.body());
    await bulletTitle.fill("");
    await proseBullet.getByRole("button",{name:/^Save .* and update CV/}).click();
    await page.waitForFunction(() => {
      const input=document.querySelector('#cv-mode-panel-refine input[id^="cv-refine-title-"]');
      return input && !input.disabled && input.value==="";
    });
    refined=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    savedBullet=refined.content.sections.find(row=>row.entryId==="role");
    assert.equal(savedBullet.bulletSignposts?.[0]??null,null,"Clearing the title removes it from the saved CV");
    assert.equal(savedBullet.bullets[0],"Reduced the backlog by 20% through clearer service planning");
    assert.deepEqual(await workCounts(),initialWork,"Clearing a bullet title is free");
    const clearedPreview=await context.request.get(`${baseUrl}/api/cv/${refined.id}/pdf?preview=1`);
    assert.equal(clearedPreview.status(),200,"The cleared saved edition renders a PDF preview");
    await writeFile(`${signpostDir}/cleared-preview.pdf`,await clearedPreview.body());
    await page.getByRole("button",{name:"Manual This version only",exact:true}).click();
    const manual=page.locator("#cv-mode-panel-manual");
    await manual.getByRole("button",{name:"Copy selected CV into Manual · free",exact:true}).waitFor();
    resources.afterManual = await jsResources();
    await manual.getByRole("button",{name:"Copy selected CV into Manual · free",exact:true}).click();
    await manual.getByRole("textbox",{name:"Summary",exact:true}).waitFor({timeout:5000});
    await manual.getByRole("textbox",{name:"Summary",exact:true}).fill("My final wording for this application");
    await page.getByRole("button",{name:"Auto From Experience and this role",exact:true}).click();
    await page.getByRole("button",{name:"Manual This version only",exact:true}).click();
    assert.equal(await manual.getByRole("textbox",{name:"Summary",exact:true}).inputValue(),"My final wording for this application");
    await layout.getByLabel("Maximum pages",{exact:true}).selectOption("1");
    await page.getByRole("button",{name:"Refine Remembered for this role",exact:true}).click();
    assert.equal(await layout.getByLabel("Maximum pages",{exact:true}).inputValue(),"2","Refine retains its own layout after Manual is visited");
    await page.getByRole("button",{name:"Manual This version only",exact:true}).click();
    assert.equal(await layout.getByLabel("Maximum pages",{exact:true}).inputValue(),"1","Manual layout buffer survives a mode switch");
    await page.evaluate(()=>{ window.location.hash="cv-panel-appearance"; });
    await page.waitForFunction(()=>document.activeElement===document.querySelector("#cv-context-layout h2"));
    await page.getByRole("button",{name:"Refine Remembered for this role",exact:true}).click();
    await page.getByRole("button",{name:"Manual This version only",exact:true}).click();
    assert.equal(await page.locator("#cv-mode-manual").getAttribute("aria-pressed"),"true","A previous deep link must not trap later mode switches");
    await page.evaluate(()=>{ window.location.hash="cv-panel-evaluation"; });
    await page.waitForFunction(()=>document.activeElement===document.querySelector("#cv-context-feedback h2"));
    assert.equal(await manual.getByRole("textbox",{name:"Summary",exact:true}).inputValue(),"My final wording for this application","Legacy fragments preserve unsaved wording");
    await page.evaluate(()=>{ window.location.hash="%"; });
    await page.evaluate(()=>history.replaceState(null,"",location.pathname));
    const feedback=page.locator("#cv-context-feedback");
    assert.equal(await feedback.isVisible(),true,"Feedback is directly visible");
    const approval=page.getByRole("region",{name:"Finalise saved CV"});
    assert.equal(await approval.count(),1,"There is one approval destination");
    await approval.getByRole("button",{name:"Review final PDF and warnings",exact:true}).click();
    await approval.getByText("Save your CV edits before reviewing the final PDF.",{exact:true}).waitFor();
    const roleDetails=page.locator("#cv-role-details");
    await page.getByRole("button",{name:"Role details",exact:true}).click();
    const updatedDescription="Lead operations, plan delivery and improve service performance across the organisation. Coordinate international service teams.";
    await roleDetails.getByLabel("Role description for this application",{exact:true}).fill(updatedDescription);
    await roleDetails.getByRole("button",{name:"Update saved role description · free",exact:true}).click();
    await roleDetails.getByRole("status").filter({hasText:"Role description saved"}).waitFor();
    await page.getByRole("button",{name:"Edit current CV",exact:true}).click();
    assert.equal(await manual.getByRole("textbox",{name:"Summary",exact:true}).inputValue(),"My final wording for this application","Role updates preserve dirty Manual wording");
    assert.deepEqual(await workCounts(),initialWork,"Saving role details creates no model work");
    started=performance.now(); await manual.getByRole("button",{name:"Save Manual CV · free",exact:true}).click();
    await manual.getByRole("status").filter({hasText:"Manual wording saved as a new revision"}).waitFor(); timings.manualSaveMs=Math.round(performance.now()-started);
    const saved=(await pool.query("select d.* from cv_drafts d join cv_application_contexts c on c.selected_id=d.id where c.id=$1",[contextId])).rows[0];
    assert.equal(saved.content.summary,"My final wording for this application");
    assert.equal(saved.content.theme.maxPages,1,"Manual saves the shared Layout buffer");
    assert.equal(saved.description_version_id,descriptionId,"Manual save retains the role snapshot it was written against");
    assert.deepEqual(await workCounts(),initialWork,"Manual save has no AI/task/credit work");
    assert.equal((await pool.query("select count(*)::int n from cv_libraries where user_id=$1",[user.id])).rows[0].n,1,"Manual does not learn evidence");
    await approval.getByRole("button",{name:"Review final PDF and warnings",exact:true}).click();
    await approval.getByText("Warnings to acknowledge",{exact:true}).waitFor();
    await approval.getByRole("checkbox").check();
    started=performance.now(); await approval.getByRole("button",{name:"Finalise this CV",exact:true}).click();
    await page.getByRole("link",{name:"Download saved PDF",exact:true}).waitFor();
    timings.finaliseMs=Math.round(performance.now()-started);
    const pdf=(await pool.query("select * from cv_pdfs where draft_id=$1",[saved.id])).rows[0];
    assert.equal(pdf.approval_mode,"unchecked"); assert.ok(pdf.bytes.length>100);
    const downloaded=await context.request.get(`${baseUrl}/api/cv/${saved.id}/pdf`);
    assert.equal(downloaded.status(),200); assert.deepEqual(await downloaded.body(),pdf.bytes,"Download serves exact approved bytes");
    assert.deepEqual(await workCounts(),initialWork,"Unchecked approval adds no model/task/credit work");
    // The role update is explicit; publish a second deterministic fixture with fresh target IDs.
    // Real worker/provider behaviour is covered separately. Here the changed role conflicts with
    // wording/order rules, while an independent appearance choice can safely be carried forward.
    await page.getByRole("button",{name:"Auto From Experience and this role",exact:true}).click();
    await page.locator("#cv-mode-panel-auto").getByRole("status").filter({hasText:"The saved role description has changed"}).waitFor();
    await page.getByRole("button",{name:/Update Auto|Create Auto CV/}).click();
    await page.getByRole("status").filter({hasText:/building/i}).first().waitFor();
    const nextClaim=(await pool.query("select * from cv_auto_baselines where context_id=$1 and id<>$2 order by created_at desc limit 1",[contextId,claim.id])).rows[0];
    assert.ok(nextClaim?.source_draft_id,"Updated role explicitly starts a new Auto build");
    assert.notEqual(nextClaim.description_version_id,descriptionId);
    const nextTargets=cvEditingTargetsFor(content,randomUUID);
    await db.transaction(tx=>publishCvAutoBaseline(tx,{userId:user.id,baselineId:nextClaim.id,
      sourceDraftId:nextClaim.source_draft_id,content,librarySnapshot:library,editingTargets:nextTargets}));
    await pool.query("update cv_drafts set status='ready',content=$1,editing_targets=$2 where id=$3",[JSON.stringify(content),JSON.stringify(nextTargets),nextClaim.source_draft_id]);
    await pool.query("update tasks set status='done' where payload->>'draftId'=$1",[nextClaim.source_draft_id]);
    await consumeCvCredit(db,nextClaim.source_draft_id);
    const updatedWork=await workCounts();
    assert.equal(updatedWork.tasks,initialWork.tasks+1);
    assert.equal(updatedWork.credits,initialWork.credits,"A changed advert keeps the paid role unlocked");
    assert.equal(updatedWork.edits,initialWork.edits+1,"An explicit new build uses editing allowance");
    await page.reload();
    assert.equal(await page.locator("#cv-mode-panel-auto").getByRole("status")
      .filter({hasText:"Your Experience has changed."}).count(),0,"A fresh Auto result must not report false Experience drift from normalisation or layout defaults");
    await page.getByRole("button",{name:"Role details",exact:true}).click();
    await roleDetails.getByRole("button",{name:"Review source changes",exact:true}).click();
    await roleDetails.getByText(/compatible (?:remembered )?change/i).first().waitFor();
    assert.equal(await roleDetails.getByLabel("From saved Auto result",{exact:true}).inputValue(),claim.id,"The remembered source is selected automatically");
    assert.equal(await roleDetails.getByLabel("To current role’s Auto result",{exact:true}).inputValue(),nextClaim.id,"The current role result is selected automatically");
    assert.equal(await roleDetails.getByRole("checkbox").count(),0,"Compatible changes need one confirmation, not individual checkboxes");
    await page.screenshot({path:`${outDir}/source-review-desktop.png`,fullPage:true});
    assert.match(await roleDetails.innerText(),/role.*changed|changed.*role|new decision/i);
    await roleDetails.getByRole("button",{name:/^Carry compatible changes/}).click();
    await roleDetails.getByRole("status").filter({hasText:/carried/}).waitFor();
    await roleDetails.getByRole("button",{name:"Review source changes",exact:true}).click();
    await roleDetails.getByText(/already current/i).waitFor();
    assert.equal(await roleDetails.getByRole("checkbox").count(),0,"Applied compatible rules are not offered or mislabelled as conflicts on a second preview");
    assert.deepEqual(await workCounts(),updatedWork,"Preview/apply source bindings are free");
    const retainedPdf=await context.request.get(`${baseUrl}/api/cv/${saved.id}/pdf`);
    assert.deepEqual(await retainedPdf.body(),pdf.bytes,"Source updates and partial rebase preserve the final Manual PDF");
    await page.getByRole("button",{name:"Edit current CV",exact:true}).click();
    await page.getByRole("button",{name:"Refine Remembered for this role",exact:true}).click();
    await page.getByRole("button",{name:"History",exact:true}).click();
    const history=page.locator("#cv-history");
    await history.getByRole("button",{name:`Select refine edition V${refined.revision}`,exact:true}).click();
    await page.getByRole("button",{name:"Edit current CV",exact:true}).click();
    await refine.getByRole("button",{name:"Remembered choices",exact:true}).click();
    await refine.getByRole("button",{name:"Reset all",exact:true}).click();
    await refine.getByRole("status").filter({hasText:"All refinements reset."}).waitFor();
    const reset=(await pool.query("select selected_kind,selected_id from cv_application_contexts where id=$1",[contextId])).rows[0];
    assert.equal(reset.selected_kind,"baseline"); assert.equal(reset.selected_id,claim.id);
    assert.equal((await pool.query("select count(*)::int n from cv_pdfs where draft_id=$1",[saved.id])).rows[0].n,1,"Reset retains final Manual PDF");
    assert.deepEqual(await workCounts(),updatedWork,"Reset is free");
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
    await writeFile(`${outDir}/result.json`,JSON.stringify({contextId,userId:user.id,selectedDraftId:saved.id,timings,resources,initialWork,errors},null,2));
    return { contextId,userId:user.id,selectedDraftId:saved.id,timings,resources,initialWork,errors };
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databaseUrl = process.env.CV_MODES_DATABASE_URL;
  if (!databaseUrl) throw new Error("Set CV_MODES_DATABASE_URL to an isolated col_cv_modes_browser_<date> database.");
  verifyCvEditingModes({ databaseUrl }).then(result => {
    console.log(`Editing modes browser smoke passed: ${JSON.stringify(result.timings)}`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
