/**
 * Own connection helper rather than `getDb()` from `@christopher/db` (the package root).
 * That barrel re-exports `runMigrations`, which uses `new URL("../drizzle", import.meta.url)`
 * to locate the migrations folder — Next's webpack build tries to statically resolve that as
 * an asset and fails ("Module not found: Can't resolve '../drizzle'"), even though this app
 * never calls it (migrations run from the worker). Importing only the `schema` subpath and
 * building the client here avoids pulling that module into the web app's bundle at all.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@christopher/db/schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

type SslMode = "disable" | "require" | "verify";

function inferSsl(connectionString: string): SslMode {
  try {
    const host = new URL(connectionString).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".internal")) return "disable";
  } catch {
    /* fall through */
  }
  return "require";
}

function sslFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  const mode = (process.env.DATABASE_SSL as SslMode | undefined) ?? inferSsl(connectionString);
  if (mode === "disable") return undefined;
  if (mode === "verify") return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

let cached: Db | null = null;

/** Process-wide singleton pool (serverless-friendly: at most 3 connections per function). */
export function db(): Db {
  if (!cached) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    const pool = new pg.Pool({
      connectionString,
      max: 3,
      ssl: sslFor(connectionString),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    cached = drizzle(pool, { schema, casing: "snake_case" });
  }
  return cached;
}
