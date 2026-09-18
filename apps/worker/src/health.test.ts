/** `/healthz`: one reading of the database serves every caller for a few seconds. */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createDb, enqueueTask, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { startHealthServer } from "./health";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";

let deps: WorkerDeps;
let db: Db;

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { settingsTtlMs: 0 });
  db = deps.db;
}, 60_000);

afterAll(async () => { await deps?.close(); });
beforeEach(async () => { await db.execute(sql`truncate tasks restart identity cascade`); });

async function serve<T>(work: (url: string) => Promise<T>): Promise<T> {
  const server = startHealthServer(deps, 0, () => ({ active: 0 }));
  await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try { return await work(`http://127.0.0.1:${port}/healthz`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

it("answers with the queue and workload in one reading, and reuses it for a few seconds", async () => {
  await enqueueTask(db, "discover", { companyId: "a" });
  await serve(async url => {
    const first = await (await fetch(url)).json() as { ok: boolean; metrics: Record<string, number>; queue: unknown };
    expect(first.ok).toBe(true);
    expect(first.metrics.ready).toBe(1);
    expect(first.metrics).toMatchObject({ running: 0, overdueCompanies: 0, overdueDiscovery: 0, reservedUsd: 0 });
    expect(first.queue).toBeTruthy();

    // Concurrent and immediately repeated polls are answered from the cached reading rather than
    // running the aggregates again — the new task is not visible yet.
    await enqueueTask(db, "discover", { companyId: "b" });
    const again = await Promise.all([fetch(url), fetch(url)].map(async r => (await (await r).json()) as { metrics: Record<string, number> }));
    expect(again.map(r => r.metrics.ready)).toEqual([1, 1]);
  });

  // A fresh server has no cache, so the second task shows at once.
  await serve(async url => {
    const fresh = await (await fetch(url)).json() as { metrics: Record<string, number> };
    expect(fresh.metrics.ready).toBe(2);
  });
});
