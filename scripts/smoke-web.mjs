/**
 * Smoke test for the interface: build it, start it, sign in, and fetch every page.
 * Fails loudly if any page errors, redirects to login, or renders a Next.js error boundary.
 *
 *   node scripts/smoke-web.mjs            (build then test)
 *   node scripts/smoke-web.mjs --no-build  (test an already built app)
 */
import { createRequire } from "node:module";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const nextBin = createRequire(new URL("../apps/web/package.json", import.meta.url)).resolve("next/dist/bin/next");

const PORT = Number(process.env.SMOKE_PORT ?? 3123);
const SECRET = "smoke-test-secret";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_dev";
const skipBuild = process.argv.includes("--no-build");

// Same shape as apps/web/lib/session.ts: "<expiresEpochSeconds>.<base64url HMAC-SHA256>".
function sessionCookie() {
  const expires = String(Math.floor(Date.now() / 1000) + 3600);
  const sig = createHmac("sha256", SECRET).update(expires).digest("base64url");
  return `christopher_session=${expires}.${sig}`;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

const PAGES = [
  ["/", ["Roles", "Location"]],
  ["/companies", ["Companies"]],
  ["/suggestions", ["Suggestions"]],
  ["/learning", ["Learning"]],
  ["/health", ["Health"]],
  ["/settings", ["Settings"]],
  ["/api/export.csv", ["company"]],
];

const ERROR_MARKERS = [
  "Application error",
  "Internal Server Error",
  "This page could not be found",
  "Unhandled Runtime Error",
];

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
  APP_PASSWORD_HASH: process.env.APP_PASSWORD_HASH ?? "",
  PORT: String(PORT),
  NODE_ENV: "production",
};

async function main() {
  if (!skipBuild) {
    console.log("building…");
    await run(process.execPath, [nextBin, "build"], { cwd: "apps/web", env });
  }

  console.log(`starting on :${PORT}…`);
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], { cwd: "apps/web", env, stdio: ["ignore", "pipe", "pipe"] });
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

  const cookie = sessionCookie();
  const failures = [];

  // An unauthenticated request must be turned away.
  const anon = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual" });
  if (anon.status !== 307 && anon.status !== 302) failures.push(`/ without a session returned ${anon.status}, expected a redirect to /login`);
  else if (!(anon.headers.get("location") ?? "").includes("/login")) failures.push(`/ redirected to ${anon.headers.get("location")}, expected /login`);

  for (const [path, expected] of PAGES) {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { cookie }, redirect: "manual" });
    } catch (err) {
      failures.push(`${path} threw: ${err.message}`);
      continue;
    }
    const body = await res.text();
    const text = visibleText(body);
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
    console.log(`  ${res.status}  ${path}  (${body.length} bytes)`);
  }

  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await Promise.race([exited, sleep(5000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await exited;
  }

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
