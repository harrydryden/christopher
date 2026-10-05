/** `seed:demo` truncates everything, so it must refuse any database that is not plainly a local one. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeSeedTarget, seedDemoTarget } from "./seed-guard";

describe("seedDemoTarget", () => {
  it.each([
    "postgres://postgres:postgres@127.0.0.1:5432/col_dev",
    "postgres://postgres@localhost/col_dev",
    "postgresql://postgres@[::1]:5433/anything",
    "postgres:///col_dev?host=/var/run/postgresql",
    "postgres:///col_dev",
  ])("accepts a database on this machine (%s)", url => {
    expect(() => seedDemoTarget(url, {})).not.toThrow();
  });

  it.each([
    "postgres://col:secret-value@dpg-d0example-a.frankfurt-postgres.render.com/col",
    "postgres://col:secret-value@dpg-d0example-a/col",
    "postgres://col:secret-value@10.0.0.5:5432/col_dev",
    // The authority says localhost, but pg connects to the host parameter.
    "postgres://col:secret-value@localhost/col?host=db.production.example",
  ])("refuses a remote database without naming the credentials (%s)", url => {
    expect(() => seedDemoTarget(url, {})).toThrow(/refusing database "col(_dev)?" on/);
    expect(() => seedDemoTarget(url, {})).not.toThrow(/secret-value/);
  });

  it("refuses an empty authority when PGHOST points elsewhere", () => {
    expect(() => seedDemoTarget("postgres:///col", { PGHOST: "db.production.example" })).toThrow(/refusing/);
  });

  it("accepts a remote database only when SEED_DEMO_DATABASE names it exactly", () => {
    const url = "postgres://col:secret-value@dpg-d0example-a.frankfurt-postgres.render.com:5432/col_staging";
    expect(seedDemoTarget(url, { SEED_DEMO_DATABASE: "col_staging" })).toEqual({ host: "dpg-d0example-a.frankfurt-postgres.render.com", port: "5432", database: "col_staging" });
    expect(() => seedDemoTarget(url, { SEED_DEMO_DATABASE: "col" })).toThrow(/SEED_DEMO_DATABASE=col_staging/);
    expect(() => seedDemoTarget(url, { SEED_DEMO_DATABASE: "" })).toThrow(/refusing/);
  });

  it("rejects something that is not a PostgreSQL URL", () => {
    expect(() => seedDemoTarget("not a url", {})).toThrow(/not a valid PostgreSQL URL/);
    expect(() => seedDemoTarget("https://127.0.0.1/col_dev", {})).toThrow(/not a valid PostgreSQL URL/);
  });

  it("describes the target without credentials", () => {
    expect(describeSeedTarget(seedDemoTarget("postgres://postgres:hunter2@127.0.0.1:5432/col_dev", {}))).toBe('database "col_dev" on 127.0.0.1:5432');
  });
});

it("stops the seed script before it connects to a remote database", () => {
  // Port 1 on a reserved address: if the guard let this through, the script would try to connect
  // and fail with a connection error instead of the refusal.
  const script = fileURLToPath(new URL("./seed-demo.ts", import.meta.url));
  const run = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: "postgres://col:secret-value@192.0.2.1:1/col", SEED_DEMO_DATABASE: "" },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/refusing database "col" on 192\.0\.2\.1:1/);
  expect(run.stderr).not.toMatch(/secret-value|ECONNREFUSED|ETIMEDOUT/);
});
