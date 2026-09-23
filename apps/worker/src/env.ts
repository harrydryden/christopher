import v8 from "node:v8";
import { renamedEnv } from "@ava/core";
import { log } from "./log";

export interface WorkerEnv {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  contactEmail: string;
  port: number;
  concurrency: number;
  /** The ceiling of the database pool the worker opens: two connections per slot plus a margin (see createDeps). */
  databasePoolMax: number;
  scanSpreadMinutes?: number;
  browserConcurrency?: number;
  dailyAiBudgetUsd?: number;
  discoveryAiBudgetUsd?: number;
  chromiumExecutablePath: string | undefined;
  /** JSON map of hostname -> "host:port" (http) used to point scrapers at a local fake site in tests. */
  hostMap: Record<string, string>;
  disableBrowser: boolean;
  workerId: string;
}

/**
 * The worker's configuration, read once at boot (and by the CLI and the interface's cron fallback,
 * which run the same handlers). In production a missing contact address is refused rather than
 * defaulted: it goes in the user agent of every request to every careers site, and it is how a
 * site owner reaches the operator before blocking the crawler.
 */
export function readEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const production = env.NODE_ENV === "production";
  let hostMap: Record<string, string> = {};
  const hostMapJson = renamedEnv(env, "AVA_HOST_MAP", "CHRISTOPHER_HOST_MAP");
  if (hostMapJson) {
    try {
      hostMap = JSON.parse(hostMapJson) as Record<string, string>;
    } catch {
      throw new Error("AVA_HOST_MAP must be JSON");
    }
  }
  const concurrency = bounded(env.WORKER_CONCURRENCY, 3, 1, 30);
  const read: WorkerEnv = {
    databaseUrl,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    contactEmail: contactEmailFrom(env.SCRAPER_CONTACT_EMAIL, production),
    port: Number(env.PORT ?? 8080),
    concurrency,
    databasePoolMax: concurrency * 2 + 4,
    scanSpreadMinutes: bounded(env.SCAN_SPREAD_MINUTES, 60, 0, 720),
    browserConcurrency: bounded(env.BROWSER_CONCURRENCY, 1, 1, 8),
    dailyAiBudgetUsd: bounded(env.DAILY_AI_BUDGET_USD, 1000000, 0, 1000000),
    discoveryAiBudgetUsd: bounded(env.DISCOVERY_AI_BUDGET_USD, 1000000, 0, 1000000),
    chromiumExecutablePath: env.CHROMIUM_EXECUTABLE_PATH || undefined,
    hostMap,
    disableBrowser: renamedEnv(env, "AVA_DISABLE_BROWSER", "CHRISTOPHER_DISABLE_BROWSER") === "1",
    workerId: env.RENDER_INSTANCE_ID || env.HOSTNAME || `worker-${process.pid}`,
  };
  if (production) {
    // The figures that bound memory and connections, on the first line a deployment writes, so a
    // restart loop can be read against what the process was actually given.
    log.info("worker environment", {
      concurrency: read.concurrency,
      browserConcurrency: read.browserConcurrency,
      databasePoolMax: read.databasePoolMax,
      heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1_048_576),
      browser: !read.disableBrowser,
      ai: !!read.anthropicApiKey,
    });
    if (!env.ADMIN_EMAILS?.trim()) {
      log.warn("ADMIN_EMAILS is unset: the built-in default administrator address applies wherever this environment is used. Set it to the same list as the interface's.");
    }
  }
  return read;
}

/** Reserved for documentation and testing (RFC 2606, RFC 6761): nobody reads mail sent there. */
const PLACEHOLDER_DOMAIN = /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost|local)$/i;

function contactEmailFrom(value: string | undefined, production: boolean): string {
  const email = value?.trim();
  if (!production) return email || "unknown@example.com";
  const domain = email?.split("@")[1] ?? "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || PLACEHOLDER_DOMAIN.test(domain)) {
    throw new Error("SCRAPER_CONTACT_EMAIL must be a real address you read when NODE_ENV=production: it is sent in the user agent of every request so a site owner can reach you before blocking the crawler");
  }
  return email;
}

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid worker setting: expected ${min}–${max}`);
  return n;
}
