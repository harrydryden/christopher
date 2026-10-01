/** Synthetic scheduled-read UI proof; no worker or external request. */
const { chromium } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/playwright@1.56.1/node_modules/playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const origin = 'http://localhost:3145';
(async()=>{
  execFileSync('node',[path.join(root,'seed.cjs'),'scheduled']);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:375,height:812}});
    await context.addCookies([{name:'ava_session',value:fs.readFileSync('/tmp/ava-locations-web-cookie','utf8'),url:origin}]);
    const blocked=[];await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()));
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/health',{waitUntil:'load'});
    const card=page.locator('section').filter({hasText:'Role locations to check (3)'}).first();await card.waitFor();
    const text=await card.innerText();const scheduled=card.locator('time').first();
    const time={visible:await scheduled.innerText(),dateTime:await scheduled.getAttribute('datetime'),title:await scheduled.getAttribute('title'),ariaLabel:await scheduled.getAttribute('aria-label')};
    await card.screenshot({path:path.join(root,'mobile-375-scheduled-card.png')});
    const width=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth}));
    const result={fixture:'synthetic queued task with run_after about one hour ahead and synthetic fresh heartbeat; no real worker',checkedAt:new Date().toISOString(),text,time,width,pageErrors:errors,blockedExternalRequests:blocked};
    if(!text.includes('Waiting before checking this careers site again.')||!text.includes('Next check in 1h.')||!text.includes('SCHEDULED')||text.includes('Waiting for monitoring to resume.')||!time.dateTime||!time.title?.includes('UK time')||!time.ariaLabel?.includes('UK time')||width.document>width.viewport||errors.length||blocked.some(x=>!x.startsWith('https://icons.duckduckgo.com/ip3/')))throw new Error(JSON.stringify(result));
    fs.writeFileSync(path.join(root,'browser-scheduled.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:true,time,width,pageErrors:errors.length,blocked:blocked.length}));
    await context.close();
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
