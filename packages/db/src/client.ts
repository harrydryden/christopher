import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

export interface CreateDbOptions {
  /** Max pool size. Keep small on serverless (2-3); the worker can use 5-10. */
  max?: number;
  /** "disable" | "require" (no CA verification, what Render external URLs need) | "verify". Defaults from DATABASE_SSL or host heuristics. */
  ssl?: "disable" | "require" | "verify";
}

function sslFor(connectionString: string, opt?: CreateDbOptions["ssl"]) {
  const mode = opt ?? (process.env.DATABASE_SSL as CreateDbOptions["ssl"] | undefined) ?? inferSsl(connectionString);
  if (mode === "disable") return undefined;
  if (mode === "verify") return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

function inferSsl(connectionString: string): NonNullable<CreateDbOptions["ssl"]> {
  try {
    const host = new URL(connectionString).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".internal")) return "disable";
  } catch {
    /* fall through */
  }
  return "require";
}

/**
 * Process-wide counts the worker reports as vitals. A pool with connections waiting and a rising
 * slow-query count is the shape of "the database is the bottleneck", and neither is visible from
 * the outside: `pg` keeps its own queue, and a slow query is only a log line nothing adds up.
 */
let slowQueries = 0;
const livePools = new Set<pg.Pool>();

/** How many queries this process has seen take longer than the slow threshold. */
export function slowQueryCount(): number {
  return slowQueries;
}

/** Connections across every pool this process still holds open, or null when it holds none. */
export function poolStats(): { total: number; idle: number; waiting: number } | null {
  if (livePools.size === 0) return null;
  let total = 0, idle = 0, waiting = 0;
  for (const pool of livePools) {
    total += pool.totalCount;
    idle += pool.idleCount;
    waiting += pool.waitingCount;
  }
  return { total, idle, waiting };
}

export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 5,
    ssl: sslFor(connectionString, options.ssl),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // A serverless instance reuses its pool between requests; without keepalive
    // an idle TLS connection is silently dropped and the next query pays the
    // handshake again.
    keepAlive: true,
  });
  pool.on("connect", client => {
    const original = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const started = performance.now();
      let reported = false;
      const finish = () => {
        if (reported) return;
        reported = true;
        const durationMs = Math.round(performance.now() - started);
        if (durationMs >= 250) {
          slowQueries += 1;
          console.info(JSON.stringify({ event: "slow_database_query", durationMs }));
        }
      };
      const callback = args[args.length - 1];
      if (typeof callback === "function") args[args.length - 1] = (...values: unknown[]) => { finish(); return callback(...values); };
      try {
        const result = Reflect.apply(original, client, args);
        return result && typeof result.finally === "function" ? result.finally(finish) : result;
      } catch (error) { finish(); throw error; }
    }) as typeof client.query;
  });
  livePools.add(pool);
  // A pool that has been ended must stop counting towards the process's connection figures.
  const end = pool.end.bind(pool);
  pool.end = ((...args: Parameters<typeof end>) => {
    livePools.delete(pool);
    return end(...args);
  }) as typeof pool.end;
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool };
}

/** Process-wide singleton for the web app (serverless friendly). */
let shared: ReturnType<typeof createDb> | null = null;
export function getDb(options: CreateDbOptions = {}) {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    shared = createDb(url, options);
  }
  return shared.db;
}
