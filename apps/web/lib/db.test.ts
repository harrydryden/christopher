/** The interface pool's width: 3 on the direct endpoint, 6 through PgBouncer, and an override. */
import { describe, expect, it } from "vitest";
import { DIRECT_POOL_MAX, POOLED_POOL_MAX, webPoolMax } from "./db";

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
