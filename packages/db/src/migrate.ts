import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { fileURLToPath } from "node:url";
import type { Db } from "./client";

const LOCK_KEY = 74_233_101; // arbitrary advisory lock id shared by all processes

export async function runMigrations(db: Db) {
  // Render's managed PgBouncer endpoint uses transaction pooling. A session advisory lock
  // could be acquired and released on different backends there, so migrations must use the
  // direct endpoint. Check before opening a connection, without logging the credential URL.
  const connectionString = db.$client.options.connectionString;
  if (connectionString) {
    const url = new URL(connectionString);
    const port = url.searchParams.get("port") ?? url.port;
    if ((url.hostname.startsWith("dpg-") || url.hostname.endsWith(".render.com")) && port === "6432") {
      throw new Error("Migrations require Render's direct database URL on port 5432, not its transaction-pooled URL on port 6432. Keep the worker and migration runner on the direct endpoint.");
    }
  }
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  const client = await db.$client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
