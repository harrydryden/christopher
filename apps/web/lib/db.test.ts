/**
 * The interface pool: 3 wide on the direct endpoint and 6 through PgBouncer, with an override; idle
 * connections kept two minutes through PgBouncer and 30 seconds direct; and the pool handed to
 * Vercel so its idle connections are closed before the instance is suspended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createDb = vi.hoisted(() => vi.fn());
const attachDatabasePool = vi.hoisted(() => vi.fn());
vi.mock("@col/db/client", async (original) => ({ ...(await original<typeof import("@col/db/client")>()), createDb }));
vi.mock("@vercel/functions/db-connections", () => ({ attachDatabasePool }));

import { DIRECT_IDLE_TIMEOUT_MS, DIRECT_POOL_MAX, POOLED_IDLE_TIMEOUT_MS, POOLED_POOL_MAX, webPoolIdleTimeoutMs, webPoolMax } from "./db";

const direct = "postgres://ava:secret@dpg-abc123-a.frankfurt-postgres.render.com:5432/ava";
const pooled = "postgres://ava:secret@dpg-abc123-a.frankfurt-postgres.render.com:6432/ava";

describe("webPoolMax", () => {
  it("keeps three connections where each is a database backend", () => {
    expect(DIRECT_POOL_MAX).toBe(3);
    expect(webPoolMax(direct, undefined)).toBe(3);
    expect(webPoolMax("postgres://dpg-abc123-a/ava", undefined)).toBe(3);
    expect(webPoolMax("postgres://postgres:postgres@127.0.0.1:5432/ava", undefined)).toBe(3);
    // Not a URL at all: the careful default.
    expect(webPoolMax("not a url", undefined)).toBe(3);
  });

  it("opens six through PgBouncer: Render's port 6432, as the address or a parameter, or a pooler host", () => {
    expect(POOLED_POOL_MAX).toBe(6);
    expect(webPoolMax(pooled, undefined)).toBe(6);
    expect(webPoolMax("postgres://ava:secret@dpg-abc123-a/ava?port=6432", undefined)).toBe(6);
    expect(webPoolMax("postgres://ava:secret@ep-quiet-sun-123-pooler.eu-central-1.example.com/ava", undefined)).toBe(6);
    // "pooler" elsewhere in the name is not a pooler host.
    expect(webPoolMax("postgres://ava:secret@pooler-notes.example.com/ava", undefined)).toBe(3);
  });

  it("takes WEB_DB_POOL_MAX from 1 to 20 over either default, and ignores anything else", () => {
    expect(webPoolMax(direct, "8")).toBe(8);
    expect(webPoolMax(pooled, "1")).toBe(1);
    expect(webPoolMax(pooled, "20")).toBe(20);
    for (const ignored of ["0", "21", "-3", "4.5", "six", "", "  "]) {
      expect(webPoolMax(pooled, ignored), ignored).toBe(6);
      expect(webPoolMax(direct, ignored), ignored).toBe(3);
    }
  });
});

describe("webPoolIdleTimeoutMs", () => {
  it("keeps an idle connection two minutes through PgBouncer, where it holds no backend", () => {
    expect(POOLED_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(webPoolIdleTimeoutMs(pooled)).toBe(120_000);
    expect(webPoolIdleTimeoutMs("postgres://ava:secret@dpg-abc123-a/ava?port=6432")).toBe(120_000);
    expect(webPoolIdleTimeoutMs("postgres://ava:secret@ep-quiet-sun-123-pooler.eu-central-1.example.com/ava")).toBe(120_000);
  });

  it("keeps thirty seconds on the direct endpoint, where every idle connection is a backend", () => {
    expect(DIRECT_IDLE_TIMEOUT_MS).toBe(30_000);
    expect(webPoolIdleTimeoutMs(direct)).toBe(30_000);
    expect(webPoolIdleTimeoutMs("postgres://postgres:postgres@127.0.0.1:5432/ava")).toBe(30_000);
    expect(webPoolIdleTimeoutMs("not a url")).toBe(30_000);
  });
});

describe("db()", () => {
  const pool = { options: {}, on: vi.fn() };
  beforeEach(() => {
    vi.resetModules();
    createDb.mockReset().mockReturnValue({ db: { marker: "db" }, pool });
    attachDatabasePool.mockReset();
    vi.stubEnv("WEB_DB_POOL_MAX", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("opens one pool per instance through PgBouncer, two minutes idle, and hands it to Vercel", async () => {
    vi.stubEnv("DATABASE_URL", pooled);
    const { db } = await import("./db");
    expect(db()).toEqual({ marker: "db" });
    expect(db()).toBe(db());
    expect(createDb).toHaveBeenCalledTimes(1);
    expect(createDb).toHaveBeenCalledWith(pooled, {
      max: 6, idleTimeoutMillis: 120_000, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 30_000, reportRoundTrip: true, applicationName: "ava-web",
    });
    expect(attachDatabasePool).toHaveBeenCalledTimes(1);
    expect(attachDatabasePool).toHaveBeenCalledWith(pool);
  });

  it("keeps the direct endpoint's pool at three connections and thirty seconds idle", async () => {
    vi.stubEnv("DATABASE_URL", direct);
    const { db } = await import("./db");
    db();
    expect(createDb).toHaveBeenCalledWith(direct, expect.objectContaining({ max: 3, idleTimeoutMillis: 30_000 }));
    expect(attachDatabasePool).toHaveBeenCalledWith(pool);
  });
});
