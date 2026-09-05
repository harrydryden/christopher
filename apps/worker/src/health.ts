import http from "node:http";
import { pendingTaskCounts } from "@christopher/db";
import type { WorkerDeps } from "./context";
import { log } from "./log";

export function startHealthServer(deps: WorkerDeps, port: number, extra: () => Record<string, unknown> = () => ({})): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/" || req.url === "/health") {
      try {
        const counts = await pendingTaskCounts(deps.db);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, workerId: deps.env.workerId, queue: counts, ...extra() }));
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
