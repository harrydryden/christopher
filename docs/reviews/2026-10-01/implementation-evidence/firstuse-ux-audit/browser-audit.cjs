/** Synthetic first-use recovery audit. Browser observations are not user or AT research. */
const { chromium } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = __dirname;
const origin = 'http://localhost:3145';
const mode = process.argv[2];
if (!['interrupted', 'interrupted-zero', 'queued', 'running-offline', 'complete-zero'].includes(mode)) throw new Error('Pass interrupted, interrupted-zero, queued, running-offline or complete-zero');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const observations = [];
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
      const label = viewport.width === 375 ? 'mobile-375' : 'desktop-1280';
      const context = await browser.newContext({ viewport });
      await context.addCookies([{ name: 'ava_session', value: fs.readFileSync('/tmp/ava-partial-browser-cookie', 'utf8').trim(), url: origin }]);
      const blocked = [];
      await context.route('**/*', route => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        blocked.push(url);
        return route.abort();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin, { waitUntil: 'load' });
      await page.getByRole('heading', { name: 'Roles' }).waitFor();
      const setup = page.locator('section[aria-label="Setup"]');
      await setup.waitFor();
      const rolesText = await page.locator('body').innerText();
      await page.screenshot({ path: path.join(base, `${mode}-${label}-roles.png`) });
      const rolesWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
      const setupText = await setup.count() ? await setup.innerText() : null;
      const setupAnnouncements = await page.locator('section[aria-label="Setup"] [role="status"]').allInnerTexts();
      const firstScanHref = mode === 'complete-zero' ? null : await setup.getByRole('link', { name: 'Check the first scan', exact: true }).first().getAttribute('href');
      let rolesEnlarged = null;
      if (viewport.width === 375) {
        rolesEnlarged = await page.evaluate(() => {
          const sample = document.querySelector('section[aria-label="Setup"] p') ?? document.body;
          const baselinePx = parseFloat(getComputedStyle(sample).fontSize);
          const fonts = [...document.querySelectorAll('*')].map(el => ({ el, px: parseFloat(getComputedStyle(el).fontSize) }));
          for (const { el, px } of fonts) if (Number.isFinite(px) && px > 0) el.style.fontSize = `${px * 2}px`;
          return { body: document.body.scrollWidth, viewport: innerWidth, baselinePx, enlargedPx: parseFloat(getComputedStyle(sample).fontSize) };
        });
        await page.screenshot({ path: path.join(base, `${mode}-${label}-roles-text200.png`) });
        await page.reload({ waitUntil: 'load' });
        await setup.waitFor();
      }
      let setupLink = null;
      if (mode === 'queued' || mode === 'running-offline' || mode === 'complete-zero') {
        const link = setup.getByRole('link', { name: mode === 'complete-zero' ? 'Review preferences' : 'Check monitoring on Health' });
        await link.focus();
        const focussed = await link.evaluate(el => el === document.activeElement);
        await page.keyboard.press('Enter');
        await page.waitForURL(mode === 'complete-zero' ? '**/settings*' : `${origin}/health`);
        setupLink = { focussed, destination: new URL(page.url()).pathname };
        if (mode === 'queued' || mode === 'running-offline') {
          await page.goto(`${origin}/companies`, { waitUntil: 'load' });
          setupLink.companyPageExcerpt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 900);
          await page.screenshot({ path: path.join(base, `${mode}-${label}-companies.png`) });
          if (mode === 'running-offline') {
            await page.locator('summary:visible').filter({ hasText: 'Manage' }).first().click();
            const refresh = page.getByRole('button', { name: 'Waiting for monitoring' });
            setupLink.manageMenu = { refreshLabel: await refresh.innerText(), disabled: await refresh.isDisabled() };
            const healthLink = page.getByRole('link', { name: 'Check Health' }).filter({ visible: true }).first();
            await healthLink.focus();
            setupLink.companyHealthLinkFocussed = await healthLink.evaluate(el => el === document.activeElement);
            await page.keyboard.press('Enter');
            await page.waitForURL(`${origin}/health`);
            setupLink.companyHealthDestination = new URL(page.url()).pathname;
          }
        }
      }
      await page.goto(`${origin}/health`, { waitUntil: 'load' });
      await page.getByRole('heading', { name: 'Health' }).waitFor();
      const healthText = await page.locator('body').innerText();
      await page.screenshot({ path: path.join(base, `${mode}-${label}-health.png`) });
      if (mode.startsWith('interrupted')) await page.locator('section').filter({ hasText: 'Listing scan progress (1)' }).first()
        .screenshot({ path: path.join(base, `${mode}-${label}-progress.png`) });
      const healthWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
      const healthStatuses = await page.locator('[role="status"], [role="alert"]').allInnerTexts();
      let enlarged = null;
      if (viewport.width === 375) {
        enlarged = await page.evaluate(() => {
          const card = [...document.querySelectorAll('section')].find(el => el.textContent?.includes('Listing scan progress')) ?? document.body;
          const baselinePx = parseFloat(getComputedStyle(card.querySelector('p') ?? card).fontSize);
          const fonts = [...document.querySelectorAll('*')].map(el => ({ el, px: parseFloat(getComputedStyle(el).fontSize) }));
          for (const { el, px } of fonts) if (Number.isFinite(px) && px > 0) el.style.fontSize = `${px * 2}px`;
          return { body: document.body.scrollWidth, viewport: innerWidth, baselinePx, enlargedPx: parseFloat(getComputedStyle(card.querySelector('p') ?? card).fontSize) };
        });
        await page.screenshot({ path: path.join(base, `${mode}-${label}-health-text200.png`) });
      }
      let recoveryLink = null;
      if (mode.startsWith('interrupted')) {
        await page.reload({ waitUntil: 'load' });
        const link = page.getByRole('link', { name: 'Open company to Rescan' });
        await link.focus();
        const focussed = await link.evaluate(el => el === document.activeElement);
        await page.keyboard.press('Enter');
        await page.waitForURL('**/companies/*');
        await page.getByRole('button', { name: 'Rescan', exact: true }).waitFor();
        recoveryLink = { label: 'Open company to Rescan', focussed, destination: new URL(page.url()).pathname,
          rescanButtonPresent: await page.getByRole('button', { name: 'Rescan', exact: true }).count() > 0 };
      }
      observations.push({ viewport, setupText: setupText?.replace(/\s+/g, ' ') ?? null, setupAnnouncements, firstScanHref,
        rolesExcerpt: rolesText.replace(/\s+/g, ' ').slice(0, 850), rolesWidth, rolesEnlarged, setupLink,
        healthExcerpt: healthText.replace(/\s+/g, ' ').slice(0, 1800), healthStatuses, healthWidth, enlarged,
        recoveryLink, blockedExternalRequests: blocked, pageErrors: errors });
      if (rolesWidth.body > rolesWidth.viewport || healthWidth.body > healthWidth.viewport ||
          (rolesEnlarged && (rolesEnlarged.body > rolesEnlarged.viewport || rolesEnlarged.enlargedPx !== rolesEnlarged.baselinePx * 2)) ||
          (enlarged && (enlarged.body > enlarged.viewport || enlarged.enlargedPx !== enlarged.baselinePx * 2)) ||
          blocked.length || errors.length) throw new Error(`${mode}/${label}: browser integrity check failed`);
      if (mode.startsWith('interrupted') && (!healthText.includes('This listing check did not finish. Any matching roles already found remain available.') ||
          !recoveryLink?.focussed || !recoveryLink?.rescanButtonPresent)) throw new Error(`${mode}/${label}: recovery action failed`);
      if (mode === 'queued' && (!setupLink?.focussed || setupLink.destination !== '/health' || firstScanHref !== '/health' ||
          !setupLink.companyPageExcerpt?.includes('Scan queued'))) throw new Error(`${mode}/${label}: queued recovery action failed`);
      if (mode === 'running-offline' && (!setupLink?.focussed || setupLink.destination !== '/health' || firstScanHref !== '/health' ||
          !setupLink.companyPageExcerpt?.includes('Scan waiting for monitoring') || !setupLink.manageMenu?.disabled ||
          setupLink.manageMenu?.refreshLabel !== 'Waiting for monitoring' || !setupLink.companyHealthLinkFocussed ||
          setupLink.companyHealthDestination !== '/health')) throw new Error(`${mode}/${label}: stopped running-task recovery action failed`);
      if (mode === 'complete-zero' && (!setupLink?.focussed || setupLink.destination !== '/settings')) throw new Error(`${mode}/${label}: zero-result preference action failed`);
      await context.close();
    }
    const report = { fixture: 'isolated synthetic database derived from mocked 25-page listing; no production worker or live site', mode,
      at: new Date().toISOString(), observations };
    fs.writeFileSync(path.join(base, `browser-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ mode, observations: observations.map(o => ({ viewport: o.viewport.width, overflow: o.rolesWidth.body > o.rolesWidth.viewport || o.healthWidth.body > o.healthWidth.viewport,
      enlarged: o.enlarged, blocked: o.blockedExternalRequests.length, errors: o.pageErrors.length })) }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
