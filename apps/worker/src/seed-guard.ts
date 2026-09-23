/**
 * Where `pnpm seed:demo` may write. It truncates every account and the whole catalogue before it
 * seeds, so a shell or `.env` still pointing at production would lose everything in one command.
 * It therefore runs only against a database on this machine, or against one whose name the operator
 * has typed out in `SEED_DEMO_DATABASE`, the same way the drills insist on their own databases.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export interface SeedTarget {
  host: string;
  port: string;
  database: string;
}

export function seedDemoTarget(url: string, env: NodeJS.ProcessEnv = process.env): SeedTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("DATABASE_URL is not a valid PostgreSQL URL");
  // The connection goes where `pg` sends it, not where the URL's authority appears to point: a
  // `?host=` parameter overrides the authority, and an empty authority falls back to PGHOST.
  const host = (parsed.searchParams.get("host") || parsed.hostname.replace(/^\[|\]$/g, "") || env.PGHOST || "localhost").toLowerCase();
  const port = parsed.searchParams.get("port") || parsed.port || env.PGPORT || "5432";
  const database = decodeURIComponent(parsed.pathname.slice(1)) || env.PGDATABASE || "";
  const target = { host, port, database };
  const local = LOCAL_HOSTS.has(host) || host.startsWith("/");
  const named = env.SEED_DEMO_DATABASE?.trim();
  if (local || (named && database && named === database)) return target;
  throw new Error(
    `seed:demo deletes every account, company and role before it seeds; refusing ${describeSeedTarget(target)}. ` +
      `Point DATABASE_URL at a local database, or set SEED_DEMO_DATABASE=${database || "<database name>"} to confirm this one.`,
  );
}

/** The target without credentials, for the line printed before anything is truncated. */
export function describeSeedTarget(target: SeedTarget): string {
  return `database "${target.database}" on ${target.host}:${target.port}`;
}
