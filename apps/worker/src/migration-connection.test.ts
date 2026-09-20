import { expect, it, vi } from "vitest";
import { createDb } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";

it.each([
  "postgres://operator:private-test-value@dpg-example-a:6432/christopher",
  "postgres://operator:private-test-value@dpg-example-a.frankfurt-postgres.render.com:6432/christopher",
  "postgres://operator:private-test-value@dpg-example-a.frankfurt-postgres.render.com:5432/christopher?port=6432",
])("rejects a Render transaction-pool migration before opening a connection (%#)", async url => {
  const { db, pool } = createDb(url);
  const connect = vi.spyOn(pool, "connect");
  try {
    await expect(runMigrations(db)).rejects.toThrow("direct database URL on port 5432");
    await expect(runMigrations(db)).rejects.not.toThrow("private-test-value");
    expect(connect).not.toHaveBeenCalled();
  } finally {
    await pool.end();
  }
});
