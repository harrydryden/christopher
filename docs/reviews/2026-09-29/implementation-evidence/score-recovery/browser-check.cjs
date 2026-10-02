const { chromium } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright');
const { Client } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/web/node_modules/pg');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const base = __dirname;
const repo = '/Users/h_dryden/Documents/New project/christopher-jtbd-review';
const origin = 'http://localhost:3145';
const role = '0ce91711-e037-4d25-b319-a9111f0a2912';
const user = 'e5bd37f3-ca5c-4300-9e62-beed62d018ae';
(async () => {
  const db = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:55439/ava_score_ux' });
  await db.connect();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await context.addCookies([{ name: 'ava_session', value: fs.readFileSync('/tmp/jtbd-score-recovery-cookie', 'utf8').trim(), url: origin }]);
    const blockedExternal = [];
    await context.route('**/*', route => {
      const request = route.request().url();
      if (new URL(request).origin === origin) return route.continue();
      blockedExternal.push(request);
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?view=user-shortlisted`, { waitUntil: 'load' });
    const row = page.locator(`#role-row-${role}`).locator('xpath=..');
    await row.waitFor({ timeout: 30000 });
    await row.locator('td[id^="role-row-"] button').first().click();
    const panel = page.locator(`#role-review-${role}`);
    await panel.waitFor();
    const before = await panel.innerText();
    if (!before.includes('Previous score; update failed') || !before.includes('72') || !before.includes('Shortlisted')) throw new Error(`Missing prior state: ${before}`);
    await panel.screenshot({ path: path.join(base, 'retry-failed-375.png') });
    const nativeWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
    const enlarged = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(el => el.textContent === 'Retry score');
      const buttonBaselinePx = parseFloat(getComputedStyle(button).fontSize);
      const fonts = [...document.querySelectorAll('*')].map(element => ({ element, px: parseFloat(getComputedStyle(element).fontSize) }));
      for (const { element, px } of fonts) if (Number.isFinite(px) && px > 0) element.style.fontSize = `${px * 2}px`;
      return { body: document.body.scrollWidth, viewport: innerWidth, buttonBaselinePx, buttonFontPx: parseFloat(getComputedStyle(button).fontSize) };
    });
    if (enlarged.body > enlarged.viewport || enlarged.buttonFontPx !== enlarged.buttonBaselinePx * 2) throw new Error(`200% text layout failed: ${JSON.stringify(enlarged)}`);
    await panel.screenshot({ path: path.join(base, 'retry-text200-375.png') });
    await page.screenshot({ path: path.join(base, 'retry-text200-viewport-375.png') });
    await page.reload({ waitUntil: 'load' });
    await row.locator('td[id^="role-row-"] button').first().click();
    await panel.waitFor();
    const retry = panel.getByRole('button', { name: 'Retry score' });
    await retry.focus();
    if (!(await retry.evaluate(el => el === document.activeElement))) throw new Error('Retry button could not receive keyboard focus');
    await page.keyboard.press('Enter');
    await row.getByText('Previous score; update pending').first().waitFor({ timeout: 30000 });
    await panel.getByRole('status').waitFor({ timeout: 30000 });
    const acknowledged = await panel.getByRole('status').innerText();
    if (!acknowledged.includes('Score') || !acknowledged.includes('reviewing')) throw new Error(`Missing acknowledgement: ${acknowledged}`);
    const afterClick = await db.query('select score_state,fit_score,fit_rationale from user_jobs where user_id=$1 and job_id=$2', [user, role]);
    if (afterClick.rows[0].score_state !== 'requested' || afterClick.rows[0].fit_score !== 72) throw new Error(`Wrong requested state: ${JSON.stringify(afterClick.rows[0])}`);
    const queued = await db.query("select id,status,payload from tasks where type='admit_scores' and status='queued' and payload->>'userId'=$1 and payload->'jobIds' ? $2 order by created_at desc", [user, role]);
    if (queued.rows.length !== 1) throw new Error(`Expected one queued admission: ${JSON.stringify(queued.rows)}`);
    const taskId = queued.rows[0].id;
    const pendingText = (await panel.innerText()).split('Description')[0];
    await panel.screenshot({ path: path.join(base, 'retry-requested-375.png') });
    const env = { ...process.env, DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:55439/ava_score_ux', AVA_DISABLE_BROWSER: '1', SCRAPER_CONTACT_EMAIL: 'ava-source-diagnostic@example.invalid' };
    delete env.ANTHROPIC_API_KEY;
    delete env.RESEND_API_KEY;
    const run = spawnSync('pnpm', ['--filter', '@ava/worker', 'exec', 'tsx', '/tmp/jtbd-admit-once.mts', taskId], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
    if (run.status !== 0) throw new Error(`One-shot admission failed: ${run.stderr || run.stdout}`);
    const admission = JSON.parse(run.stdout);
    const started = Date.now();
    await page.waitForFunction(id => document.getElementById(`role-row-${id}`)?.closest('tr')?.textContent?.includes('AI update unavailable'), role, { timeout: 60000, polling: 500 });
    const settled = (await panel.innerText()).split('Description')[0];
    await panel.screenshot({ path: path.join(base, 'retry-unavailable-375.png') });
    const final = await db.query('select score_state,fit_score,fit_rationale from user_jobs where user_id=$1 and job_id=$2', [user, role]);
    const decisions = await db.query('select decision,reason from decisions where user_id=$1 and job_id=$2 and superseded=false', [user, role]);
    const report = { at: new Date().toISOString(), viewport: { width: 375, height: 812 }, role, keyboardEnterActivated: true, before: before.replace(/\s+/g, ' '), acknowledged,
      afterClick: afterClick.rows[0], pendingText: pendingText.replace(/\s+/g, ' '), taskId, admission, refreshMs: Date.now() - started,
      settled: settled.replace(/\s+/g, ' '), nativeWidth, enlargedTextOnlyWidth: enlarged, final: final.rows[0], standingDecision: decisions.rows[0],
      blockedExternalRequests: blockedExternal, pageErrors: errors };
    fs.writeFileSync(path.join(base, 'browser-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ taskId, final: report.final, nativeWidth, enlargedTextOnlyWidth: enlarged, pageErrors: errors, blockedExternalRequests: blockedExternal.length }, null, 2));
  } finally { await browser.close(); await db.end(); }
})().catch(error => { console.error(error); process.exit(1); });
