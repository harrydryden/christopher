export interface WorkerEnv {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  contactEmail: string;
  port: number;
  concurrency: number;
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
    concurrency: Math.max(1, Number(env.WORKER_CONCURRENCY ?? 3)),
    chromiumExecutablePath: env.CHROMIUM_EXECUTABLE_PATH || undefined,
    hostMap,
    disableBrowser: env.CHRISTOPHER_DISABLE_BROWSER === "1",
    workerId: env.RENDER_INSTANCE_ID || env.HOSTNAME || `worker-${process.pid}`,
  };
}
