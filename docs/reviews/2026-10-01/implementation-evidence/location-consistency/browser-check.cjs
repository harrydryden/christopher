/** Local-only real Chromium check of role location disclosure at desktop and mobile widths. */
const { chromium } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');

const origin = 'http://localhost:3146';
const cookie = fs.readFileSync('/tmp/ava-locations-web-cookie', 'utf8');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const observations = [];
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
      const label = viewport.width === 375 ? 'mobile-375' : 'desktop-1280';
      const context = await browser.newContext({ viewport });
      const blockedExternalRequests = [];
      await context.addCookies([{ name: 'ava_session', value: cookie, url: origin }]);
      await context.route('**/*', route => new URL(route.request().url()).origin === origin
        ? route.continue()
        : (blockedExternalRequests.push(route.request().url()), route.abort()));
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(origin, { waitUntil: 'load' });
      const row = page.locator('tbody tr').filter({ hasText: 'Payroll consultant — 70 locations' }).first();
      await row.waitFor();
      const details = row.locator('details');
      const summary = details.locator('summary');
      const shortRow = page.locator('tbody tr').filter({ hasText: 'Operations consultant — two locations' }).first();
      const shortText = await shortRow.innerText();
      const longRow = page.locator('tbody tr').filter({ hasText: 'Location wrapping fixture' }).first();
      const longDetails = longRow.locator('details');
      await longDetails.locator('summary').click();
      const longWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      await longDetails.locator('summary').click();
      const initial = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      const collapsedText = await summary.innerText();
      const collapsed = await details.evaluate(el => !el.open);
      await page.screenshot({ path: path.join(__dirname, `${label}-collapsed.png`), fullPage: true });

      await summary.focus();
      const keyboardFocus = await summary.evaluate(el => el === document.activeElement);
      await page.keyboard.press('Enter');
      const expanded = await details.evaluate(el => el.open);
      const allLocations = await details.locator('li').allInnerTexts();
      const expandedWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      const listHeight = await details.locator('ul').evaluate(el => el.getBoundingClientRect().height);
      await page.keyboard.press('End');
      await page.waitForTimeout(500);
      const pageScroll = await details.locator('ul').evaluate(el => {
        const last = el.lastElementChild;
        return { scrollTop: document.scrollingElement.scrollTop,
          lastTop: last.getBoundingClientRect().top, lastBottom: last.getBoundingClientRect().bottom,
          viewportHeight: innerHeight };
      });
      const lastLocationReached = pageScroll.scrollTop > 0 && pageScroll.lastTop >= 0 && pageScroll.lastBottom <= pageScroll.viewportHeight + 1;
      await page.screenshot({ path: path.join(__dirname, `${label}-expanded.png`), fullPage: true });

      await summary.focus();
      await page.keyboard.press('Space');
      const collapsedAgain = await details.evaluate(el => !el.open);
      const frameworkError = await page.locator('[data-nextjs-dialog], .vite-error-overlay').count();
      const result = { viewport, collapsedText, collapsed, keyboardFocus, expanded, lastLocationReached, pageScroll, collapsedAgain,
        count: allLocations.length, first: allLocations[0], last: allLocations.at(-1), shortText,
        initial, expandedWidth, longWidth, listHeight, frameworkError, pageErrors, blockedExternalRequests };
      if (!collapsed || !keyboardFocus || !expanded || !lastLocationReached || !collapsedAgain ||
          !collapsedText.includes('USA, GA, Atlanta + 69 more locations') ||
          allLocations.length !== 70 || allLocations.at(-1) !== 'USA, AZ, Scottsdale' ||
          !allLocations.includes('USA, MA, Boston') || !shortText.includes('London, Manchester') ||
          initial.document > initial.viewport || expandedWidth.document > expandedWidth.viewport ||
          longWidth.document > longWidth.viewport ||
          frameworkError || pageErrors.length) {
        throw new Error(`${label}: ${JSON.stringify(result)}`);
      }
      observations.push(result);
      await context.close();
    }
    fs.writeFileSync(path.join(__dirname, 'browser-check.json'), JSON.stringify({
      fixture: 'synthetic local roles in ava_locations_web; external browser requests blocked',
      checkedAt: new Date().toISOString(), observations,
    }, null, 2) + '\n');
    console.log(JSON.stringify({ passed: observations.length, widths: observations.map(o => o.expandedWidth),
      counts: observations.map(o => o.count), pageErrors: observations.map(o => o.pageErrors.length),
      blockedExternalRequests: observations.map(o => o.blockedExternalRequests.length) }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
