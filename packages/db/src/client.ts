import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

export interface CreateDbOptions {
  /** Max pool size. Keep small on serverless (2-3); the worker can use 5-10. */
  max?: number;
  /** "disable" | "require" (no CA verification, what Render external URLs need) | "verify". Defaults from DATABASE_SSL or host heuristics. */
  ssl?: "disable" | "require" | "verify";
  /**
   * The server's ceiling on any one statement, in milliseconds; 0 for none. Defaults to
   * DATABASE_STATEMENT_TIMEOUT_MS, else five minutes, which is above the worker's longest
   * legitimate statement. The interface should pass 30 seconds: a function the platform has
   * already killed otherwise leaves its query running, and its locks held, until it finishes.
   */
  statementTimeoutMs?: number;
  /** How long a session may sit idle inside an open transaction before the server ends it; 0 for never. Defaults to a minute. */
  idleInTransactionTimeoutMs?: number;
  /** Where a slow query is reported. Defaults to an `info` line on stdout; the worker can route it through its own log, which knows the task. */
  onSlowQuery?: (query: SlowQuery) => void;
}

/** A statement that took `SLOW_QUERY_MS` or longer, identified by the start of its text (parameters are never part of it). */
export interface SlowQuery {
  durationMs: number;
  statement: string | null;
}

const SLOW_QUERY_MS = 250;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Which of a Render database's two endpoints a connection string names: `pooled` is PgBouncer on
 * port 6432, which pools by transaction, in the address or as a `port` parameter; `direct` is
 * anything else on a Render database host; null is not Render at all. Parsed without logging
 * anything, because the string carries the password.
 */
export function renderEndpoint(connectionString: string): "pooled" | "direct" | null {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  if (!url.hostname.startsWith("dpg-") && !url.hostname.endsWith(".render.com")) return null;
  return (url.searchParams.get("port") ?? url.port) === "6432" ? "pooled" : "direct";
}

export function isRenderPooledUrl(connectionString: string): boolean {
  return renderEndpoint(connectionString) === "pooled";
}

let warnedDirectEndpoint = false;

/**
 * The interface belongs on Render's pooled endpoint: every warm serverless instance keeps its own
 * pool, and about thirty of them on the direct endpoint exhaust the database's backends for every
 * account at once. Nothing else would notice a deployment configured the other way until then, so
 * a Vercel process that opens a pool on the direct endpoint says so, once.
 */
function warnOnDirectServerlessEndpoint(connectionString: string): void {
  if (warnedDirectEndpoint || !process.env.VERCEL || renderEndpoint(connectionString) !== "direct") return;
  warnedDirectEndpoint = true;
  logLine("warn", "database_direct_endpoint", { hint: "Point this deployment's DATABASE_URL at Render's pooled URL on port 6432; see docs/DEPLOY.md." });
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

type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * One JSON line from this package, at the same thresholds as the worker's log: nothing below
 * `LOG_LEVEL` (default `info`) is written, and warnings and errors go to stderr.
 */
export function logLine(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const threshold = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LOG_LEVELS.info;
  if (LOG_LEVELS[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  if (level === "warn" || level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

/**
 * Process-wide counts the worker reports as vitals. A pool with connections waiting and a rising
 * slow-query count is the shape of "the database is the bottleneck", and neither is visible from
 * the outside: `pg` keeps its own queue, and a slow query is only a log line nothing adds up.
 */
let slowQueries = 0;
let connectionErrors = 0;
const livePools = new Set<pg.Pool>();

/** How many queries this process has seen take longer than the slow threshold. */
export function slowQueryCount(): number {
  return slowQueries;
}

/** How many connection errors this process's pools have absorbed: dropped idle connections, terminated backends. */
export function poolErrorCount(): number {
  return connectionErrors;
}

/** Connections across every pool this process still holds open, or null when it holds none. */
export function poolStats(): { total: number; idle: number; waiting: number; errors: number } | null {
  if (livePools.size === 0) return null;
  let total = 0, idle = 0, waiting = 0;
  for (const pool of livePools) {
    total += pool.totalCount;
    idle += pool.idleCount;
    waiting += pool.waitingCount;
  }
  return { total, idle, waiting, errors: connectionErrors };
}

const failedConnections = new WeakSet<object>();

/**
 * A connection that fails is dropped by the pool, and the next query opens a new one. The error
 * still has to be listened for: `pg` emits it on the pool when the connection was idle and on the
 * client when it was checked out, and an `error` event that nothing listens to throws, which ends
 * the process — every request a serverless instance is serving, or every task the worker is
 * running. Idle connections are dropped routinely (a pooler's idle timeout, a failover, a reset
 * keepalive socket, a server-side timeout), so this is the ordinary case. One dying connection can
 * raise several errors by both routes (the server's goodbye, then the closed socket); it is
 * counted and logged once.
 */
function absorbConnectionError(error: unknown, connection: object): void {
  if (failedConnections.has(connection)) return;
  failedConnections.add(connection);
  connectionErrors += 1;
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
  logLine("warn", "database_pool_error", { message: typeof message === "string" ? message : String(error), ...(typeof code === "string" ? { code } : {}) });
}

/** The first 120 characters of a query's text, whitespace collapsed; the text never carries the parameters. */
function statementOf(args: unknown[]): string | null {
  const first = args[0];
  const text = typeof first === "string" ? first
    : first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string" ? (first as { text: string }).text
    : null;
  return text === null ? null : text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * The server-side time limits a pool's connections start with. They travel as startup parameters,
 * which a transaction pooler refuses ("unsupported startup parameter"), so on Render's PgBouncer
 * endpoint none are sent and the limits come from the database role instead (docs/DEPLOY.md).
 */
export function serverTimeouts(connectionString: string, options: Pick<CreateDbOptions, "statementTimeoutMs" | "idleInTransactionTimeoutMs"> = {}) {
  if (isRenderPooledUrl(connectionString)) return {};
  const fromEnv = Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS);
  const statement = options.statementTimeoutMs ?? (process.env.DATABASE_STATEMENT_TIMEOUT_MS && Number.isFinite(fromEnv) ? fromEnv : DEFAULT_STATEMENT_TIMEOUT_MS);
  const idle = options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS;
  return {
    ...(statement > 0 ? { statement_timeout: statement } : {}),
    ...(idle > 0 ? { idle_in_transaction_session_timeout: idle } : {}),
  };
}

export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  warnOnDirectServerlessEndpoint(connectionString);
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
    ...serverTimeouts(connectionString, options),
  });
  const reportSlow = options.onSlowQuery ?? ((query: SlowQuery) => logLine("info", "slow_database_query", { ...query }));
  pool.on("error", (error, client) => absorbConnectionError(error, client));
  pool.on("connect", client => {
    client.on("error", error => absorbConnectionError(error, client));
    const original = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const started = performance.now();
      let reported = false;
      const finish = () => {
        if (reported) return;
        reported = true;
        const durationMs = Math.round(performance.now() - started);
        if (durationMs >= SLOW_QUERY_MS) {
          slowQueries += 1;
          try {
            reportSlow({ durationMs, statement: statementOf(args) });
          } catch {
            // A report must never fail the query it describes.
          }
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
