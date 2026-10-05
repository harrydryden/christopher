/**
 * What the scripts that drive a built interface share: the session cookie apps/web/lib/session.ts
 * reads, a session row to go with it, a disposable signed-in administrator, and `next start` with
 * its health poll and a stop that takes the whole process group down.
 */
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

/** apps/web/lib/session.ts's cookie: `v2.<sessionId>.<expires>.<base64url HMAC-SHA256>`. */
export function sessionCookie(secret, sessionId, expiresEpochSeconds) {
  const sig = createHmac("sha256", secret).update(`${sessionId}.${expiresEpochSeconds}`).digest("base64url");
  return `col_session=v2.${sessionId}.${expiresEpochSeconds}.${sig}`;
}

/** One session row for `userId` and the cookie that presents it. */
export async function insertSession(pool, userId, { secret, ttlSeconds, userAgent, id = randomUUID(), ipAddress = null }) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  await pool.query("insert into sessions (id, user_id, expires_at, user_agent, ip_address) values ($1, $2, to_timestamp($3), $4, $5)",
    [id, userId, expires, userAgent, ipAddress]);
  return { id, expires, cookie: sessionCookie(secret, id, expires) };
}

/**
 * A disposable administrator with an hour's session, and a throwaway company it follows. The
 * catalogue is shared, so the company is its own domain rather than a seeded one; deleting the
 * account by email and the company by domain takes everything else with them.
 */
export async function disposableAdmin(pool, { email, name, domain, companyName, secret, userAgent }) {
  const { rows: [user] } = await pool.query(
    `insert into users (email, name, role, claimed_at, email_verified_at) values ($1, $2, 'admin', now(), now())
     on conflict (email) do update set role = 'admin', claimed_at = coalesce(users.claimed_at, now()) returning id`,
    [email, name],
  );
  const { cookie } = await insertSession(pool, user.id, { secret, ttlSeconds: 3600, userAgent });
  const { rows: [company] } = await pool.query(
    `insert into companies (name, homepage_url, domain) values ($1, $2, $3)
     on conflict (domain) do update set name = excluded.name returning id`,
    [companyName, `https://${domain}`, domain],
  );
  await pool.query("insert into company_subscriptions (user_id, company_id) values ($1, $2) on conflict do nothing", [user.id, company.id]);
  return { userId: user.id, cookie, companyId: company.id };
}

/**
 * `next start` of the built interface on `port`, returned once `/api/health` answers. It runs in its
 * own process group, because `next start` forks a `next-server` that outlives its parent: every stop
 * signals the whole group, so nothing is left holding the port for the next run.
 *
 * `env` is laid over this process's environment in production mode. `logLimit` keeps the tail of
 * the server's output (0 keeps none, Infinity all of it). The health poll makes `attempts` tries
 * `intervalMs` apart, each abandoned after `probeTimeoutMs` when that is set. A server that never
 * answers is stopped and the error carries its log.
 */
export async function startWeb({ port, env = {}, host, nodeArgs = [], attempts = 60, intervalMs = 500, probeTimeoutMs,
  logLimit = 20_000, stdio = ["ignore", "pipe", "pipe"] }) {
  const nextBin = createRequire(new URL("../../apps/web/package.json", import.meta.url)).resolve("next/dist/bin/next");
  const args = [...nodeArgs, nextBin, "start", ...(host ? ["-H", host] : []), "-p", String(port)];
  const child = spawn(process.execPath, args, {
    cwd: new URL("../../apps/web", import.meta.url), detached: true, stdio,
    env: { ...process.env, NODE_ENV: "production", ...env },
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    if (logLimit > 0) stream.on("data", chunk => { output = (output + chunk).slice(-logLimit); });
    else stream.resume();
  }
  const signal = name => { try { process.kill(-child.pid, name); } catch { /* the group is already gone */ } };
  const web = {
    child,
    log: () => output,
    /** Synchronous, for a process `exit` handler. */
    kill: () => signal("SIGKILL"),
    /** With `graceMs`, SIGTERM first and up to that long to exit; then SIGKILL, and a moment for the port to free. */
    async stop({ graceMs = 0 } = {}) {
      if (graceMs > 0 && child.exitCode === null && child.signalCode === null) {
        signal("SIGTERM");
        await Promise.race([exited, sleep(graceMs)]);
      }
      signal("SIGKILL");
      await sleep(300);
    },
  };
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, probeTimeoutMs ? { signal: AbortSignal.timeout(probeTimeoutMs) } : {});
      if (response.ok) return web;
    } catch { /* not up yet */ }
    await sleep(intervalMs);
  }
  await web.stop();
  throw new Error(`the web server did not start on :${port}${output ? `:\n${output}` : ""}`);
}
