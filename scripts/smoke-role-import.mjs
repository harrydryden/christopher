/**
 * Built-app browser smoke for manual roles. Requires a migrated disposable database and a built web app.
 * The worker is outside this UI smoke: owned queued imports are advanced to ready with a fixture.
 * Run: node scripts/smoke-role-import.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { disposableAdmin, startWeb } from "./lib/web.mjs";

const { Pool } = createRequire(new URL("../apps/web/package.json", import.meta.url))("pg");
const { chromium } = createRequire(new URL("../apps/worker/package.json", import.meta.url))("playwright");
const port = Number(process.env.SMOKE_PORT ?? 3127);
const baseUrl = `http://127.0.0.1:${port}`;
const secret = "role-import-smoke-secret-0123456789abcdef0123456789abcdef";
const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_dev" });
const suffix = randomUUID().slice(0, 8);
const email = `role-smoke-${suffix}@ava.invalid`;
let browser;
let web;

async function readyImport(userId, id) {
  const description = "Lead operations across teams, improve delivery and reporting, coordinate stakeholders, manage budgets and risks, and communicate decisions clearly. This role requires planning and hands-on execution.";
  const { rowCount } = await pool.query(
    "update role_imports set status = 'ready', title = 'Operations Lead', company_name = 'Smoke Employer', location = 'London', description_text = $3, updated_at = now() where user_id = $1 and id = $2 and status = 'queued'",
    [userId, id, description],
  );
  assert.equal(rowCount, 1, "the owned import must be queued");
}

async function importId(page) {
  await page.waitForURL(/\/roles\/add\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split("/").at(-1);
}

try {
  const account = await disposableAdmin(pool, { email, name: "Role Smoke", domain: `role-${suffix}.invalid`, companyName: "Role Smoke", secret, userAgent: "role-smoke" });
  web = await startWeb({ port, env: { DATABASE_URL: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_dev", SESSION_SECRET: secret } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const [name, value] = account.cookie.split("=");
  await context.addCookies([{ name, value, url: baseUrl }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(baseUrl);
  await page.getByRole("link", { name: "Add a role" }).click();
  await page.getByRole("heading", { name: "Add a role" }).waitFor();
  const url = page.getByRole("textbox", { name: "Job advert link" });
  await url.fill("http://example.org/vacancy/operations");
  await page.getByRole("button", { name: "Continue to review" }).click();
  await page.getByRole("alert").getByText(/https:\/\//).waitFor();
  assert.equal(await url.inputValue(), "http://example.org/vacancy/operations", "a refused import retains the draft");
  await url.fill("https://example.org/vacancy/operations");
  await page.getByRole("button", { name: "Continue to review" }).click();
  const linkId = await importId(page);
  assert.match(await page.locator("main").innerText(), /Extracting the role/);
  await readyImport(account.userId, linkId);
  await page.reload();
  await page.getByRole("heading", { name: "Confirm role details" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "review fits a phone width");
  await page.screenshot({ path: "/tmp/role-import-review-375.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "/tmp/role-import-review-desktop.png", fullPage: true });
  await page.getByRole("textbox", { name: "Job title" }).fill("Operations Director");
  await page.getByRole("button", { name: "Save to Shortlisted" }).click();
  await page.waitForURL(/\/roles\/[0-9a-f-]{36}$/);
  await page.getByRole("heading", { name: "Operations Director" }).waitFor();
  assert.match(await page.locator("main").innerText(), /Build CV|Open Library/);
  await page.getByRole("link", { name: /Back to Roles/ }).click();
  assert.match(await page.locator("main").innerText(), /Operations Director/);

  await page.goto(`${baseUrl}/roles/add`);
  await page.getByRole("radio", { name: "Upload PDF" }).check();
  const pdfPath = process.env.SMOKE_ROLE_PDF;
  const pdf = pdfPath ? { name: "role.pdf", mimeType: "application/pdf", buffer: await readFile(pdfPath) }
    : { name: "role.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n") };
  await page.getByLabel("Job description PDF").setInputFiles(pdf);
  await page.getByRole("button", { name: "Continue to review" }).click();
  const pdfId = await importId(page);
  await readyImport(account.userId, pdfId);
  await page.reload();
  await page.getByRole("heading", { name: "Confirm role details" }).waitFor();
  await page.getByRole("button", { name: "Save to Shortlisted" }).click();
  await page.waitForURL(/\/roles\/[0-9a-f-]{36}$/);
  assert.match(await page.locator("main").innerText(), /Added from PDF/i);
  assert.doesNotMatch(await page.locator("main").innerText(), /View vacancy/);
  await page.getByText("Save your Library first.").waitFor();
  await page.screenshot({ path: "/tmp/role-import-saved-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "saved role fits a phone width");
  await page.screenshot({ path: "/tmp/role-import-saved-375.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Role import browser smoke passed (worker extraction simulated by ready fixture).");
} finally {
  await browser?.close();
  await web?.stop();
  await pool.query("delete from users where email = $1", [email]).catch(() => {});
  await pool.query("delete from companies where domain = $1", [`role-${suffix}.invalid`]).catch(() => {});
  await pool.end();
}
