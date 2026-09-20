import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { CvLibrarySchema, groupCvLibrary } = require("../packages/core/src/cv.ts");

const { Pool } = createRequire(new URL("../apps/web/package.json", import.meta.url))("pg");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");

/** Browser → optional evidence checkpoint → immutable Library version and resumed build. */
export async function verifyCvTailoringWorkspace(baseUrl, cookie, databaseUrl, userId) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const answerId = randomUUID();
  const skipId = randomUUID();
  let browser;
  let baseVersion;
  const library = {
    name: "Synthetic Tailoring Candidate",
    contact: "London",
    profile: "Operations leader",
    structuredExperience: true,
    facetedRows: true,
    employment: [{ id: "tailoring-job", company: "Synthetic Works", jobTitle: "Operations Director", startDate: "2022", endDate: "", current: true, industryDescriptions: "" }],
    entries: [{ id: "tailoring-role", kind: "experience", status: "active", employmentId: "tailoring-job",
      heading: "Operations Director · Synthetic Works", details: "Led a team through a service launch",
      confirmedResponsibilities: ["Led a team through a service launch"], rowFacets: { "Led a team through a service launch": "responsibility" } }],
  };
  const requirement = { id: "market", label: "New-market delivery", quote: "Launch in a new market", importance: "essential", category: "delivery" };
  const rubric = { requirements: [requirement], caveats: [] };
  const quiz = {
    version: 1, status: "awaiting_answers", libraryVersion: 0,
    questions: [{ id: "market-evidence", requirementId: requirement.id, requirement: requirement.label,
      prompt: "Which market did you launch in, and what changed?",
      suggestedDestination: { kind: "employment", employmentId: "tailoring-job" } }],
  };
  const originalSnapshot = JSON.stringify(library);

  try {
    const latest = await pool.query("select coalesce(max(version), 0)::int version from cv_libraries where user_id = $1", [userId]);
    baseVersion = Number(latest.rows[0].version) + 1;
    quiz.libraryVersion = baseVersion;
    await pool.query("insert into cv_libraries (user_id, version, content) values ($1, $2, $3)", [userId, baseVersion, originalSnapshot]);
    for (const [id, title] of [[answerId, "Tailoring answer flow"], [skipId, "Tailoring skip flow"]]) {
      await pool.query(
        `insert into cv_drafts
          (id, user_id, job_title, company_name, job_description, library_version, library_snapshot, model,
           status, build_checkpoint, gap_quiz, progress_at)
         values ($1, $2, $3, 'Synthetic Company', 'Launch in a new market', $4, $5, 'test',
           'awaiting_evidence', $6, $7, now())`,
        [id, userId, title, baseVersion, originalSnapshot,
          JSON.stringify({ tailoringEnabled: true, rubric, tailoringPlan: { requirements: [{ requirementId: requirement.id, status: "missing", evidence: [], reason: "Evidence not yet recorded" }], gapQuestions: quiz.questions } }),
          JSON.stringify(quiz)],
      );
      await pool.query(
        `insert into cv_build_steps
          (draft_id, user_id, attempt, seq, stage, motion, title, status, started_at, finished_at, ms, detail)
         values
          ($1, $2, 1, 1, 'analysing', 'plan_evidence', 'Matching the role to your strongest confirmed evidence', 'done', now() - interval '2 seconds', now() - interval '1 second', 1000, $3),
          ($1, $2, 1, 2, 'analysing', 'gap_quiz', 'Preparing a few optional evidence questions', 'done', now() - interval '1 second', now(), 1000, $4)`,
        [id, userId, JSON.stringify({ requirements: 1, supported: 0, questions: 1 }), JSON.stringify({ questions: 1, skipped: false })],
      );
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const separator = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await mkdir("tmp/cv-tailoring-smoke", { recursive: true });

    // The applications dashboard points out builds waiting for the person's evidence.
    await page.goto(`${baseUrl}/applications`);
    await page.getByRole("heading", { name: "Applications", exact: true }).waitFor();
    assert.ok((await page.locator("main").innerText()).includes("Waiting for your evidence"));

    await page.goto(`${baseUrl}/cv/${answerId}`);
    await page.getByRole("heading", { name: "Could your Library say more?", exact: true }).waitFor();
    assert.match(await page.locator("main").innerText(), /Add only facts you know are accurate/);
    await page.screenshot({ path: "tmp/cv-tailoring-smoke/optional-evidence-check.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "tmp/cv-tailoring-smoke/optional-evidence-mobile.png", fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "the quiz must fit a phone viewport");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("textbox", { name: quiz.questions[0].prompt, exact: true }).fill("Launched the service in France and reached the first 40 customers.");
    const destination = page.getByRole("combobox", { name: "Save this evidence under", exact: true });
    await destination.selectOption("employment:tailoring-job");
    await page.getByRole("checkbox", { name: /I confirm this wording is accurate/ }).check();
    await page.getByRole("button", { name: "Save evidence and continue", exact: true }).click();
    await page.waitForURL(url => url.pathname.startsWith("/cv/") && !url.pathname.endsWith(answerId));
    const continuationId = new URL(page.url()).pathname.split("/").pop();
    const answered = await pool.query(
      `select d.library_snapshot, d.archived_at, d.gap_quiz,
              c.id child_id, c.status child_status, c.parent_id, c.library_version child_library_version, c.library_snapshot child_snapshot,
              l.content new_library
         from cv_drafts d
         join cv_drafts c on c.parent_id = d.id
         join cv_libraries l on l.user_id = d.user_id and l.version = c.library_version
        where d.id = $1 and c.id = $2`, [answerId, continuationId],
    );
    assert.equal(answered.rows.length, 1);
    const saved = answered.rows[0];
    assert.deepEqual(saved.library_snapshot, library, "the paused draft's Library snapshot must remain immutable");
    assert.ok(saved.archived_at);
    assert.equal(saved.gap_quiz.status, "answered");
    assert.equal(saved.child_status, "queued");
    assert.equal(saved.parent_id, answerId);
    assert.equal(saved.child_library_version, baseVersion + 1);
    assert.deepEqual(saved.child_snapshot, JSON.parse(JSON.stringify(groupCvLibrary(CvLibrarySchema.parse({
      ...saved.new_library, stylePreferences: library.stylePreferences,
      preferredWording: library.preferredWording, theme: library.theme,
    })))), "the continuation uses the grouped new Library with the original build preferences");
    assert.ok(saved.new_library.entries[0].details.includes("Launched the service in France"));

    // The newest Library renders the evidence and its tag as cells in the same row.
    await page.goto(`${baseUrl}/library`);
    await page.getByRole("tab", { name: "Experience", exact: true }).click();
    const evidenceInput = page.getByRole("textbox", { name: /Synthetic Works Operations Director evidence 2/ });
    await evidenceInput.waitFor();
    const evidenceRow = evidenceInput.locator("xpath=ancestor::tr");
    assert.equal(await evidenceRow.getByRole("combobox", { name: /Evidence type for Synthetic Works Operations Director row 2/ }).count(), 1);
    assert.equal(await evidenceRow.getByRole("button", { name: /Remove Synthetic Works Operations Director evidence 2/ }).count(), 1);
    await evidenceRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "tmp/cv-tailoring-smoke/library-evidence-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "tmp/cv-tailoring-smoke/library-mobile-layout.png", fullPage: true });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
      console.error("Mobile overflow", await page.evaluate(() => [...document.querySelectorAll("body *")]
        .filter(element => element.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 18).map(element => ({ tag: element.tagName, class: element.className,
          right: element.getBoundingClientRect().right, overflow: getComputedStyle(element).overflowX }))));
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "the Library page must not overflow a phone viewport");
    await evidenceRow.scrollIntoViewIfNeeded();
    const rowScroller = evidenceRow.locator("xpath=ancestor::div[contains(@class,'overflow-x-auto')]");
    assert.ok((await rowScroller.evaluate(element => element.scrollWidth >= element.clientWidth)), "the evidence table must remain usable through its own horizontal scroller");
    const mobileTag = evidenceRow.getByRole("combobox", { name: /Evidence type for Synthetic Works Operations Director row 2/ });
    assert.equal(await mobileTag.isEnabled(), true);
    await mobileTag.focus();
    await page.screenshot({ path: "tmp/cv-tailoring-smoke/library-evidence-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Skipping resumes the same draft once, and its earlier planning motions remain visible.
    await page.goto(`${baseUrl}/cv/${skipId}`);
    await page.getByRole("button", { name: "No further evidence — continue", exact: true }).click();
    await page.waitForURL(url => url.pathname === `/cv/${skipId}`);
    try {
      await page.getByText(/Matched the role to your evidence/).waitFor({ timeout: 10_000 });
    } catch (error) {
      console.error("Skip continuation diagnostic", (await pool.query("select status, gap_quiz from cv_drafts where id = $1", [skipId])).rows);
      console.error(await page.locator("main").innerText());
      throw error;
    }
    await page.getByText(/Prepared 1 optional question for you before writing/).waitFor();
    const skipped = (await pool.query("select status, gap_quiz, build_checkpoint, library_snapshot from cv_drafts where id = $1", [skipId])).rows[0];
    assert.equal(skipped.status, "queued");
    assert.equal(skipped.gap_quiz.status, "skipped");
    assert.equal(skipped.build_checkpoint.quizCompleted, true);
    assert.deepEqual(skipped.library_snapshot, library);
    assert.equal((await pool.query("select count(*)::int n from tasks where payload->>'draftId' = $1 and status = 'queued'", [skipId])).rows[0].n, 1);
    await page.screenshot({ path: "tmp/cv-tailoring-smoke/resumed-narrative.png", fullPage: true });

    assert.deepEqual(errors, []);
    console.log("  CV tailoring browser flow passed: optional quiz, confirmed Library version, immutable snapshot, continuation, skip resume, narrative, dashboard state, and responsive same-row evidence tags");
  } finally {
    await browser?.close();
    await pool.query("delete from tasks where payload->>'userId' = $3 or payload->>'draftId' in (select id::text from cv_drafts where id in ($1, $2) or parent_id in ($1, $2))", [answerId, skipId, userId]);
    await pool.query("delete from cv_drafts where id in ($1, $2) or parent_id in ($1, $2)", [answerId, skipId]);
    if (baseVersion) await pool.query("delete from cv_libraries where user_id = $1 and version >= $2", [userId, baseVersion]);
    await pool.end();
  }
}
