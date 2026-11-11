import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { insertSession } from "./lib/web.mjs";
import "tsx/esm";
const require = createRequire(import.meta.url);
require("tsx/cjs");
const { createDb, saveCareerChange, schema } = require("../packages/db/src/index.ts");
const { eq } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");

/** A new member with no follows can discover and shortlist real catalogue roles, without model work. */
export async function verifyCareerRecommendations(baseUrl, databaseUrl, secret) {
  const { db, pool } = createDb(databaseUrl);
  let browser;
  let userId;
  let companyId;
  try {
    const [user] = await db.insert(schema.users).values({ email: `career-${randomUUID()}@smoke.invalid`,
      name: "Career Smoke", claimedAt: new Date(), emailVerifiedAt: new Date() }).returning();
    userId = user.id;
    const { cookie } = await insertSession(pool, userId, { secret, ttlSeconds: 3600, userAgent: "career-smoke" });
    const [company] = await db.insert(schema.companies).values({ name: "Career Match Company",
      domain: `${randomUUID()}.invalid`, homepageUrl: "https://career-smoke.invalid" }).returning();
    companyId = company.id;
    const [source] = await db.insert(schema.careerSources).values({ companyId, type: "html",
      url: "https://career-smoke.invalid/jobs" }).returning();
    const [job] = await db.insert(schema.jobs).values({ companyId, sourceId: source.id, externalKey: randomUUID(),
      title: "Service Operations Lead", normalizedTitle: "service operations lead", location: "London",
      descriptionText: "Lead service operations and improve customer support.", url: "https://career-smoke.invalid/jobs/1" }).returning();
    await saveCareerChange(db, userId, { expectedRevision: 0, requestKey: randomUUID(), operations: [{
      type: "create_record", id: randomUUID(), kind: "role", fields: { title: "Service Operations Manager",
        originalNarrative: "Led service operations and improved customer support.",
        dates: { start: "2024-01", end: null, current: true }, arrangement: "contract",
        publicLabel: null, confidential: false, industries: [] },
    }] });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: "col_session", value: cookie.slice("col_session=".length), url: baseUrl }]);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/suggestions`);
    const region = page.getByRole("region", { name: "Matches from your Experience" });
    await region.getByText("Career Match Company", { exact: false }).waitFor();
    await region.getByRole("link", { name: "Service Operations Lead ↗", exact: true }).waitFor();
    assert.match(await region.innerText(), /Relevant experience:.*Operations/i);
    const screenshotDir = process.env.SMOKE_SCREENSHOT_DIR ? resolve(process.env.SMOKE_SCREENSHOT_DIR) : null;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await region.screenshot({ path: join(screenshotDir, "career-recommendations-desktop.png") });
    }
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `recommendations fit a ${width}px screen`);
      if (screenshotDir) await region.screenshot({ path: join(screenshotDir, `career-recommendations-${width}.png`) });
    }
    await region.getByRole("button", { name: "Shortlist Service Operations Lead", exact: true }).click();
    try { await region.getByRole("link", { name: "Shortlisted · Open roles", exact: true }).waitFor(); }
    catch (error) {
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "career-recommendations-failure.png"), fullPage: true });
      throw new Error(`Recommendation choice failed: ${await region.innerText()}`, { cause: error });
    }
    const saved = await pool.query("select decision from decisions where user_id=$1 and job_id=$2 and superseded=false", [userId, job.id]);
    assert.deepEqual(saved.rows, [{ decision: "apply" }]);
    const counts = await pool.query(`select
      (select count(*)::int from company_subscriptions where user_id=$1) follows,
      (select count(*)::int from ai_calls where user_id=$1) calls,
      (select count(*)::int from credit_reservations where user_id=$1) credits`, [userId]);
    assert.deepEqual(counts.rows[0], { follows: 0, calls: 0, credits: 0 });
    await region.getByRole("link", { name: "Shortlisted · Open roles", exact: true }).click();
    await page.getByRole("row").filter({ hasText: "Service Operations Lead" }).waitFor();
    await page.goto(`${baseUrl}/suggestions`);
    assert.equal(await page.getByRole("button", { name: "Shortlist Service Operations Lead", exact: true }).count(), 0);
    console.log("  career recommendations: zero-follow discovery, phone layout and free shortlist verified");
  } finally {
    await browser?.close();
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    if (companyId) await db.delete(schema.companies).where(eq(schema.companies.id, companyId));
    await pool.end();
  }
}
