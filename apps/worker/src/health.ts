import http from "node:http";
import { pendingTaskCounts, workloadMetrics } from "@christopher/db";
import type { WorkerDeps } from "./context";
import { log } from "./log";

/** How long one reading of the queue and workload serves every caller. */
export const HEALTH_CACHE_MS = 5000;

export function startHealthServer(deps: WorkerDeps, port: number, extra: () => Record<string, unknown> = () => ({})): http.Server {
  // Render polls this route, the Health panel polls it, and so does anyone watching a deploy. The
  // database part of the answer is worth one reading every few seconds: recomputing it per request
  // put the heaviest aggregates in the process on whatever polls hardest. In-process memory is the
  // right place for it — each worker answers for itself. The live fields below stay per request.
  let cached: { at: number; value: { queue: unknown; metrics: unknown } } | null = null;
  let inFlight: Promise<{ queue: unknown; metrics: unknown }> | null = null;
  const readState = async () => {
    if (cached && Date.now() - cached.at < HEALTH_CACHE_MS) return cached.value;
    inFlight ??= (async () => {
      try {
        const [queue, metrics] = await Promise.all([pendingTaskCounts(deps.db), workloadMetrics(deps.db)]);
        const value = { queue, metrics };
        cached = { at: Date.now(), value };
        return value;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const server = http.createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/" || req.url === "/health") {
      try {
        const { queue, metrics } = await readState();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, workerId: deps.env.workerId, queue, metrics, memory: process.memoryUsage(), ...extra() }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => log.info("health server listening", { port }));
  return server;
}
