/**
 * `attachDatabasePool` recognises a pool by its shape and throws on one it does not know, which in
 * `db()` would fail every request. The real function against the real pool `createDb` returns, so
 * a change to either is caught here rather than on Vercel. Opening a pool connects to nothing.
 */
import { expect, it } from "vitest";
import { attachDatabasePool } from "@vercel/functions/db-connections";
import { createDb } from "@ava/db/client";

it("accepts the interface's pool and listens for its releases", async () => {
  const { pool } = createDb("postgres://ava:secret@dpg-abc123-a.frankfurt-postgres.render.com:6432/ava", { idleTimeoutMillis: 120_000 });
  try {
    const before = pool.listenerCount("release");
    expect(() => attachDatabasePool(pool)).not.toThrow();
    expect(pool.listenerCount("release")).toBe(before + 1);
    expect(pool.options.idleTimeoutMillis).toBe(120_000);
    expect(pool.options.keepAlive).toBe(true);
  } finally {
    await pool.end();
  }
});
