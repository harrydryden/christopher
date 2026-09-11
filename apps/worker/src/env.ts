export interface WorkerEnv {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  contactEmail: string;
  port: number;
  concurrency: number;
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

export function readEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  let hostMap: Record<string, string> = {};
  if (env.CHRISTOPHER_HOST_MAP) {
    try {
      hostMap = JSON.parse(env.CHRISTOPHER_HOST_MAP) as Record<string, string>;
    } catch {
      throw new Error("CHRISTOPHER_HOST_MAP must be JSON");
    }
  }
  return {
    databaseUrl,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    contactEmail: env.SCRAPER_CONTACT_EMAIL || "unknown@example.com",
    port: Number(env.PORT ?? 8080),
    concurrency: bounded(env.WORKER_CONCURRENCY, 3, 1, 30),
    scanSpreadMinutes: bounded(env.SCAN_SPREAD_MINUTES, 60, 0, 720),
    browserConcurrency: bounded(env.BROWSER_CONCURRENCY, 1, 1, 8),
    dailyAiBudgetUsd: bounded(env.DAILY_AI_BUDGET_USD, 1000000, 0, 1000000),
    discoveryAiBudgetUsd: bounded(env.DISCOVERY_AI_BUDGET_USD, 1000000, 0, 1000000),
    chromiumExecutablePath: env.CHROMIUM_EXECUTABLE_PATH || undefined,
    hostMap,
    disableBrowser: env.CHRISTOPHER_DISABLE_BROWSER === "1",
    workerId: env.RENDER_INSTANCE_ID || env.HOSTNAME || `worker-${process.pid}`,
  };
}

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid worker setting: expected ${min}–${max}`);
  return n;
}
