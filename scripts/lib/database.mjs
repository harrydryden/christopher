/** The loopback hosts a script may treat as this machine; a bracketed address is how a URL spells IPv6. */
const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];

/**
 * `input` as a URL when it names a PostgreSQL database on this machine whose name is `name` (or
 * matches it, given a pattern) and does not match `forbid`; otherwise throws `message`. The guard
 * every script that writes fixtures or restores puts in front of its database.
 */
export function localDatabaseUrl(input, { name, forbid, message }) {
  let url;
  try { url = new URL(input); } catch { throw new Error(message); }
  const database = decodeURIComponent(url.pathname.slice(1));
  const named = typeof name === "string" ? database === name : name.test(database);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !LOOPBACK.includes(url.hostname) || !named || forbid?.test(database))
    throw new Error(message);
  return url;
}
