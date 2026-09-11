import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@christopher/db";
import type { WorkerDeps } from "./context";
import { log } from "./log";

export class LeaseBusyError extends Error {}

/** Short renewable database lease, with a fencing check in every result transaction. */
export async function withResourceLease<T>(deps: WorkerDeps, key: string, work: (deps: WorkerDeps) => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const claimed = await deps.db.execute(sql`insert into resource_leases (key, owner, expires_at)
    values (${key}, ${owner}, now() + interval '5 minutes')
    on conflict (key) do update set owner = excluded.owner, expires_at = excluded.expires_at
    where resource_leases.expires_at < now() returning key`);
  if (!claimed.rows.length) throw new LeaseBusyError(`Operation already running: ${key}`);
  let renewal: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (renewal) return;
    renewal = deps.db.execute(sql`update resource_leases set expires_at = now() + interval '5 minutes' where key = ${key} and owner = ${owner}`)
      .catch(error => log.warn("operation lease renewal failed", error)).finally(() => { renewal = undefined; });
  }, 30_000);
  timer.unref();
  try {
    return await work({ ...deps, assertOwnership: async (db: Db) => {
      await deps.assertOwnership?.(db);
      const rows = await db.execute(sql`select key from resource_leases where key = ${key} and owner = ${owner} and expires_at > now() for update`);
      if (!rows.rows.length) throw new Error("Operation lease lost; refusing stale writes");
    } });
  } finally {
    clearInterval(timer);
    await renewal;
    await deps.db.execute(sql`delete from resource_leases where key = ${key} and owner = ${owner}`);
  }
}
