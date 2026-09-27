/**
 * Smoke test for the interface: build it, start it, sign in, and fetch every page.
 * Fails loudly if any page errors, redirects to login, or renders a Next.js error boundary.
 *
 *   node scripts/smoke-web.mjs            (build then test)
 *   node scripts/smoke-web.mjs --no-build  (test an already built app)
 */
import { verifyCvWorkspace } from "./smoke-cv.mjs";
import { verifyCvTailoringWorkspace } from "./smoke-cv-tailoring.mjs";
import { createRequire } from "node:module";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const nextBin = createRequire(new URL("../apps/web/package.json", import.meta.url)).resolve("next/dist/bin/next");

const PORT = Number(process.env.SMOKE_PORT ?? 3123);
const SECRET = "smoke-test-secret-0123456789abcdef0123456789abcdef";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_dev";
const skipBuild = process.argv.includes("--no-build");

const { Pool } = createRequire(new URL("../apps/web/package.json", import.meta.url))("pg");
const SMOKE_EMAIL = "smoke@ava.invalid";
const SMOKE_DOMAIN = "smoke.invalid";

/**
 * A disposable administrator account with one session row. Same cookie shape as apps/web/lib/session.ts:
 * "v2.<sessionId>.<expiresEpochSeconds>.<base64url HMAC-SHA256(sessionId.expires)>".
 */
async function signIn(pool) {
  const { rows: [user] } = await pool.query(
    `insert into users (email, name, role, claimed_at, email_verified_at) values ($1, 'Smoke test', 'admin', now(), now())
     on conflict (email) do update set role = 'admin', claimed_at = coalesce(users.claimed_at, now()) returning id`,
    [SMOKE_EMAIL],
  );
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const { rows: [session] } = await pool.query(
    "insert into sessions (user_id, expires_at, user_agent) values ($1, to_timestamp($2), 'smoke-web') returning id",
    [user.id, expires],
  );
  const sig = createHmac("sha256", SECRET).update(`${session.id}.${expires}`).digest("base64url");
  return { userId: user.id, cookie: `ava_session=v2.${session.id}.${expires}.${sig}` };
}

/**
 * A company this account follows, so the company page has something to render. The catalogue is
 * shared, so the row is its own throwaway domain rather than one of the seeded companies, and it
 * goes at the end with the account.
 */
