/**
 * A fake internet for integration tests: one HTTP server that answers for several hostnames.
 * The worker reaches it through CHRISTOPHER_HOST_MAP, so production code paths run unchanged.
 */
import http from "node:http";

export interface Route {
  status?: number;
  body: string | object;
  contentType?: string;
}

export type RouteTable = Record<string, Record<string, Route | ((req: http.IncomingMessage, body: string) => Route)>>;

export interface TestServer {
  port: number;
  hostMap: Record<string, string>;
  requests: Array<{ host: string; url: string; method: string }>;
  setRoutes(routes: RouteTable): void;
  close(): Promise<void>;
}

export async function startTestServer(routes: RouteTable, hosts: string[]): Promise<TestServer> {
  let table = routes;
  const requests: Array<{ host: string; url: string; method: string }> = [];

  const server = http.createServer((req, res) => {
    const host = (req.headers["x-forwarded-host"] as string | undefined) ?? (req.headers.host ?? "").split(":")[0] ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "/";
      requests.push({ host, url, method: req.method ?? "GET" });
      const forHost = table[host];
      const entry = forHost?.[url] ?? forHost?.[url.split("?")[0] ?? url];
      if (!entry) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html><head><title>Not found</title></head><body>404</body></html>");
        return;
      }
      const route = typeof entry === "function" ? entry(req, body) : entry;
      const payload = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
      res.writeHead(route.status ?? 200, { "content-type": route.contentType ?? (typeof route.body === "string" ? "text/html" : "application/json") });
      res.end(payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const hostMap: Record<string, string> = {};
  for (const host of hosts) hostMap[host] = `127.0.0.1:${port}`;

  return {
    port,
    hostMap,
    requests,
    setRoutes(next) {
      table = next;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
