/**
 * What the scripts that drive a built interface share: the session cookie apps/web/lib/session.ts
 * reads, a session row to go with it, and a disposable signed-in administrator.
 */
import { createHmac, randomUUID } from "node:crypto";

/** apps/web/lib/session.ts's cookie: `v2.<sessionId>.<expires>.<base64url HMAC-SHA256>`. */
export function sessionCookie(secret, sessionId, expiresEpochSeconds) {
  const sig = createHmac("sha256", secret).update(`${sessionId}.${expiresEpochSeconds}`).digest("base64url");
  return `ava_session=v2.${sessionId}.${expiresEpochSeconds}.${sig}`;
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