async function followCompany(pool, userId) {
  const { rows: [company] } = await pool.query(
    `insert into companies (name, homepage_url, domain) values ('Smoke Company', 'https://smoke.invalid', $1)
     on conflict (domain) do update set name = excluded.name returning id`,
    [SMOKE_DOMAIN],
  );
  await pool.query(
    "insert into company_subscriptions (user_id, company_id) values ($1, $2) on conflict do nothing",
    [userId, company.id],
  );
  return company.id;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

const PAGES = [
  // The three tabs are the whole role workflow; archived roles are a section inside Dismissed.
  // The smoke account has nothing matched, which is exactly when the table opens on Shortlisted.
  // The setup checklist explains the blank table: the smoke account has confirmed its address and
  // follows one company, and nothing else, so it reads "1 of 5 done" and cannot be hidden.
  ["/", ["Roles", "Location", "Shortlisted", "Matched", "Dismissed", "Start here", "Choose keywords and locations", "Fill the Library", "1 of 5 done"], "Shortlisted"],
  // The header carries the shared schedule: one scan a day for every follower.
  // Filters first: an account that has not chosen its gate is asked for it above the add form.
  ["/companies", ["Companies", "next scheduled scan", "Choose your filters first"]],
  ["/suggestions", ["Discover companies", "Companies to review"]],
  ["/suggestions?view=sources", ["Add a source"]],
  ["/suggestions?view=history", ["Recently reviewed"]],
  ["/learning", ["Learning"]],
  // Health's attention list and the resolution on the item the smoke company raises: no source yet.
  ["/health", ["Health", "Needs you", "No careers page to scan", "Re-discover"]],
  ["/settings", ["Settings", "Seed profile", "Writing preferences are on the"]],
  ["/account", ["Account", "Sign-in methods"]],
  ["/admin", ["Admin", "Registration", "Accounts"]],
  ["/admin/settings", ["System settings", "Schedule"]],
  ["/admin/catalogue", ["Company catalogue"]],
  ["/admin/health", ["Operations"]],
  // The CV list has gone: `/cv` is a redirect into the applications table, which holds the CVs.
  ["/cv", { redirectsTo: "/applications" }],
  ["/library", ["Library", "Intro", "Email", "Phone", "Location", "Other contact details", "Bio", "Website",
    "Experience", "Education, skills and interests",
    "Import a document", "Upload a CV", "Paste text", "Read your website",
    "AVA does not read LinkedIn itself.",
    "Writing preferences", "Writing style", "Saved phrasing", "No library saved yet"]],
  ["/applications", ["Applications", "Active", "Closed", "Roles by stage", "What the stages mean"]],
  ["/?archive=1", ["Roles", "Archived"], "Dismissed"],
  ["/?view=auto-matched", ["Roles"], "Matched"],
  ["/?view=user-shortlisted", ["Roles"], "Shortlisted"],
  // The Decided sort and the This week chip render only on the Shortlisted and Dismissed tabs.
  ["/?view=user-shortlisted&since=7d", ["Roles", "This week"], "Shortlisted"],
  ["/?view=user-dismissed", ["Roles", "Archived"], "Dismissed"],
  ["/?view=archived", ["Roles", "Archived"], "Dismissed"],
  // The status strip reads four facts; the payload carries them as fields, not as a sentence.
  ["/api/scan-status", ['"following"', '"newRoleMatches"']],
  ["/api/export.csv", ["company"]],
];

const ERROR_MARKERS = [
  "Application error",
  "Internal Server Error",
  "This page could not be found",
  "Unhandled Runtime Error",
];

/**
 * What a cache may hold. Every response here is per account unless it is on this list: shared
 * catalogue bytes (a company's captured logo) and build output, which carry no account's data.
 */
const PUBLIC_PATHS = [/^\/api\/companies\/[^/]+\/logo$/, /^\/_next\/static\//, /^\/(icon\.svg|apple-icon\.png|favicon\.ico)$/];

/**
 * Why a signed-in response could be held by a cache and served to someone else, if it could.
 * Vercel's CDN stores a function response only when it says `s-maxage` or carries
 * `CDN-Cache-Control`; Next's `Vary` leaves out `Cookie`, so what stands between one account's
 * table and another account's browser is `private, no-store` on every page and every RSC refetch.
 * An API answer needs `no-store` only, which already forbids every cache. A `set-cookie` would make
 * a response per client in a way no cache key reflects, so none is allowed on a read.
 */
function cachePolicyFailures(path, res, kind = path.startsWith("/api/") ? "api" : "page") {
  if (PUBLIC_PATHS.some(pattern => pattern.test(new URL(path, "http://smoke.invalid").pathname))) return [];
  const failures = [];
  const header = res.headers.get("cache-control") ?? "";
  const directives = header.toLowerCase().split(",").map(part => part.trim().split("=")[0]);
  const needed = kind === "api" ? ["no-store"] : ["private", "no-store"];
  for (const directive of needed) {
    if (!directives.includes(directive)) failures.push(`${path} (${kind}) cache-control "${header}" lacks ${directive}`);
  }
  for (const directive of ["public", "s-maxage"]) {
    if (directives.includes(directive)) failures.push(`${path} (${kind}) cache-control "${header}" says ${directive}`);
  }
  for (const name of ["cdn-cache-control", "vercel-cdn-cache-control"]) {
    if (res.headers.get(name)) failures.push(`${path} (${kind}) sends ${name}: ${res.headers.get(name)}`);
  }
  if (res.headers.get("set-cookie")) failures.push(`${path} (${kind}) sets a cookie on a read`);
  return failures;
}

/** Next's own `Vary` on pages and RSC; anything beyond it (above all `Cookie`) changes what a cache keys on. */
const NEXT_VARY = new Set(["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "accept-encoding"]);

/** The static security headers `next.config.ts` sends on every response, and the one `/share/` overrides. */
function securityHeaderFailures(path, res, referrer = "strict-origin-when-cross-origin") {
  const failures = [];
  const expect = (name, test, wanted) => {
    const value = res.headers.get(name);
    if (value === null || !test(value)) failures.push(`${path} ${name}: ${value ?? "(missing)"}, expected ${wanted}`);
  };
  expect("x-content-type-options", value => value === "nosniff", "nosniff");
  expect("referrer-policy", value => value === referrer, referrer);
  expect("content-security-policy", value => value.includes("frame-ancestors 'none'"), "frame-ancestors 'none'");
  expect("content-security-policy-report-only", value => value.includes("default-src 'self'") && value.includes("'sha256-"), "a report-only policy with 'self' and a hash");
  expect("permissions-policy", value => value.includes("camera=()"), "a Permissions-Policy");
  const vary = (res.headers.get("vary") ?? "").toLowerCase().split(",").map(part => part.trim()).filter(Boolean);
  const extra = vary.filter(name => !NEXT_VARY.has(name));
  if (extra.length) failures.push(`${path} varies on ${extra.join(", ")}, beyond Next's own`);
  return failures;
}

/**
 * Next.js serialises its not-found and error boundaries into every page's script payload, so the
 * markers must be looked for in visible text only.
 */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

const env = {
  ...process.env,
  DATABASE_URL,
  SESSION_SECRET: SECRET,
  PORT: String(PORT),
  NODE_ENV: "production",
};

async function main() {
  if (!skipBuild) {
    console.log("building…");
    await run(process.execPath, [nextBin, "build"], { cwd: "apps/web", env });
  }

  console.log(`starting on :${PORT}…`);
  // `next start` forks a `next-server` child that outlives its parent, so the server gets its own
  // process group and, whatever happens below, the whole group is killed on exit rather than left
  // on the port for the next run to find.
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], { cwd: "apps/web", env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  process.on("exit", () => { try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ } });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d.toString()));
  server.stderr.on("data", (d) => (serverLog += d.toString()));

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  if (!ready) {
    console.error(serverLog);
    server.kill("SIGTERM");
    throw new Error("the server never became ready");
  }

  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const { cookie, userId } = await signIn(pool);
  const failures = [];

  // An unauthenticated request must be turned away.
  const anon = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
  if (anon.status !== 307 && anon.status !== 302) failures.push(`/ without a session returned ${anon.status}, expected a redirect to /login`);
  else if (!(anon.headers.get("location") ?? "").includes("/login")) failures.push(`/ redirected to ${anon.headers.get("location")}, expected /login`);

  // The company page and its logo are per company, so they join the list once there is one.
  const companyId = await followCompany(pool, userId);
  // The company with no source shows the setup card; the header says when it was last scanned,
  // when the next scan is due, and how many roles here this account is pursuing.
  const pages = [...PAGES, [`/companies/${companyId}`, ["Roles", "Add a role", "Notepad", "Set up this company", "next scheduled scan", "applications", "What has happened so far", "Nobody has looked for this"]]];

  for (const [path, expected, selectedStatus] of pages) {
    let res;
    let body;
    try {
      // A page that never finishes streaming shows up here as a body timeout, with the server log below.
      res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(45_000) });
      body = await res.text();
    } catch (err) {
      failures.push(`${path} threw: ${err.cause?.message ?? err.message}`);
      // A server that stops answering will not recover for the next page; stop and report with its log.
      if (err.name === "TimeoutError" || err.name === "AbortError") break;
      continue;
    }
    // A retired path is checked the way the signed-out root is: the status and the destination.
    const redirectsTo = Array.isArray(expected) ? null : expected.redirectsTo;
    if (redirectsTo) {
      const location = res.headers.get("location") ?? "";
      // Next sends an absolute Location; compare the part of it that is ours.
      const target = location.startsWith("http") ? new URL(location).pathname + new URL(location).search : location;
      if (res.status !== 307 && res.status !== 308) failures.push(`${path} returned ${res.status}, expected a redirect to ${redirectsTo}`);
      else if (!target.startsWith(redirectsTo)) failures.push(`${path} redirected to ${location}, expected ${redirectsTo}`);
      else console.log(`  ${res.status}  ${path}  -> ${location}`);
      failures.push(...cachePolicyFailures(path, res, "api"));
      continue;
    }
    const text = visibleText(body);
    failures.push(...cachePolicyFailures(path, res));
    failures.push(...securityHeaderFailures(path, res));
    if (res.status !== 200) {
      failures.push(`${path} returned ${res.status}${res.headers.get("location") ? ` -> ${res.headers.get("location")}` : ""}`);
      continue;
    }
    for (const marker of ERROR_MARKERS) {
      if (text.includes(marker)) failures.push(`${path} shows the error "${marker}"`);
    }
    for (const needle of expected) {
      if (!text.includes(needle) && !body.includes(needle)) failures.push(`${path} does not mention "${needle}"`);
    }
    if (selectedStatus) {
      const statusNav = body.match(/<nav\b[^>]*aria-label="Role status"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
      const selected = statusNav.match(/<a\b[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
      if (!visibleText(selected).includes(selectedStatus)) failures.push(`${path} does not select the ${selectedStatus} view`);
    }
    console.log(`  ${res.status}  ${path}  (${body.length} bytes)`);
  }

  // A client-side navigation fetches the same page as an RSC payload; it is as per-account as the
  // HTML and must be as uncacheable, or a shared cache would hand one account's table to the next.
  for (const path of ["/", `/companies/${companyId}`]) {
    try {
      const rsc = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { cookie, RSC: "1" }, redirect: "manual", signal: AbortSignal.timeout(45_000) });
      const payload = await rsc.text();
      if (rsc.status !== 200 || !(rsc.headers.get("content-type") ?? "").includes("text/x-component")) {
        failures.push(`RSC ${path} returned ${rsc.status} ${rsc.headers.get("content-type")}, expected a 200 text/x-component payload`);
      } else console.log(`  ${rsc.status}  RSC ${path}  (${payload.length} bytes)`);
      failures.push(...cachePolicyFailures(`${path} [RSC]`, rsc, "page"));
      failures.push(...securityHeaderFailures(`${path} [RSC]`, rsc));
    } catch (err) {
      failures.push(`RSC ${path} threw: ${err.cause?.message ?? err.message}`);
    }
  }

  // The sign-in page carries the same headers before anyone has a session, and a share link sends
  // no referrer at all: its URL is the credential. An unknown token still gets the share headers.
  for (const [path, referrer] of [["/login", undefined], ["/share/not-a-real-token", "no-referrer"]]) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      await res.arrayBuffer();
      const found = securityHeaderFailures(path, res, referrer);
      failures.push(...found);
      if (!found.length) console.log(`  ${res.status}  ${path}  (security headers)`);
    } catch (err) {
      failures.push(`${path} threw: ${err.cause?.message ?? err.message}`);
    }
  }

  // A company with no captured logo answers 404, one the worker has captured answers 200. A 500
  // means the route is broken, and an image that 500s is invisible on every page that shows it.
  const logoPath = `/api/companies/${companyId}/logo`;
  try {
    const logo = await fetch(`http://127.0.0.1:${PORT}${logoPath}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (logo.status !== 200 && logo.status !== 404) failures.push(`${logoPath} returned ${logo.status}, expected 200 or 404`);
    else console.log(`  ${logo.status}  ${logoPath}`);
    // Only the 200 for a URL naming the stored capture may go to the CDN; this URL names none.
    if (logo.headers.get("cdn-cache-control")) failures.push(`${logoPath} (${logo.status}, unversioned) sends cdn-cache-control: ${logo.headers.get("cdn-cache-control")}`);
  } catch (err) {
    failures.push(`${logoPath} threw: ${err.cause?.message ?? err.message}`);
  }

  // A captured logo, through the built server: the versioned 200 goes to the CDN and keeps the
  // route's own sandbox policy over the site-wide headers, and a revalidation is a bare 304.
  // The row goes with the throwaway company at the end.
  try {
    const { rows: [stored] } = await pool.query(
      `insert into company_logos (company_id, content_type, data_base64, byte_length, source, source_url, fetched_at)
       values ($1, 'image/png', $2, 8, 'site_icon', 'https://smoke.invalid/icon.png', date_trunc('milliseconds', now())) returning (extract(epoch from fetched_at) * 1000)::bigint as v`,
      [companyId, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")],
    );
    const versioned = `${logoPath}?v=${stored.v}`;
    const hit = await fetch(`http://127.0.0.1:${PORT}${versioned}`, { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
    await hit.arrayBuffer();
    if (hit.status !== 200) failures.push(`${versioned} returned ${hit.status}, expected 200`);
    if (hit.headers.get("cdn-cache-control") !== "public, max-age=31536000, immutable") failures.push(`${versioned} cdn-cache-control: ${hit.headers.get("cdn-cache-control")}`);
    if (!(hit.headers.get("content-security-policy") ?? "").includes("sandbox")) failures.push(`${versioned} lost its sandbox policy: ${hit.headers.get("content-security-policy")}`);
    const again = await fetch(`http://127.0.0.1:${PORT}${versioned}`, { headers: { cookie, "if-none-match": hit.headers.get("etag") ?? "" }, signal: AbortSignal.timeout(15_000) });
    if (again.status !== 304 || again.headers.get("cdn-cache-control")) failures.push(`${versioned} revalidated as ${again.status} with cdn-cache-control ${again.headers.get("cdn-cache-control")}, expected a 304 without it`);
    else console.log(`  ${hit.status}  ${versioned}  then ${again.status}`);
  } catch (err) {
    failures.push(`${logoPath} (captured) threw: ${err.cause?.message ?? err.message}`);
  }

  try { await verifyCvWorkspace(`http://127.0.0.1:${PORT}`, cookie, DATABASE_URL, userId); }
  catch (error) { failures.push(`CV browser flow: ${error.message}`); }
  try { await verifyCvTailoringWorkspace(`http://127.0.0.1:${PORT}`, cookie, DATABASE_URL, userId); }
  catch (error) { failures.push(`CV tailoring browser flow: ${error.message}`); }

  // The disposable account takes its sessions, settings and drafts with it, and the throwaway
  // company takes its subscription.
  await pool.query("delete from users where email = $1", [SMOKE_EMAIL]);
  await pool.query("delete from companies where domain = $1", [SMOKE_DOMAIN]);
  await pool.end();

  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await exited;
  }
  try { process.kill(-server.pid, "SIGKILL"); } catch { /* the group is already gone */ }

  if (failures.length) {
    console.error("\nFAILURES:");
    for (const f of failures) console.error(`  - ${f}`);
    console.error("\nserver output:\n" + serverLog.slice(-4000));
    process.exit(1);
  }
  console.log("\nall pages rendered");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
