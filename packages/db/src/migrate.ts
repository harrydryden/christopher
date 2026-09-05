import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Db } from "./client";

const LOCK_KEY = 74_233_101; // arbitrary advisory lock id shared by all processes

export async function runMigrations(db: Db) {
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  await db.execute(sql`select pg_advisory_lock(${LOCK_KEY})`);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`);
  }
}
