/** Synthetic local DB and browser check; blocks requests outside localhost. */
const { chromium } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const origin = 'http://localhost:3145';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const observations = [];
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
      execFileSync('node', [path.join(root, 'seed.cjs')]);
      const label = viewport.width === 375 ? 'mobile-375' : 'desktop-1280';
      const context = await browser.newContext({ viewport });
      await context.addCookies([{ name: 'ava_session', value: fs.readFileSync('/tmp/ava-locations-web-cookie','utf8'), url: origin }]);
      const blocked = [];
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (blocked.push(route.request().url()), route.abort()));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin+'/health', { waitUntil: 'load' });
      await page.getByRole('heading', { name: 'Health', exact: true }).waitFor();
      const card = page.locator('section').filter({ hasText: 'Role locations to check (3)' }).first();
      await card.waitFor();
      const before = await card.innerText();
      const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      await page.screenshot({ path: path.join(root,`${label}-health-before.png`) });
      await card.screenshot({ path: path.join(root,`${label}-location-card-before.png`) });
      let text200 = null;
      if (viewport.width === 375) {
        text200 = await page.evaluate(() => {
          const card = [...document.querySelectorAll('section')].find(el => el.textContent?.includes('Role locations to check (3)'));
          const sample = card.querySelector('p');
          const baseline = parseFloat(getComputedStyle(sample).fontSize);
          const fonts = [...document.querySelectorAll('*')].map(el => ({ el, size: parseFloat(getComputedStyle(el).fontSize) }));
          for (const {el,size} of fonts) if (Number.isFinite(size) && size>0) el.style.fontSize = `${size*2}px`;
          return { baseline, enlarged: parseFloat(getComputedStyle(sample).fontSize), viewport: innerWidth, document: document.documentElement.scrollWidth };
        });
        const enlargedCard = page.locator('section').filter({ hasText: 'Role locations to check (3)' }).first();
        await enlargedCard.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(root,`${label}-health-text200.png`) });
        await enlargedCard.screenshot({ path: path.join(root,`${label}-location-card-text200.png`) });
        await page.reload({ waitUntil: 'load' });
      }
      const retry = page.getByRole('button', { name: 'Retry location check' }).first();
      await retry.focus();
      const keyboardFocus = await retry.evaluate(el => el === document.activeElement);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      await page.reload({ waitUntil: 'load' });
      const afterRetry = await page.locator('section').filter({ hasText: 'Role locations to check (3)' }).first().innerText();
      const start = page.getByRole('button', { name: 'Start location check' }).first();
      await start.click();
      await page.waitForTimeout(600);
      await page.reload({ waitUntil: 'load' });
      const afterStart = await page.locator('section').filter({ hasText: 'Role locations to check (3)' }).first().innerText();
      await page.screenshot({ path: path.join(root,`${label}-health-after.png`) });
      const companyLink = page.getByRole('link', { name: 'Workday fixture' }).first();
      await companyLink.focus();
      const linkFocus = await companyLink.evaluate(el => el === document.activeElement);
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/companies\//);
      const companyCard = page.locator('section').filter({ hasText: 'Role locations to check (3)' }).first();
      await companyCard.waitFor();
      const companyText = await companyCard.innerText();
      await page.screenshot({ path: path.join(root,`${label}-company.png`) });
      const result = { viewport, before, afterRetry, afterStart, companyText, width, text200, keyboardFocus, linkFocus, companyDestination: new URL(page.url()).pathname, pageErrors: errors, blockedExternalRequests: blocked };
      if (!before.includes('Monitoring needs an administrator') || !before.includes('Locations could not be read') ||
          !before.includes('Waiting for monitoring') || !afterRetry.includes('3 waiting for location details') ||
          !afterStart.includes('3 waiting for location details') || !keyboardFocus || !linkFocus ||
          width.document > width.viewport || (text200 && (text200.enlarged !== text200.baseline*2 || text200.document > text200.viewport)) ||
          errors.length || blocked.some(url => !url.startsWith('https://icons.duckduckgo.com/ip3/')) || !companyText.includes('ROLE LOCATIONS TO CHECK (3)')) throw new Error(`${label}: browser assertion failed: ${JSON.stringify(result)}`);
      observations.push(result);
      await context.close();
    }
    fs.writeFileSync(path.join(root,'browser-check.json'), JSON.stringify({ fixture: 'synthetic local Workday rows; no worker running', checkedAt: new Date().toISOString(), observations }, null, 2)+'\n');
    console.log(JSON.stringify({ passed: observations.length, widths: observations.map(o=>o.width), text200: observations.map(o=>o.text200), pageErrors: observations.map(o=>o.pageErrors.length), blocked: observations.map(o=>o.blockedExternalRequests.length) }));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
