import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { fileURLToPath } from "node:url";
import type { Db } from "./client";

const LOCK_KEY = 74_233_101; // arbitrary advisory lock id shared by all processes

export async function runMigrations(db: Db) {
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
