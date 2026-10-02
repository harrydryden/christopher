/** Synthetic unfinished shared run with no worker heartbeat: truthful banner proof. */
const { chromium } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const base = __dirname;
const origin = 'http://localhost:3145';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const observations = [];
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
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
      const waiting = page.getByRole('link', { name: 'Scan waiting for monitoring' });
      await waiting.waitFor();
      if ((await page.locator('body').innerText()).toLowerCase().includes('scanning now')) throw new Error('Stopped worker incorrectly presented as scanning');
      await page.screenshot({ path: path.join(base, `shared-run-stopped-${viewport.width}.png`) });
      const width = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: innerWidth }));
      if (width.body > width.viewport || blocked.length || errors.length) throw new Error(`Browser failure: ${JSON.stringify({ width, blocked, errors })}`);
      await waiting.focus();
      if (!(await waiting.evaluate(el => el === document.activeElement))) throw new Error('Waiting banner link not keyboard focusable');
      await page.keyboard.press('Enter');
      await page.waitForURL(`${origin}/health`);
      observations.push({ viewport, banner: 'Scan waiting for monitoring', destination: '/health', keyboardEnterNavigated: true,
        width, blockedExternalRequests: blocked, pageErrors: errors });
      await context.close();
    }
    fs.writeFileSync(path.join(base, 'browser-shared-run-stopped.json'), JSON.stringify({ fixture: 'synthetic unfinished shared run; no worker process or heartbeat',
      at: new Date().toISOString(), observations }, null, 2) + '\n');
    console.log('Synthetic shared-run banner proof passed at 1280px and 375px');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
