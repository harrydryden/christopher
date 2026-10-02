/** Authenticated browser proof against the synthetic, AI-disabled fixture only. */
const { chromium } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = __dirname;
const origin = 'http://localhost:3145';
const mode = process.argv[2];
if (!['partial', 'terminal'].includes(mode)) throw new Error('Pass partial or terminal');

(async () => {
  const cookie = fs.readFileSync('/tmp/ava-partial-browser-cookie', 'utf8').trim();
  const browser = await chromium.launch({ headless: true });
  const observations = [];
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
      const label = viewport.width === 375 ? 'mobile-375' : 'desktop-1280';
      const context = await browser.newContext({ viewport });
      await context.addCookies([{ name: 'ava_session', value: cookie, url: origin }]);
      const blockedExternalRequests = [];
      await context.route('**/*', route => {
        const url = route.request().url();
        if (new URL(url).origin === origin) return route.continue();
        blockedExternalRequests.push(url);
        return route.abort();
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(origin, { waitUntil: 'load' });
      const firstRole = page.getByText('Operations Role 1', { exact: true }).first();
      await firstRole.waitFor({ timeout: 30000 });
      const rolesText = await page.locator('body').innerText();
      if (mode === 'partial' && rolesText.toLowerCase().includes('scanning now')) throw new Error('An initial company-follow task was misreported as a shared scan run');
      const setup = page.locator('section[aria-label="Setup"]');
      let setupText = null;
      if (mode === 'partial') {
        await setup.waitFor();
        setupText = await setup.innerText();
        if (!setupText.includes('3 of 4 done') || !setupText.includes('Check the first scan')) throw new Error(`First scan prematurely complete: ${setupText}`);
      } else if (await setup.count()) throw new Error('Setup should be complete after terminal scan');
      await page.screenshot({ path: path.join(base, `${mode}-${label}-roles-top.png`) });
      await firstRole.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(base, `${mode}-${label}-role.png`) });
      const rolesWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
      await page.goto(`${origin}/health`, { waitUntil: 'load' });
      if (mode === 'partial') {
        await page.getByText('Listing scan progress (1)').waitFor();
      }
      const healthText = await page.locator('body').innerText();
      if (mode === 'partial') {
        if (!healthText.includes('20 pages checked so far') || !healthText.includes('You can review any matching roles already found in Roles') || !healthText.includes('Monitoring must resume before the remaining pages can be checked') || !healthText.toLowerCase().includes('waiting for monitoring')) throw new Error(`Partial Health message missing: ${healthText}`);
        if (healthText.toLowerCase().includes('scanning now')) throw new Error('Stopped synthetic worker was reported as scanning now');
      } else if (healthText.includes('Listing scan progress (1)')) throw new Error('Completed generation still shown as incomplete');
      await page.screenshot({ path: path.join(base, `${mode}-${label}-health.png`) });
      if (mode === 'partial') await page.locator('section').filter({ hasText: 'Listing scan progress (1)' }).first()
        .screenshot({ path: path.join(base, `${mode}-${label}-health-progress.png`) });
      const healthWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
      let keyboardLinkReachedRole = null;
      if (mode === 'partial') {
        const reviewLink = page.getByRole('link', { name: 'Review roles' });
        await reviewLink.focus();
        if (!(await reviewLink.evaluate(el => el === document.activeElement))) throw new Error('Review roles link cannot receive keyboard focus');
        await page.keyboard.press('Enter');
        await page.waitForURL(origin + '/');
        await page.getByText('Operations Role 1', { exact: true }).first().waitFor();
        keyboardLinkReachedRole = true;
      }
      if (rolesWidth.body > rolesWidth.viewport || healthWidth.body > healthWidth.viewport) throw new Error(`Horizontal overflow at ${label}: ${JSON.stringify({ rolesWidth, healthWidth })}`);
      if (pageErrors.length || blockedExternalRequests.length) throw new Error(`Browser errors or external requests: ${JSON.stringify({ pageErrors, blockedExternalRequests })}`);
      observations.push({ viewport, roleVisible: rolesText.includes('Operations Role 1'), setupText: setupText?.replace(/\s+/g, ' ') ?? null,
        healthExcerpt: healthText.split('Background worker')[0].replace(/\s+/g, ' ').slice(0, 1200), keyboardLinkReachedRole, rolesWidth, healthWidth, pageErrors, blockedExternalRequests });
      await context.close();
    }
    const report = { fixture: 'synthetic mocked 25-page HTML listing; no live site, model, email or background worker', mode,
      at: new Date().toISOString(), observations };
    fs.writeFileSync(path.join(base, `browser-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ mode, viewports: observations.map(item => item.viewport), pageErrors: 0, blockedExternalRequests: 0 }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
